import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DisputeOutcome, DisputeReason } from '@prisma/client';

export class RaiseDisputeDto {
  @IsEnum(DisputeReason)
  reason!: DisputeReason;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(DisputeOutcome)
  desiredOutcome?: DisputeOutcome;
}
