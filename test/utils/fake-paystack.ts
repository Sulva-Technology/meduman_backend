import { createHmac } from 'node:crypto';

/**
 * Controllable Paystack stand-in for e2e. Real HMAC signature verification (so the
 * webhook-signature test is faithful), but all HTTP calls are faked — no network,
 * no live keys. Swap `verifyResult` per test to drive success/mismatch/abandoned.
 */
export class FakePaystack {
  /** Must match PAYSTACK_SECRET_KEY in the e2e env so signatures line up. */
  constructor(private readonly secret: string) {}

  /** Default verify: success for whatever amount the test asks for. */
  verifyResult: { status: string; amount: number } = { status: 'success', amount: 0 };

  /** Compute a valid signature for a raw body (tests use this to sign). */
  sign(rawBody: string): string {
    return createHmac('sha512', this.secret).update(rawBody).digest('hex');
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha512', this.secret).update(rawBody).digest('hex');
    return expected === signature;
  }

  initializeTransaction(input: { reference: string }): Promise<{
    authorizationUrl: string;
    accessCode: string;
    reference: string;
  }> {
    return Promise.resolve({
      authorizationUrl: 'https://checkout.paystack.test/pay',
      accessCode: 'ac_test',
      reference: input.reference,
    });
  }

  verifyTransaction(reference: string): Promise<{
    status: string;
    amount: number;
    reference: string;
    paidAt: string | null;
    gatewayResponse: string | null;
    raw: unknown;
  }> {
    return Promise.resolve({
      status: this.verifyResult.status,
      amount: this.verifyResult.amount,
      reference,
      paidAt: new Date().toISOString(),
      gatewayResponse: 'Approved',
      raw: { reference, ...this.verifyResult },
    });
  }

  /** Every transfer this fake was asked to send — the double-pay assertion reads it. */
  transfers: { reference: string; amount: number; recipient: string }[] = [];

  /** Set to make the next transfer attempt fail, as Paystack would. */
  transferError: Error | null = null;

  /** What `verifyTransfer` reports per reference. Absent = Paystack has no such transfer. */
  knownTransfers = new Map<string, { transferCode: string; status: string }>();

  initiateTransfer(input: { reference: string; amount: number; recipient: string }): Promise<{
    transferCode: string;
    status: string;
    reference: string;
  }> {
    if (this.transferError) {
      return Promise.reject(this.transferError);
    }
    this.transfers.push({
      reference: input.reference,
      amount: input.amount,
      recipient: input.recipient,
    });
    const transferCode = `TRF_${this.transfers.length}`;
    this.knownTransfers.set(input.reference, { transferCode, status: 'pending' });
    return Promise.resolve({ transferCode, status: 'pending', reference: input.reference });
  }

  verifyTransfer(reference: string): Promise<{ transferCode: string; status: string } | null> {
    return Promise.resolve(this.knownTransfers.get(reference) ?? null);
  }

  resolveAccount(input: { accountNumber: string }): Promise<{
    accountName: string;
    accountNumber: string;
  }> {
    return Promise.resolve({ accountName: 'E2E SELLER', accountNumber: input.accountNumber });
  }

  createTransferRecipient(): Promise<{ recipientCode: string }> {
    return Promise.resolve({ recipientCode: 'RCP_e2e_seller' });
  }

  listBanks(): Promise<{ name: string; code: string }[]> {
    return Promise.resolve([{ name: 'Test Bank', code: '058' }]);
  }

  createSubaccount(): Promise<{ subaccountCode: string }> {
    return Promise.resolve({ subaccountCode: 'ACCT_test' });
  }

  /** One throwaway customer per DVA transaction — deterministic for the e2e. */
  createCustomer(): Promise<{ customerCode: string }> {
    return Promise.resolve({ customerCode: 'CUS_e2e' });
  }

  /** Assigns a fixed dedicated account synchronously for the e2e. */
  createDedicatedAccount(): Promise<{
    accountNumber: string | null;
    bankName: string | null;
    dedicatedAccountId: string | null;
  }> {
    return Promise.resolve({
      accountNumber: '9900000001',
      bankName: 'Test Bank',
      dedicatedAccountId: 'DA_e2e',
    });
  }
}
