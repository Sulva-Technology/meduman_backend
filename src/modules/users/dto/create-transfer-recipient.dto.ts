import { IsString, Matches } from 'class-validator';

/**
 * Seller payout-destination onboarding. The account is resolved with the bank
 * server-side, so the recipient name is never client-supplied.
 */
export class CreateTransferRecipientDto {
  /** Paystack bank code, e.g. "058". */
  @IsString()
  @Matches(/^\d{3,6}$/, { message: 'bankCode must be a numeric Paystack bank code' })
  bankCode!: string;

  /** 10-digit NUBAN account number. Stored masked — only the last 4 are kept. */
  @IsString()
  @Matches(/^\d{10}$/, { message: 'accountNumber must be a 10-digit NUBAN account number' })
  accountNumber!: string;
}
