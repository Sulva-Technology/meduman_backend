import { TransactionStatus, type ChatIdentity, type ChatSession, type User } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { TransactionsService } from '@/modules/transactions/transactions.service';
import type { PaymentsService } from '@/modules/payments/payments.service';
import type { OtpService } from '@/modules/otp/otp.service';
import type { SellerProfileService } from '@/modules/users/seller-profile.service';
import type { QueueService } from '@/modules/queue/queue.service';
import type { ChatSessionService } from '../session/chat-session.service';
import { OtpVerificationError, OtpFailureReason } from '@/modules/otp/otp.errors';
import { ChatDialogService, parseNairaToKobo } from './chat-dialog.service';
import { ChatStep } from './dialog.types';

const IDENTITY = { id: 'ci-1', platform: 'TELEGRAM' } as unknown as ChatIdentity;
const USER = { id: 'user-1', email: 'chat+telegram-999@x.test' } as unknown as User;

function session(step: ChatStep, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's-1',
    chatIdentityId: 'ci-1',
    step,
    draft: null,
    transactionId: null,
    ...extra,
  } as unknown as ChatSession;
}

function makeDeps() {
  const txFindUnique = jest.fn().mockResolvedValue(null);
  const txFindFirst = jest.fn();
  const disputeFindUnique = jest.fn().mockResolvedValue(null);
  const disputeFindFirst = jest.fn().mockResolvedValue(null);
  const prisma = {
    transaction: { findUnique: txFindUnique, findFirst: txFindFirst },
    dispute: { findUnique: disputeFindUnique, findFirst: disputeFindFirst },
  } as unknown as PrismaService;

  const sessionUpdate = jest.fn().mockResolvedValue(undefined);
  const sessionReset = jest.fn().mockResolvedValue(undefined);
  const sessions = {
    update: sessionUpdate,
    reset: sessionReset,
    readDraft: (s: ChatSession) => (s.draft as Record<string, unknown> | null) ?? {},
  } as unknown as ChatSessionService;

  const apply = jest.fn().mockResolvedValue({});
  const createDraft = jest
    .fn()
    .mockResolvedValue({ id: 'tx-1', title: 'Sneakers', amount: 500000, publicLinkId: 'link123' });
  const transactions = { apply, createDraft } as unknown as TransactionsService;

  const initializeVirtualAccount = jest.fn();
  const payments = { initializeVirtualAccount } as unknown as PaymentsService;

  const issue = jest.fn().mockResolvedValue({});
  const verify = jest.fn().mockResolvedValue(undefined);
  const otp = { issue, verify } as unknown as OtpService;

  const getOrCreate = jest.fn().mockResolvedValue({ providerRecipientCode: 'RCP_1' });
  const createTransferRecipient = jest
    .fn()
    .mockResolvedValue({ settlementAccountName: 'ACME Bank', settlementAccountLast4: '6789' });
  const sellers = { getOrCreate, createTransferRecipient } as unknown as SellerProfileService;

  const raise = jest.fn().mockResolvedValue({});
  const disputes = {
    raise,
  } as unknown as import('@/modules/disputes/disputes.service').DisputesService;

  const enqueueRelease = jest.fn().mockResolvedValue(undefined);
  const queue = { enqueueRelease } as unknown as QueueService;

  const capture = jest.fn().mockResolvedValue({ id: 'ev-1' });
  const evidence = {
    capture,
  } as unknown as import('../evidence/chat-evidence.service').ChatEvidenceService;

  const service = new ChatDialogService(
    prisma,
    sessions,
    transactions,
    payments,
    otp,
    sellers,
    disputes,
    queue,
    evidence,
  );
  return {
    service,
    sessionUpdate,
    sessionReset,
    createTransferRecipient,
    apply,
    createDraft,
    issue,
    verify,
    raise,
    enqueueRelease,
    capture,
    txFindUnique,
    txFindFirst,
    disputeFindUnique,
    disputeFindFirst,
  };
}

/** A minimal adapter with media download for the evidence-capture tests. */
function mediaAdapter() {
  return {
    platform: 'TELEGRAM',
    capabilities: { buttons: true, media: true },
    downloadMedia: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
  } as never;
}

describe('parseNairaToKobo', () => {
  it('converts Naira to integer kobo', () => {
    expect(parseNairaToKobo('5000')).toBe(500000);
    expect(parseNairaToKobo('5,000.50')).toBe(500050);
    expect(parseNairaToKobo('₦1200')).toBe(120000);
  });
  it('rejects junk', () => {
    expect(parseNairaToKobo('abc')).toBeNull();
    expect(parseNairaToKobo('1.234')).toBeNull();
  });
});

describe('ChatDialogService — seller creates a transaction', () => {
  it('/sell starts the title step', async () => {
    const { service, sessionUpdate } = makeDeps();
    await service.handle(IDENTITY, USER, session(ChatStep.IDLE), {
      platform: 'TELEGRAM',
      providerMessageId: 'm1',
      from: '999',
      text: '/sell',
    } as never);
    expect(sessionUpdate).toHaveBeenCalledWith(
      'ci-1',
      expect.objectContaining({ step: ChatStep.SELLER_TX_TITLE }),
    );
  });

  it('creates and publishes the transaction after the description step', async () => {
    const { service, createDraft, apply } = makeDeps();
    const s = session(ChatStep.SELLER_TX_DESCRIPTION, {
      draft: { title: 'Sneakers', amountKobo: 500000 },
    });

    const reply = await service.handle(IDENTITY, USER, s, {
      platform: 'TELEGRAM',
      providerMessageId: 'm2',
      from: '999',
      text: 'skip',
    } as never);

    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ sellerId: 'user-1', title: 'Sneakers', amount: 500000 }),
    );
    // Published through the machine — never a direct status write.
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ event: { type: 'SELLER_PUBLISH' } }),
    );
    expect(reply.text).toContain('/pay link123');
  });
});

describe('ChatDialogService — seller sets up payout', () => {
  const payoutMsg = (from = '999') =>
    ({
      platform: 'TELEGRAM',
      providerMessageId: 'po1',
      from,
      text: '058 0123456789',
    }) as never;

  it('keeps the active transaction after payout setup (so /delivered still works)', async () => {
    const { service, createTransferRecipient, sessionUpdate, sessionReset } = makeDeps();

    await service.handle(
      IDENTITY,
      USER,
      session(ChatStep.SELLER_PAYOUT_ACCOUNT, { transactionId: 'tx-1' }),
      payoutMsg(),
    );

    expect(createTransferRecipient).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ bankCode: '058', accountNumber: '0123456789' }),
    );
    // Returns to IDLE without discarding the seller's current transaction — a
    // full reset would strand a seller who set up payout after creating a tx,
    // because chat only ever exposes the publicLinkId, never the internal id.
    expect(sessionReset).not.toHaveBeenCalled();
    expect(sessionUpdate).toHaveBeenCalledWith('ci-1', { step: ChatStep.IDLE });
  });

  it('also preserves the active transaction when the bank account is rejected', async () => {
    const { service, createTransferRecipient, sessionUpdate, sessionReset } = makeDeps();
    createTransferRecipient.mockRejectedValue(new Error('could not resolve account'));

    const reply = await service.handle(
      IDENTITY,
      USER,
      session(ChatStep.SELLER_PAYOUT_ACCOUNT, { transactionId: 'tx-1' }),
      payoutMsg(),
    );

    expect(sessionReset).not.toHaveBeenCalled();
    expect(sessionUpdate).toHaveBeenCalledWith('ci-1', { step: ChatStep.IDLE });
    expect(reply.text.toLowerCase()).toContain('could not verify');
  });
});

describe('ChatDialogService — dispute', () => {
  it("/dispute raises a dispute on the caller's current transaction via the service", async () => {
    const { service, raise, txFindUnique } = makeDeps();
    txFindUnique.mockResolvedValue({ id: 'tx-1', sellerId: 'other', buyerId: 'user-1' });

    const reply = await service.handle(
      IDENTITY,
      USER,
      session(ChatStep.IDLE, { transactionId: 'tx-1' }),
      {
        platform: 'TELEGRAM',
        providerMessageId: 'd1',
        from: '999',
        text: '/dispute item never arrived',
      } as never,
    );

    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-1', openedBy: 'user-1', role: 'BUYER' }),
    );
    expect(reply.text.toLowerCase()).toContain('frozen');
  });

  it('/dispute with no active transaction asks the user to pick one', async () => {
    const { service, raise } = makeDeps();

    const reply = await service.handle(IDENTITY, USER, session(ChatStep.IDLE), {
      platform: 'TELEGRAM',
      providerMessageId: 'd2',
      from: '999',
      text: '/dispute',
    } as never);

    expect(raise).not.toHaveBeenCalled();
    expect(reply.text.toLowerCase()).toContain('no active transaction');
  });
});

describe('ChatDialogService — dispute photo evidence', () => {
  it('attaches a photo to the open dispute via ChatEvidenceService', async () => {
    const { service, capture, disputeFindUnique } = makeDeps();
    disputeFindUnique.mockResolvedValue({
      id: 'disp-1',
      transactionId: 'tx-1',
      status: 'OPEN',
    });

    const reply = await service.handle(
      IDENTITY,
      USER,
      session(ChatStep.DISPUTE_EVIDENCE, {
        transactionId: 'tx-1',
        draft: { disputeId: 'disp-1' },
      }),
      {
        platform: 'TELEGRAM',
        providerMessageId: 'p1',
        from: '999',
        media: [{ id: 'file-1', mimeType: 'image/jpeg' }],
      } as never,
      mediaAdapter(),
    );

    expect(capture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'file-1' }),
      expect.objectContaining({ transactionId: 'tx-1', disputeId: 'disp-1', uploadedBy: 'user-1' }),
    );
    expect(reply.text.toLowerCase()).toContain('attached');
  });

  it('refuses a photo when there is no open dispute', async () => {
    const { service, capture } = makeDeps();

    const reply = await service.handle(
      IDENTITY,
      USER,
      session(ChatStep.IDLE),
      {
        platform: 'TELEGRAM',
        providerMessageId: 'p2',
        from: '999',
        media: [{ id: 'file-2' }],
      } as never,
      mediaAdapter(),
    );

    expect(capture).not.toHaveBeenCalled();
    expect(reply.text.toLowerCase()).toContain('no open dispute');
  });

  it('tells the user when the channel cannot accept attachments', async () => {
    const { service, capture } = makeDeps();

    const reply = await service.handle(
      IDENTITY,
      USER,
      session(ChatStep.DISPUTE_EVIDENCE, { transactionId: 'tx-1', draft: { disputeId: 'disp-1' } }),
      {
        platform: 'TELEGRAM',
        providerMessageId: 'p3',
        from: '999',
        media: [{ id: 'file-3' }],
      } as never,
      // Adapter with no downloadMedia capability.
      { platform: 'TELEGRAM' } as never,
    );

    expect(capture).not.toHaveBeenCalled();
    expect(reply.text.toLowerCase()).toContain('attachments');
  });
});

describe('ChatDialogService — buyer confirms with an OTP', () => {
  it('verifies the code, drives BUYER_CONFIRM, and enqueues release', async () => {
    const { service, verify, apply, enqueueRelease, txFindFirst } = makeDeps();
    txFindFirst.mockResolvedValue({
      id: 'tx-1',
      title: 'Sneakers',
      status: TransactionStatus.CONFIRMATION_PENDING,
    });

    const reply = await service.handle(IDENTITY, USER, session(ChatStep.IDLE), {
      platform: 'TELEGRAM',
      providerMessageId: 'm3',
      from: '999',
      text: '135790',
    } as never);

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-1', code: '135790' }),
    );
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ event: { type: 'BUYER_CONFIRM' } }),
    );
    expect(enqueueRelease).toHaveBeenCalledWith('tx-1');
    expect(reply.text).toContain('Confirmed');
  });

  it('does NOT confirm on a wrong code — no transition, no release', async () => {
    const { service, apply, enqueueRelease, verify, txFindFirst } = makeDeps();
    txFindFirst.mockResolvedValue({
      id: 'tx-1',
      title: 'Sneakers',
      status: TransactionStatus.CONFIRMATION_PENDING,
    });
    verify.mockRejectedValue(new OtpVerificationError(OtpFailureReason.MISMATCH));

    const reply = await service.handle(IDENTITY, USER, session(ChatStep.IDLE), {
      platform: 'TELEGRAM',
      providerMessageId: 'm4',
      from: '999',
      text: '000000',
    } as never);

    expect(apply).not.toHaveBeenCalled();
    expect(enqueueRelease).not.toHaveBeenCalled();
    expect(reply.text.toLowerCase()).toContain('invalid');
  });
});
