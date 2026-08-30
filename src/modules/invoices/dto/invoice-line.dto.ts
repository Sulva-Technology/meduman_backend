import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * A client-supplied invoice line. The client sends inputs only — never lineTotal;
 * the server computes every money field (money rule 1).
 */
export class InvoiceLineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsInt()
  @IsPositive()
  quantity!: number;

  /** Unit price in kobo. Integer, positive — never a float. */
  @IsInt()
  @Min(0)
  unitPrice!: number;
}
