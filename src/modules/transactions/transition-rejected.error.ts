import { ConflictException } from '@nestjs/common';
import type { RejectionReason } from './state-machine';

/**
 * Thrown when the state machine refuses a transition (or a concurrent write
 * lost the optimistic race). Carries the typed {@link RejectionReason} so
 * controllers can map it to a response without string matching. Extends
 * ConflictException (409) — the request is well-formed but not valid for the
 * transaction's current state.
 */
export class TransitionRejectedError extends ConflictException {
  constructor(
    public readonly reason: RejectionReason,
    message: string,
  ) {
    super({ statusCode: 409, error: 'TransitionRejected', reason, message });
    this.name = 'TransitionRejectedError';
  }
}
