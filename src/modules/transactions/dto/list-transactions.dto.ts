import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { TransactionStatus } from '@prisma/client';

/** Query params for the role-scoped dashboard transaction list. */
export class ListTransactionsDto {
  /** Which side the caller is viewing as. Always intersected with their own id. */
  @IsIn(['buyer', 'seller'])
  role!: 'buyer' | 'seller';

  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  /** Last id from the previous page. */
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
