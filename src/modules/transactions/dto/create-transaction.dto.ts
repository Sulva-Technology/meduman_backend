import {
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { FeeModel, ReleaseRule } from '@prisma/client';

/**
 * Seller-supplied fields for a new transaction. The server owns everything else
 * (status, public link id, buyer). Amounts are integer minor units (kobo).
 */
export class CreateTransactionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** Protected amount in kobo. Integer, positive — never a float. */
  @IsInt()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsEnum(ReleaseRule)
  releaseRule?: ReleaseRule;

  @IsOptional()
  @IsEnum(FeeModel)
  feeModel?: FeeModel;

  @IsOptional()
  @IsInt()
  feeAmount?: number;
}
