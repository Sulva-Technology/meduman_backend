import { IsNotEmpty, IsString, IsUUID, ValidateIf } from 'class-validator';

export class InitializePaymentDto {
  /**
   * The transaction to collect payment for. Authenticated app surfaces that
   * already hold the transaction id send this.
   */
  @ValidateIf((dto: InitializePaymentDto) => dto.publicLinkId === undefined)
  @IsUUID()
  transactionId?: string;

  /**
   * Public link id, for buyers arriving from a shared pay link. The public
   * transaction view deliberately omits the internal id, so that surface can
   * only identify the transaction this way.
   */
  @ValidateIf((dto: InitializePaymentDto) => dto.transactionId === undefined)
  @IsString()
  @IsNotEmpty()
  publicLinkId?: string;
}
