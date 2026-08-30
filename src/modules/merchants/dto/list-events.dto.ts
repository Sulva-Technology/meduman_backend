import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { OutboundEventStatus } from '@prisma/client';

export class ListEventsDto {
  @IsOptional() @IsEnum(OutboundEventStatus) status?: OutboundEventStatus;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
