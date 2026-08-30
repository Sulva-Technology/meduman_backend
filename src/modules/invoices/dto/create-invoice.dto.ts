import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { InvoiceLineDto } from './invoice-line.dto';

/**
 * Seller-supplied fields for a new draft invoice. The server owns number,
 * status, all money totals, publicViewId, and the linked transaction.
 */
export class CreateInvoiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  buyerName?: string;

  @IsOptional()
  @IsEmail()
  buyerEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  buyerPhone?: string;

  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  /** Basis points; 750 = 7.5%. Omit for no tax. 0–10000 (0–100%). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  taxRatePctBp?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  terms?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lineItems!: InvoiceLineDto[];
}
