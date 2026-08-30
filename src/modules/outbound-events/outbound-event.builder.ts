export interface OutboundTxView {
  id: string;
  status: string;
  amount: number;
  currency: string;
  title: string;
  merchantId: string | null;
}

export interface OutboundPayload {
  transactionId: string;
  status: string;
  amount: number;
  currency: string;
  title: string;
}

const TYPE_MAP: Record<string, string> = {
  PAYMENT_VERIFIED: 'transaction.protected',
  CANCEL: 'transaction.cancelled',
  RAISE_DISPUTE: 'dispute.opened',
  RESOLVE_DISPUTE_FOR_SELLER: 'dispute.resolved',
  RESOLVE_DISPUTE_FOR_BUYER: 'dispute.resolved',
  PAYOUT_SUCCEEDED: 'funds.released',
};

/** Map a state-machine event to a merchant-facing outbound event, or null. */
export function buildOutboundEvent(
  eventType: string,
  tx: OutboundTxView,
): { type: string; payload: OutboundPayload } | null {
  const type = TYPE_MAP[eventType];
  if (!type) return null;
  return {
    type,
    payload: {
      transactionId: tx.id,
      status: tx.status,
      amount: tx.amount,
      currency: tx.currency,
      title: tx.title,
    },
  };
}
