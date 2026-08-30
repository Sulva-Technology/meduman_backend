import { IsNumberString, Length } from 'class-validator';

/** Buyer-submitted OTP for delivery confirmation. Digits only, OTP-length range. */
export class VerifyOtpDto {
  @IsNumberString()
  @Length(4, 10)
  code!: string;
}
