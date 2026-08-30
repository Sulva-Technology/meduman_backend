import { IsUrl, MaxLength } from 'class-validator';

export class SetWebhookEndpointDto {
  @IsUrl({ require_tld: false }) @MaxLength(500) url!: string;
}
