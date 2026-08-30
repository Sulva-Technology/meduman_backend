import type { OutboundChatMessage } from '../adapters/chat-adapter';

/** Format integer kobo as a Naira amount string (no symbol). */
function naira(kobo: unknown): string {
  const n = typeof kobo === 'number' ? kobo : Number(kobo);
  if (!Number.isFinite(n)) return '0.00';
  return (n / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function str(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
    return String(v);
  }
  return fallback;
}

/**
 * Renders an outbound push from its template key + data. Pure and side-effect
 * free so it is trivially unit-testable. An OTP code, when present, is rendered
 * here and never persisted — it arrives only on the transient job.
 */
export function renderChatTemplate(
  templateKey: string,
  data: Record<string, unknown>,
): OutboundChatMessage {
  switch (templateKey) {
    case 'otp.delivery_confirmation':
      return {
        text: [
          'Your delivery-confirmation code is:',
          '',
          `   ${str(data.code)}`,
          '',
          'Reply here with this code to confirm you received your item and release the funds.',
        ].join('\n'),
      };
    case 'payment.dva_assigned':
      return {
        text: [
          `Payment account for "${str(data.transactionTitle)}":`,
          '',
          `  Account: ${str(data.accountNumber)}`,
          `  Bank: ${str(data.bankName)}`,
          `  Amount: ₦${naira(data.amount)}`,
          '',
          'Transfer the exact amount from your bank app. Your money is held safely until you confirm delivery.',
        ].join('\n'),
      };
    case 'payment.protected_buyer':
      return {
        text: `✅ Payment received and held safely for "${str(data.transactionTitle)}" (₦${naira(data.amount)}). It will be released to the seller once you confirm delivery.`,
      };
    case 'payment.protected_seller':
      return {
        text: `✅ A buyer has paid for "${str(data.transactionTitle)}" (₦${naira(data.amount)}). The funds are held by Meduman. Deliver, then run /delivered to start confirmation.`,
      };
    default:
      return { text: str(data.text, 'You have an update on your Meduman transaction.') };
  }
}
