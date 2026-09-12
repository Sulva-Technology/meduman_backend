import { IsISO8601 } from 'class-validator';

/**
 * Range for the platform analytics query. `to` is EXCLUSIVE.
 *
 * `from`/`to` are required rather than defaulted: a silent default would make an
 * accidental unbounded query look like a successful one. Range ordering and the
 * width cap are cross-field checks that live in the controller, where the
 * configured cap is available.
 */
export class PlatformAnalyticsQueryDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;
}
