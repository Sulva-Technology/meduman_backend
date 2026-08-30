import { Injectable, Logger } from '@nestjs/common';
import {
  ActorType,
  DisputeReason,
  DisputeStatus,
  OtpPurpose,
  TransactionStatus,
  type ChatIdentity,
  type ChatSession,
  type User,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { TransitionRejectedError } from '@/modules/transactions/transition-rejected.error';
import { PaymentsService } from '@/modules/payments/payments.service';
import { OtpService } from '@/modules/otp/otp.service';
import { OtpVerificationError, OtpNotIssuableError } from '@/modules/otp/otp.errors';
import { SellerProfileService } from '@/modules/users/seller-profile.service';
import { DisputesService } from '@/modules/disputes/disputes.service';
import { QueueService } from '@/modules/queue/queue.service';
import { ChatSessionService } from '../session/chat-session.service';
import type {
  ChatAdapter,
  InboundChatMessage,
  OutboundChatMessage,
} from '../adapters/chat-adapter';
import { ChatEvidenceService, UnsupportedMediaError } from '../evidence/chat-evidence.service';
import { ChatStep, type ChatDraft } from './dialog.types';

/** Dispute statuses in which fresh evidence is still worth accepting. */
const OPEN_DISPUTE_STATUSES = [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] as const;

const HELP = [
  'Meduman — protected payments, right here in chat.',
  '',
  'Seller:',
  '  /sell — create a protected transaction',
  '  /setup_payout — set where released funds land',
  '  /delivered — mark the current transaction delivered',
  '',
  'Buyer:',
  '  /pay <code> — pay for a transaction by its link code',
  '',
  '  /dispute <reason> — open a dispute on your current transaction',
  '  /status — show your current transaction',
  '  /cancel — abandon the current step',
].join('\n');

/**
 * The conversational step machine. It NEVER writes TransactionStatus — every
 * money/state change goes through the existing services (TransactionsService,
 * PaymentsService, OtpService), so the state machine stays the sole owner of
 * transaction state (rule 1) and a chat message is never a trusted payment
 * source (rule 2). This service only decides the next prompt and persists the
 * conversational draft.
 */
@Injectable()
export class ChatDialogService {
  private readonly logger = new Logger(ChatDialogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: ChatSessionService,
    private readonly transactions: TransactionsService,
    private readonly payments: PaymentsService,
    private readonly otp: OtpService,
    private readonly sellers: SellerProfileService,
    private readonly disputes: DisputesService,
    private readonly queue: QueueService,
    private readonly evidence: ChatEvidenceService,
  ) {}

  async handle(
    identity: ChatIdentity,
    user: User,
    session: ChatSession,
    message: InboundChatMessage,
    adapter?: ChatAdapter,
  ): Promise<OutboundChatMessage> {
    const text = (message.payload ?? message.text ?? '').trim();

    // A photo/document with no command attached is dispute evidence. A caption
    // that is a command (starts with '/') still runs as a command.
    if (message.media?.length && !text.startsWith('/')) {
      return this.handleMedia(identity, user, session, message, adapter);
    }

    if (text.startsWith('/')) {
      return this.handleCommand(identity, user, session, text);
    }
    return this.handleStep(identity, user, session, text);
  }

  // --- Commands ------------------------------------------------------------

  private async handleCommand(
    identity: ChatIdentity,
    user: User,
    session: ChatSession,
    text: string,
  ): Promise<OutboundChatMessage> {
    const [command, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (command) {
      case '/start':
      case '/help':
        return { text: HELP };
      case '/cancel':
        await this.sessions.reset(identity.id);
        return { text: 'Cancelled. Send /help to see what you can do.' };
      case '/sell':
        await this.sessions.update(identity.id, { step: ChatStep.SELLER_TX_TITLE, draft: {} });
        return {
          text: "Let's create a protected transaction. What are you selling? (a short title)",
        };
      case '/setup_payout':
        await this.sessions.update(identity.id, { step: ChatStep.SELLER_PAYOUT_ACCOUNT });
        return {
          text: 'Where should released funds land? Reply with your bank code and account number, e.g.\n\n058 0123456789',
        };
      case '/pay':
        return this.startPayment(identity, user, arg);
      case '/delivered':
        return this.markDelivered(user, session, arg);
      case '/dispute':
        return this.raiseDispute(user, session, arg);
      case '/status':
        return this.showStatus(user, session, arg);
      default:
        return { text: 'Unknown command. Send /help.' };
    }
  }

  // --- Step handlers -------------------------------------------------------

  private async handleStep(
    identity: ChatIdentity,
    user: User,
    session: ChatSession,
    text: string,
  ): Promise<OutboundChatMessage> {
    switch (session.step as ChatStep) {
      case ChatStep.SELLER_TX_TITLE:
        return this.captureTitle(identity, session, text);
      case ChatStep.SELLER_TX_AMOUNT:
        return this.captureAmount(identity, session, text);
      case ChatStep.SELLER_TX_DESCRIPTION:
        return this.captureDescriptionAndCreate(identity, user, session, text);
      case ChatStep.SELLER_PAYOUT_ACCOUNT:
        return this.capturePayoutAccount(identity, user, text);
      case ChatStep.DISPUTE_EVIDENCE:
        // Any text (typically "done"/"skip") ends the evidence-collection step.
        await this.sessions.update(identity.id, { step: ChatStep.IDLE });
        return {
          text: 'Thanks — your evidence is attached to the dispute. Our team will review it.',
        };
      case ChatStep.IDLE:
      default:
        // A bare numeric string from a buyer awaiting confirmation is an OTP.
        if (/^\d{4,10}$/.test(text)) {
          return this.tryConfirmOtp(user, text);
        }
        return { text: 'Send /help to see what you can do.' };
    }
  }

  private async captureTitle(
    identity: ChatIdentity,
    session: ChatSession,
    text: string,
  ): Promise<OutboundChatMessage> {
    if (!text) return { text: 'Please send a short title for what you are selling.' };
    const draft: ChatDraft = { ...this.sessions.readDraft(session), title: text.slice(0, 120) };
    await this.sessions.update(identity.id, { step: ChatStep.SELLER_TX_AMOUNT, draft });
    return { text: `Got it: "${draft.title}". What is the price in Naira? (e.g. 5000)` };
  }

  private async captureAmount(
    identity: ChatIdentity,
    session: ChatSession,
    text: string,
  ): Promise<OutboundChatMessage> {
    const kobo = parseNairaToKobo(text);
    if (kobo === null || kobo <= 0) {
      return {
        text: 'That does not look like a valid amount. Send the price in Naira, e.g. 5000.',
      };
    }
    const draft: ChatDraft = { ...this.sessions.readDraft(session), amountKobo: kobo };
    await this.sessions.update(identity.id, { step: ChatStep.SELLER_TX_DESCRIPTION, draft });
    return {
      text: `Price set to ₦${formatNaira(kobo)}. Add a short description, or reply "skip".`,
    };
  }

  private async captureDescriptionAndCreate(
    identity: ChatIdentity,
    user: User,
    session: ChatSession,
    text: string,
  ): Promise<OutboundChatMessage> {
    const draft = this.sessions.readDraft(session);
    if (!draft.title || !draft.amountKobo) {
      await this.sessions.reset(identity.id);
      return { text: 'Something went wrong building that transaction. Start again with /sell.' };
    }
    const description = /^skip$/i.test(text) ? undefined : text.slice(0, 500);

    const tx = await this.transactions.createDraft({
      sellerId: user.id,
      title: draft.title,
      amount: draft.amountKobo,
      ...(description ? { description } : {}),
    });
    // Publish immediately so a buyer can pay the link.
    await this.transactions.apply({
      transactionId: tx.id,
      event: { type: 'SELLER_PUBLISH' },
      actor: { id: user.id, type: ActorType.USER, role: 'SELLER' },
    });

    await this.sessions.update(identity.id, {
      step: ChatStep.IDLE,
      draft: null,
      transactionId: tx.id,
    });

    const seller = await this.sellers.getOrCreate(user.id);
    const payoutHint = seller.providerRecipientCode
      ? ''
      : '\n\n⚠️ You have not set a payout destination yet. Run /setup_payout so released funds can reach you.';

    return {
      text: [
        `✅ Transaction created: "${tx.title}" — ₦${formatNaira(tx.amount)}.`,
        '',
        'Share this code with your buyer. They pay in their own Meduman chat with:',
        `  /pay ${tx.publicLinkId}`,
        payoutHint,
      ].join('\n'),
    };
  }

  private async capturePayoutAccount(
    identity: ChatIdentity,
    user: User,
    text: string,
  ): Promise<OutboundChatMessage> {
    const parts = text.split(/\s+/);
    const bankCode = parts[0];
    const accountNumber = parts[1];
    if (!bankCode || !accountNumber) {
      return { text: 'Reply with bank code then account number, e.g.\n\n058 0123456789' };
    }
    // Return to IDLE but KEEP the seller's active transaction. A full reset would
    // strand a seller who runs /setup_payout after creating a transaction (the
    // exact ordering the "no payout destination" warning nudges): chat only ever
    // exposes the publicLinkId, never the internal id, so a wiped session leaves
    // them unable to /delivered their own transaction.
    try {
      const profile = await this.sellers.createTransferRecipient(user.id, {
        bankCode,
        accountNumber,
      });
      await this.sessions.update(identity.id, { step: ChatStep.IDLE });
      return {
        text: `✅ Payout destination saved: ${profile.settlementAccountName} (…${profile.settlementAccountLast4}). Released funds will be sent here.`,
      };
    } catch (err) {
      this.logger.warn(`Payout setup failed for ${user.id}: ${(err as Error).message}`);
      await this.sessions.update(identity.id, { step: ChatStep.IDLE });
      return {
        text: 'Could not verify that account. Check the bank code and account number, then try /setup_payout again.',
      };
    }
  }

  // --- Buyer / seller actions ---------------------------------------------

  private async startPayment(
    identity: ChatIdentity,
    user: User,
    linkCode: string,
  ): Promise<OutboundChatMessage> {
    if (!linkCode) return { text: 'Send the transaction code, e.g. /pay abc123...' };

    const tx = await this.prisma.transaction.findUnique({ where: { publicLinkId: linkCode } });
    if (!tx) return { text: 'No transaction found for that code. Check it and try again.' };
    if (tx.sellerId === user.id) {
      return { text: 'You are the seller on this transaction — a buyer pays it, not you.' };
    }

    try {
      const account = await this.payments.initializeVirtualAccount({
        transactionId: tx.id,
        buyerId: user.id,
        email: user.email,
      });
      await this.sessions.update(identity.id, { transactionId: tx.id });

      if (account.accountNumber) {
        return {
          text: [
            `To pay for "${tx.title}" (₦${formatNaira(tx.amount)}), transfer the EXACT amount from your bank app to:`,
            '',
            `  Account: ${account.accountNumber}`,
            `  Bank: ${account.bankName}`,
            '',
            'Your money is held safely and only released to the seller once you confirm delivery.',
          ].join('\n'),
        };
      }
      return {
        text: `Setting up a payment account for "${tx.title}". You'll get the account number here in a moment.`,
      };
    } catch (err) {
      return this.friendlyError(err, 'That transaction is not payable right now.');
    }
  }

  private async markDelivered(
    user: User,
    session: ChatSession,
    arg: string,
  ): Promise<OutboundChatMessage> {
    const txId = arg || session.transactionId;
    if (!txId) return { text: 'No active transaction. Create one with /sell first.' };

    const tx = await this.prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx || tx.sellerId !== user.id) {
      return { text: 'That is not one of your transactions.' };
    }

    try {
      if (tx.status === TransactionStatus.PAYMENT_PROTECTED) {
        await this.transactions.apply({
          transactionId: tx.id,
          event: { type: 'SELLER_START_DELIVERY' },
          actor: { id: user.id, type: ActorType.USER, role: 'SELLER' },
        });
      }
      await this.transactions.apply({
        transactionId: tx.id,
        event: { type: 'SELLER_MARK_DELIVERED' },
        actor: { id: user.id, type: ActorType.USER, role: 'SELLER' },
      });

      // Issue the delivery-confirmation OTP — delivered out-of-band to the buyer
      // (in chat). The code is never in this reply to the seller.
      await this.otp.issue({
        transactionId: tx.id,
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        actor: { id: user.id, type: ActorType.USER, role: 'SELLER' },
      });

      return {
        text: 'Marked delivered. Your buyer has been sent a confirmation code — funds release once they confirm.',
      };
    } catch (err) {
      if (err instanceof OtpNotIssuableError) {
        return { text: 'Marked delivered, but the buyer is not ready to confirm yet.' };
      }
      return this.friendlyError(err, 'That transaction cannot be marked delivered right now.');
    }
  }

  private async tryConfirmOtp(user: User, code: string): Promise<OutboundChatMessage> {
    const tx = await this.prisma.transaction.findFirst({
      where: { buyerId: user.id, status: TransactionStatus.CONFIRMATION_PENDING },
      orderBy: { updatedAt: 'desc' },
    });
    if (!tx) {
      return { text: 'Send /help to see what you can do.' };
    }

    try {
      await this.otp.verify({
        transactionId: tx.id,
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        code,
        actor: { id: user.id, type: ActorType.USER, role: 'BUYER' },
      });
    } catch (err) {
      if (err instanceof OtpVerificationError) {
        return { text: 'That code is invalid or expired. Ask the seller to resend if needed.' };
      }
      throw err;
    }

    await this.transactions.apply({
      transactionId: tx.id,
      event: { type: 'BUYER_CONFIRM' },
      actor: { id: user.id, type: ActorType.USER, role: 'BUYER' },
    });
    await this.queue.enqueueRelease(tx.id);

    return { text: `✅ Confirmed. Releasing funds to the seller for "${tx.title}". Thank you!` };
  }

  /**
   * Open a dispute on the caller's current transaction. A participant (buyer or
   * seller) may raise it; the state machine decides whether RAISE_DISPUTE is
   * legal from the current state and freezes automated release (rule 5). The
   * dialog never sets DISPUTED itself.
   */
  private async raiseDispute(
    user: User,
    session: ChatSession,
    arg: string,
  ): Promise<OutboundChatMessage> {
    const txId = session.transactionId;
    if (!txId) {
      return {
        text: 'No active transaction to dispute. Open the one you mean with /status first.',
      };
    }
    const tx = await this.prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx || (tx.sellerId !== user.id && tx.buyerId !== user.id)) {
      return { text: 'That is not one of your transactions.' };
    }

    try {
      const dispute = await this.disputes.raise({
        transactionId: tx.id,
        openedBy: user.id,
        role: tx.sellerId === user.id ? 'SELLER' : 'BUYER',
        reason: DisputeReason.OTHER,
        ...(arg ? { description: arg.slice(0, 500) } : {}),
      });
      // Collect photo/document evidence next (optional).
      await this.sessions.update(session.chatIdentityId, {
        step: ChatStep.DISPUTE_EVIDENCE,
        transactionId: tx.id,
        draft: { ...this.sessions.readDraft(session), disputeId: dispute.id },
      });
      return {
        text: 'Dispute opened. Automated release is now frozen while our team reviews it.\n\nSend a photo or document as evidence now, or reply "done".',
      };
    } catch (err) {
      return this.friendlyError(err, 'A dispute cannot be opened on this transaction right now.');
    }
  }

  /**
   * Attach chat photos/documents to the caller's open dispute. Each file is
   * pulled from the platform CDN by the adapter and re-uploaded to the private
   * evidence bucket (never linked from the platform CDN). We only attach to a
   * dispute the caller is a participant in and that is still open.
   */
  private async handleMedia(
    identity: ChatIdentity,
    user: User,
    session: ChatSession,
    message: InboundChatMessage,
    adapter?: ChatAdapter,
  ): Promise<OutboundChatMessage> {
    if (!adapter?.downloadMedia) {
      return { text: 'Sorry, I can’t accept attachments on this channel yet.' };
    }

    const dispute = await this.findEvidenceDispute(user, session);
    if (!dispute) {
      return {
        text: 'There’s no open dispute to attach that to. Open one with /dispute first.',
      };
    }

    let stored = 0;
    for (const media of message.media ?? []) {
      try {
        await this.evidence.capture(adapter, media, {
          transactionId: dispute.transactionId,
          disputeId: dispute.id,
          uploadedBy: user.id,
        });
        stored += 1;
      } catch (err) {
        if (err instanceof UnsupportedMediaError) {
          return { text: 'That file type isn’t supported. Send a photo (JPG/PNG) or a PDF.' };
        }
        this.logger.error(`Chat evidence capture failed: ${(err as Error).message}`);
        return { text: 'I couldn’t save that attachment. Please try sending it again.' };
      }
    }

    // Stay on the evidence step so more files can follow; keep the dispute id.
    await this.sessions.update(identity.id, {
      step: ChatStep.DISPUTE_EVIDENCE,
      transactionId: dispute.transactionId,
      draft: { ...this.sessions.readDraft(session), disputeId: dispute.id },
    });
    const noun = stored === 1 ? 'file' : 'files';
    return {
      text: `Got it — ${stored} ${noun} attached to your dispute. Send more, or reply "done".`,
    };
  }

  /**
   * The dispute a chat attachment should attach to: the one already being
   * collected for (session draft), else the newest still-open dispute the caller
   * is a participant in on their current transaction.
   */
  private async findEvidenceDispute(
    user: User,
    session: ChatSession,
  ): Promise<{ id: string; transactionId: string } | null> {
    const isOpen = (status: DisputeStatus): boolean =>
      OPEN_DISPUTE_STATUSES.includes(status as (typeof OPEN_DISPUTE_STATUSES)[number]);

    const draft = this.sessions.readDraft(session);
    if (draft.disputeId) {
      const byDraft = await this.prisma.dispute.findUnique({ where: { id: draft.disputeId } });
      if (byDraft && isOpen(byDraft.status)) {
        return { id: byDraft.id, transactionId: byDraft.transactionId };
      }
    }
    if (!session.transactionId) return null;
    const tx = await this.prisma.transaction.findUnique({
      where: { id: session.transactionId },
    });
    if (!tx || (tx.sellerId !== user.id && tx.buyerId !== user.id)) return null;

    const dispute = await this.prisma.dispute.findFirst({
      where: { transactionId: tx.id, status: { in: [...OPEN_DISPUTE_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    });
    return dispute ? { id: dispute.id, transactionId: dispute.transactionId } : null;
  }

  private async showStatus(
    user: User,
    session: ChatSession,
    arg: string,
  ): Promise<OutboundChatMessage> {
    const txId = arg || session.transactionId;
    if (!txId) return { text: 'No active transaction. /sell to create one or /pay to pay one.' };
    const tx = await this.prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx || (tx.sellerId !== user.id && tx.buyerId !== user.id)) {
      return { text: 'No transaction found for you with that code.' };
    }
    return { text: `"${tx.title}" — ₦${formatNaira(tx.amount)} — status: ${tx.status}.` };
  }

  private friendlyError(err: unknown, fallback: string): OutboundChatMessage {
    if (err instanceof TransitionRejectedError) {
      return { text: fallback };
    }
    this.logger.error(`Dialog action failed: ${(err as Error).message}`);
    return { text: 'Something went wrong. Please try again in a moment.' };
  }
}

/** Parse a Naira string ("5000", "5,000.50", "₦5000") to integer kobo, or null. */
export function parseNairaToKobo(input: string): number | null {
  const cleaned = input.replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const naira = Number(cleaned);
  if (!Number.isFinite(naira)) return null;
  return Math.round(naira * 100);
}

/** Format integer kobo as a Naira amount string (no symbol). */
export function formatNaira(kobo: number): string {
  return (kobo / 100).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
