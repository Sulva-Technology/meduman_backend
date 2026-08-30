import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Pre-launch lead capture. Unauthenticated — keep the surface small. */
export class CreateWaitlistDto {
  @IsString()
  @MaxLength(120)
  fullName!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  userType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  channel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  useCase?: string;

  /** Self-reported average transaction value — minor units (kobo), integer. */
  @IsOptional()
  @IsInt()
  @Min(0)
  avgTransactionValue?: number;

  @IsOptional()
  @IsBoolean()
  consent?: boolean;
}
