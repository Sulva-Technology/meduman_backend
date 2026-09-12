import { ALL_ORIGINS } from './origin.mapper';
import type {
  PlatformAnalyticsResponse,
  PlatformMetrics,
  PlatformMetricsResponse,
} from './analytics.types';

export type {
  PlatformMetrics,
  PlatformMetricsResponse,
  PlatformAnalyticsResponse,
} from './analytics.types';

/**
 * `bigint` → decimal string. Money must NOT become a JS number: a kobo value
 * above 2^53 loses precision silently, and `JSON.stringify` throws outright on a
 * `BigInt`, so leaving it raw 500s the endpoint the moment any volume row is
 * non-empty.
 */
function kobo(value: bigint): string {
  return value.toString();
}

/**
 * Fraction to 4dp, not a percent. 0 when nothing was protected — a rate over an
 * empty denominator is undefined, and 0 is the honest rendering of "no data".
 *
 * One integer division, in units of 1e-4, then scale once. Dividing twice
 * (`/ 100n` then `/ 100`) truncates to 2dp and silently understates the rate.
 */
function rate(disputed: bigint, protectedCount: bigint): number {
  if (protectedCount === 0n) {
    return 0;
  }
  return Number((disputed * 10_000n) / protectedCount) / 10_000;
}

function toResponse(row: PlatformMetrics): PlatformMetricsResponse {
  return {
    origin: row.origin,
    sellers: Number(row.sellers),
    buyers: Number(row.buyers),
    created: Number(row.created),
    published: Number(row.published),
    paymentStarted: Number(row.paymentStarted),
    protected: Number(row.protected),
    delivered: Number(row.delivered),
    released: Number(row.released),
    disputed: Number(row.disputed),
    disputeRate: rate(row.disputed, row.protected),
    protectedVolumeKobo: kobo(row.protectedVolumeKobo),
    releasedVolumeKobo: kobo(row.releasedVolumeKobo),
    feesKobo: kobo(row.feesKobo),
  };
}

const ZERO: PlatformMetrics = {
  origin: ALL_ORIGINS[0] as PlatformMetrics['origin'],
  sellers: 0n,
  buyers: 0n,
  created: 0n,
  published: 0n,
  paymentStarted: 0n,
  protected: 0n,
  delivered: 0n,
  released: 0n,
  disputed: 0n,
  protectedVolumeKobo: 0n,
  releasedVolumeKobo: 0n,
  feesKobo: 0n,
};

/**
 * Zero-fill to every origin so the response shape is constant — a dashboard
 * renders the same seven rows whether or not a platform has activity — and add a
 * `totals` row that aggregates all of them.
 *
 * Totals are summed from the `bigint` values, never from the serialized strings,
 * and `disputeRate` is RE-DERIVED from the summed counts. Averaging the
 * per-origin rates would weight a platform with one protected transaction the
 * same as one with ten thousand.
 */
export function toPlatformAnalyticsResponse(
  rows: PlatformMetrics[],
): Omit<PlatformAnalyticsResponse, 'from' | 'to'> {
  const byOrigin = new Map(rows.map((r) => [r.origin, r]));
  const platforms = ALL_ORIGINS.map((origin) =>
    toResponse(byOrigin.get(origin) ?? { ...ZERO, origin }),
  );

  const summed = platforms.reduce(
    (acc, p) => ({
      sellers: acc.sellers + p.sellers,
      buyers: acc.buyers + p.buyers,
      created: acc.created + p.created,
      published: acc.published + p.published,
      paymentStarted: acc.paymentStarted + p.paymentStarted,
      protected: acc.protected + p.protected,
      delivered: acc.delivered + p.delivered,
      released: acc.released + p.released,
      disputed: acc.disputed + p.disputed,
      protectedVolume: acc.protectedVolume + BigInt(p.protectedVolumeKobo),
      releasedVolume: acc.releasedVolume + BigInt(p.releasedVolumeKobo),
      fees: acc.fees + BigInt(p.feesKobo),
    }),
    {
      sellers: 0,
      buyers: 0,
      created: 0,
      published: 0,
      paymentStarted: 0,
      protected: 0,
      delivered: 0,
      released: 0,
      disputed: 0,
      protectedVolume: 0n,
      releasedVolume: 0n,
      fees: 0n,
    },
  );

  const totals: PlatformMetricsResponse = {
    origin: 'ALL',
    sellers: summed.sellers,
    buyers: summed.buyers,
    created: summed.created,
    published: summed.published,
    paymentStarted: summed.paymentStarted,
    protected: summed.protected,
    delivered: summed.delivered,
    released: summed.released,
    disputed: summed.disputed,
    disputeRate: rate(BigInt(summed.disputed), BigInt(summed.protected)),
    protectedVolumeKobo: kobo(summed.protectedVolume),
    releasedVolumeKobo: kobo(summed.releasedVolume),
    feesKobo: kobo(summed.fees),
  };

  return { platforms, totals };
}
