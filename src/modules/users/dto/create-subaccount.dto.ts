import { IsString, Matches, MaxLength } from 'class-validator';

/** Bank settlement details for creating the seller's Paystack subaccount. */
export class CreateSubaccountDto {
  @IsString()
  @MaxLength(120)
  businessName!: string;

  /** Paystack bank code (settlement_bank), e.g. "058". */
  @IsString()
  @MaxLength(10)
  settlementBank!: string;

  /** NUBAN account number — 10 digits. */
  @Matches(/^\d{10}$/, { message: 'accountNumber must be a 10-digit NUBAN' })
  accountNumber!: string;
}
