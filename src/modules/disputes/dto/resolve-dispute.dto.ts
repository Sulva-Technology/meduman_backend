import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ResolveDisputeDto {
  /** RELEASE → funds to seller; REFUND → funds back to buyer. */
  @IsIn(['RELEASE', 'REFUND'])
  outcome!: 'RELEASE' | 'REFUND';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolution?: string;
}
