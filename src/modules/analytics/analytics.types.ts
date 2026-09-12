import type { TransactionOrigin } from '@prisma/client';

/**
 * One origin's funnel and money, as it comes back from Postgres. Money and
 * counts are `bigint` because that is what `SUM`/`COUNT` return — the conversion
 * to a JSON-safe shape is a separate, tested step (`analytics.mapper.ts`).
 */
export interface PlatformMetrics {
  origin: TransactionOrigin;
  sellers: bigint;
  buyers: bigint;
  created: bigint;
  published: bigint;
  paymentStarted: bigint;
  protected: bigint;
  delivered: bigint;
  released: bigint;
  disputed: bigint;
  protectedVolumeKobo: bigint;
  releasedVolumeKobo: bigint;
  feesKobo: bigint;
}

/** JSON-safe. Counts are numbers; money is a decimal string. */
export interface PlatformMetricsResponse {
  origin: TransactionOrigin | 'ALL';
  sellers: number;
  buyers: number;
  created: number;
  published: number;
  paymentStarted: number;
  protected: number;
  delivered: number;
  released: number;
  disputed: number;
  /** Fraction, not a percent: 0.021 = 2.10%. */
  disputeRate: number;
  protectedVolumeKobo: string;
  releasedVolumeKobo: string;
  feesKobo: string;
}

export interface PlatformAnalyticsResponse {
  from: string;
  to: string;
  platforms: PlatformMetricsResponse[];
  totals: PlatformMetricsResponse;
}
