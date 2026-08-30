import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Client-writable seller-profile fields. verificationStatus, trustLevel and
 * badgeSlug are server-owned and intentionally absent here. */
export class UpdateSellerProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  businessName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;
}
