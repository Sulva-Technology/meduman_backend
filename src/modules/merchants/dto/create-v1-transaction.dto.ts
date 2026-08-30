import { IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { ReleaseRule } from '@prisma/client';

export class CreateV1TransactionDto {
  @IsUUID() sellerId!: string;
  @IsString() @MaxLength(200) title!: string;
  /** Protected amount in KOBO (integer). */
  @IsInt() @Min(1) amount!: number;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsEnum(ReleaseRule) releaseRule?: ReleaseRule;
}
