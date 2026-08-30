import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MerchantStatus } from '@prisma/client';

export class CreateMerchantDto {
  @IsString() @MaxLength(120) name!: string;
}

export class UpdateMerchantDto {
  @IsOptional() @IsBoolean() livemodeEnabled?: boolean;
  @IsOptional() @IsIn([MerchantStatus.ACTIVE, MerchantStatus.SUSPENDED]) status?: MerchantStatus;
}

export class IssueKeyDto {
  @IsOptional() @IsBoolean() livemode?: boolean;
}
