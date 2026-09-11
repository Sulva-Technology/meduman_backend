import type { MergeCollisionKind } from './account-merge.service';

/** A hard collision — the merge is refused and parked for an admin. */
export class LinkMergeCollisionError extends Error {
  constructor(readonly kind: MergeCollisionKind) {
    super(`Account merge refused: ${kind}`);
    this.name = 'LinkMergeCollisionError';
  }
}

/**
 * Transient — a payout may be mid-send. The merge wrote nothing and the caller
 * leaves the code unconsumed so the user can retry.
 */
export class LinkMergeInFlightError extends Error {
  constructor() {
    super('Account merge refused: a payout is in flight');
    this.name = 'LinkMergeInFlightError';
  }
}
