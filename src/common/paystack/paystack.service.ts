import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';

export interface InitializeTransactionInput {
  email: string;
  /** Amount in minor units (kobo). Integer only. */
  amount: number;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  /**
   * Deliberately no `subaccount` field (decision D-2). Attaching a subaccount at
   * collection split-settles the seller's share immediately, so the platform
   * never holds the funds — which defeats transaction protection. Disbursement
   * happens later, via an authorized transfer out of the platform balance.
   */
}

export interface InitializeTransactionResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface VerifyTransactionResult {
  /** Paystack charge status: "success" | "failed" | "abandoned" | ... */
  status: string;
  /** Amount actually collected — minor units (kobo). */
  amount: number;
  reference: string;
  paidAt: string | null;
  gatewayResponse: string | null;
  /** Full provider payload for audit / dispute evidence. */
  raw: unknown;
}

export interface InitiateTransferInput {
  /** Amount in minor units (kobo). */
  amount: number;
  /** Paystack transfer recipient code (RCP_...). */
  recipient: string;
  /** Our idempotency reference — Paystack dedupes transfers by reference. */
  reference: string;
  reason?: string;
}

export interface InitiateTransferResult {
  transferCode: string;
  status: string;
  reference: string;
}

export interface VerifyTransferResult {
  transferCode: string;
  /** Paystack transfer status: "success" | "pending" | "failed" | "reversed". */
  status: string;
}

export interface ResolveAccountInput {
  accountNumber: string;
  /** Paystack bank code (NUBAN). */
  bankCode: string;
}

export interface ResolveAccountResult {
  /** Account name as held at the bank — used as the recipient name. */
  accountName: string;
  accountNumber: string;
}

export interface CreateTransferRecipientInput {
  /** Recipient name — the bank-resolved account name, not user-supplied text. */
  name: string;
  accountNumber: string;
  bankCode: string;
}

export interface CreateTransferRecipientResult {
  /** Paystack recipient code (RCP_...) — the payout destination. */
  recipientCode: string;
}

export interface BankOption {
  name: string;
  code: string;
}

export interface CreateSubaccountInput {
  businessName: string;
  /** Bank code (Paystack `settlement_bank`). */
  settlementBank: string;
  accountNumber: string;
  /** Platform's percentage charge on this subaccount's settlements. */
  percentageCharge: number;
}

export interface CreateSubaccountResult {
  subaccountCode: string;
}

export interface CreateCustomerInput {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface CreateCustomerResult {
  customerCode: string;
}

export interface CreateDedicatedAccountInput {
  /** Paystack customer code (CUS_...). */
  customerCode: string;
  /** Preferred provider bank slug (e.g. "wema-bank", "titan-paystack"). */
  preferredBank?: string;
}

/**
 * Result of requesting a dedicated virtual account. Assignment is often
 * asynchronous, so the account fields may be null here and arrive later on the
 * `dedicatedaccount.assign.success` webhook.
 */
export interface CreateDedicatedAccountResult {
  accountNumber: string | null;
  bankName: string | null;
  dedicatedAccountId: string | null;
}

/** Paystack's standard envelope: `{ status, message, data }`. */
interface PaystackEnvelope<T> {
  status: boolean;
  message?: string;
  data?: T;
}

/**
 * Thin, typed Paystack HTTP client + webhook-signature verifier. The single
 * place this backend talks to Paystack: collection init, server-side verify
 * (money rule 2), transfers (payouts), and subaccount creation. Amounts are
 * always integer kobo — never floats.
 */
@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private readonly secretKey: string;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.secretKey = this.config.get('PAYSTACK_SECRET_KEY', { infer: true });
    this.baseUrl = this.config.get('PAYSTACK_BASE_URL', { infer: true });
  }

  /**
   * Verify a Paystack webhook HMAC (money rule 2). Signature is
   * `HMAC-SHA512(secretKey, rawBody)` hex, sent in `x-paystack-signature`.
   * Constant-time compare; any malformed input returns false, never throws.
   */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    let provided: Buffer;
    let expectedBuf: Buffer;
    try {
      provided = Buffer.from(signature, 'hex');
      expectedBuf = Buffer.from(expected, 'hex');
    } catch {
      return false;
    }
    if (provided.length !== expectedBuf.length) return false;
    return timingSafeEqual(provided, expectedBuf);
  }

  async initializeTransaction(
    input: InitializeTransactionInput,
  ): Promise<InitializeTransactionResult> {
    const data = await this.request<{
      authorization_url: string;
      access_code: string;
      reference: string;
    }>('POST', '/transaction/initialize', {
      email: input.email,
      amount: input.amount,
      reference: input.reference,
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return {
      authorizationUrl: data.authorization_url,
      accessCode: data.access_code,
      reference: data.reference,
    };
  }

  async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
    const data = await this.request<{
      status: string;
      amount: number;
      reference: string;
      paid_at: string | null;
      gateway_response: string | null;
    }>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      status: data.status,
      amount: data.amount,
      reference: data.reference,
      paidAt: data.paid_at ?? null,
      gatewayResponse: data.gateway_response ?? null,
      raw: data,
    };
  }

  async initiateTransfer(input: InitiateTransferInput): Promise<InitiateTransferResult> {
    const data = await this.request<{
      transfer_code: string;
      status: string;
      reference: string;
    }>('POST', '/transfer', {
      source: 'balance',
      amount: input.amount,
      recipient: input.recipient,
      reference: input.reference,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return { transferCode: data.transfer_code, status: data.status, reference: data.reference };
  }

  /**
   * Look up a transfer by our reference. Returns null when Paystack has no such
   * transfer, so a caller can distinguish "never sent" from "already sent" after
   * a crash between sending and persisting the code. Never throws on a miss.
   */
  async verifyTransfer(reference: string): Promise<VerifyTransferResult | null> {
    try {
      const data = await this.request<{ transfer_code: string; status: string }>(
        'GET',
        `/transfer/verify/${encodeURIComponent(reference)}`,
      );
      return { transferCode: data.transfer_code, status: data.status };
    } catch {
      return null;
    }
  }

  /**
   * Resolve a NUBAN account with its bank. Run before creating a recipient so
   * the payout destination is a real account and the recipient name is the
   * bank's, not user-supplied text.
   */
  async resolveAccount(input: ResolveAccountInput): Promise<ResolveAccountResult> {
    const query = new URLSearchParams({
      account_number: input.accountNumber,
      bank_code: input.bankCode,
    });
    const data = await this.request<{ account_number: string; account_name: string }>(
      'GET',
      `/bank/resolve?${query.toString()}`,
    );
    return { accountName: data.account_name, accountNumber: data.account_number };
  }

  /** Create the seller's transfer recipient — the only destination we pay out to. */
  async createTransferRecipient(
    input: CreateTransferRecipientInput,
  ): Promise<CreateTransferRecipientResult> {
    const data = await this.request<{ recipient_code: string }>('POST', '/transferrecipient', {
      type: 'nuban',
      name: input.name,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: 'NGN',
    });
    return { recipientCode: data.recipient_code };
  }

  /** Bank list for the seller's settlement-account picker. */
  async listBanks(): Promise<BankOption[]> {
    const data = await this.request<{ name: string; code: string }[]>('GET', '/bank?currency=NGN');
    return data.map((b) => ({ name: b.name, code: b.code }));
  }

  async createSubaccount(input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
    const data = await this.request<{ subaccount_code: string }>('POST', '/subaccount', {
      business_name: input.businessName,
      settlement_bank: input.settlementBank,
      account_number: input.accountNumber,
      percentage_charge: input.percentageCharge,
    });
    return { subaccountCode: data.subaccount_code };
  }

  /**
   * Create a Paystack customer. For a DVA collection we make one throwaway
   * customer per transaction, so an inbound bank transfer maps deterministically
   * to exactly one payment (no amount-based guessing when a buyer has two open
   * transactions).
   */
  async createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult> {
    const data = await this.request<{ customer_code: string }>('POST', '/customer', {
      email: input.email,
      ...(input.firstName ? { first_name: input.firstName } : {}),
      ...(input.lastName ? { last_name: input.lastName } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
    });
    return { customerCode: data.customer_code };
  }

  /**
   * Request a dedicated virtual account for a customer. Assignment may be
   * asynchronous — when it is, the account fields come back null here and land
   * later on `dedicatedaccount.assign.success`. Requires DVA to be enabled on the
   * Paystack account; NGN only.
   */
  async createDedicatedAccount(
    input: CreateDedicatedAccountInput,
  ): Promise<CreateDedicatedAccountResult> {
    const data = await this.request<{
      id?: number | string;
      account_number?: string;
      bank?: { name?: string };
    }>('POST', '/dedicated_account', {
      customer: input.customerCode,
      ...(input.preferredBank ? { preferred_bank: input.preferredBank } : {}),
    });
    return {
      accountNumber: data.account_number ?? null,
      bankName: data.bank?.name ?? null,
      dedicatedAccountId: data.id !== undefined ? String(data.id) : null,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      this.logger.error(`Paystack ${method} ${path} network error`, err as Error);
      throw new BadGatewayException('Payment provider unreachable');
    }

    let payload: PaystackEnvelope<T>;
    try {
      payload = (await res.json()) as PaystackEnvelope<T>;
    } catch {
      throw new BadGatewayException('Payment provider returned an unreadable response');
    }

    if (!res.ok || payload.status !== true || payload.data === undefined) {
      this.logger.warn(`Paystack ${method} ${path} failed: ${payload.message ?? res.status}`);
      throw new BadGatewayException(payload.message ?? 'Payment provider error');
    }
    return payload.data;
  }
}
