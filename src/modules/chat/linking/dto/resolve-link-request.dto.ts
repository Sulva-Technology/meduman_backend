import { IsIn, IsOptional } from 'class-validator';

export class ResolveLinkRequestDto {
  /** COMPLETE runs the merge; REJECT closes it having written nothing. */
  @IsIn(['COMPLETE', 'REJECT'])
  outcome!: 'COMPLETE' | 'REJECT';

  /** Which profile survives a SELLER_PROFILE_CONFLICT. Required for COMPLETE on that reason. */
  @IsOptional()
  @IsIn(['TARGET', 'SOURCE'])
  keepProfile?: 'TARGET' | 'SOURCE';
}
