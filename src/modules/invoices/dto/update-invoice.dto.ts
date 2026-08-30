import { PartialType } from '@nestjs/mapped-types';
import { CreateInvoiceDto } from './create-invoice.dto';

/** Edit a DRAFT invoice. Every field optional; lineItems (if given) replace the set. */
export class UpdateInvoiceDto extends PartialType(CreateInvoiceDto) {}
