import type { ReleaseRule } from '@prisma/client';

/**
 * A read-only snapshot of the facts the machine needs to evaluate guards.
 *
 * `import type` keeps this a compile-time-only reference to Prisma's enum — the
 * generated `ReleaseRule` is a string-literal union, so nothing from
 * `@prisma/client` survives into the runtime bundle. The state machine has zero
 * runtime dependency on Prisma.
 */
export interface TransactionContext {
  /** How the transaction becomes eligible for automated release. */
  releaseRule: ReleaseRule;
  /**
   * Whether a dispute that should freeze release is currently open on the
   * transaction. For a dispute-resolution event this must exclude the very
   * dispute being resolved and reflect only *other* still-open disputes.
   */
  hasOpenDispute: boolean;
  /** Whether the auto-confirm window has elapsed (only consulted for AUTO_CONFIRM). */
  autoConfirmWindowElapsed: boolean;
}
