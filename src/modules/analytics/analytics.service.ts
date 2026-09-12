import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { toPlatformAnalyticsResponse } from './analytics.mapper';
import type { PlatformAnalyticsResponse, PlatformMetrics } from './analytics.types';

/** The funnel stages, each probe matching a TimelineEvent.newState. */
const STAGE = {
  published: 'LINK_ACTIVE',
  paymentStarted: 'PAYMENT_PENDING',
  protectedState: 'PAYMENT_PROTECTED',
  delivered: 'CONFIRMATION_PENDING',
  released: 'COMPLETED',
  disputed: 'DISPUTED',
} as const;

/**
 * Platform activity analytics: which platform does what, as recorded facts.
 *
 * Read-only. Writes no state, moves no money, and therefore writes no audit row
 * (rule 6 covers state transitions and admin actions; a read is neither).
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One row per origin over the transactions CREATED in `[from, to)`.
   *
   * Cohort semantics: the range filters `Transaction.createdAt`, and a
   * transaction counts as having reached a stage if it EVER reached it, even
   * after `to`. That makes conversion a property of the cohort rather than of how
   * wide the window happens to be — which also means RECENT COHORTS LOOK WORSE,
   * because their transactions have had less time to convert. That is correct,
   * and the frontend must say so.
   */
  async getPlatformMetrics(from: Date, to: Date): Promise<PlatformAnalyticsResponse> {
    const rows = await this.prisma.$queryRaw<PlatformMetrics[]>(Prisma.sql`
      WITH cohort AS (
        SELECT id, origin, seller_id, buyer_id, amount, fee_amount
          FROM "transactions"
         WHERE "created_at" >= ${from} AND "created_at" < ${to}
      ),
      staged AS (
        SELECT
          c.origin,
          c.seller_id,
          c.buyer_id,
          c.amount,
          c.fee_amount,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.published}) AS published,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.paymentStarted}) AS payment_started,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.protectedState}) AS protected,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.delivered}) AS delivered,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.released}) AS released,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.disputed}) AS disputed
        FROM cohort c
      )
      SELECT
        s.origin::text                        AS "origin",
        COUNT(DISTINCT s.seller_id)           AS "sellers",
        COUNT(DISTINCT s.buyer_id)            AS "buyers",
        COUNT(*)                              AS "created",
        COUNT(*) FILTER (WHERE s.published)       AS "published",
        COUNT(*) FILTER (WHERE s.payment_started) AS "paymentStarted",
        COUNT(*) FILTER (WHERE s.protected)       AS "protected",
        COUNT(*) FILTER (WHERE s.delivered)       AS "delivered",
        COUNT(*) FILTER (WHERE s.released)        AS "released",
        COUNT(*) FILTER (WHERE s.disputed)        AS "disputed",
        COALESCE(SUM(s.amount)     FILTER (WHERE s.protected), 0) AS "protectedVolumeKobo",
        COALESCE(SUM(s.amount)     FILTER (WHERE s.released), 0)  AS "releasedVolumeKobo",
        COALESCE(SUM(s.fee_amount) FILTER (WHERE s.protected), 0) AS "feesKobo"
      FROM staged s
      GROUP BY s.origin
    `);

    const { platforms, totals } = toPlatformAnalyticsResponse(rows);
    return { from: from.toISOString(), to: to.toISOString(), platforms, totals };
  }
}
