/**
 * Transaction state machine — the money-critical core of Meduman.
 *
 * Pure and dependency-free: no HTTP, no Prisma runtime, no Paystack. It takes a
 * current state, an event, and a context snapshot and returns either the next
 * state or a typed rejection. All state ownership and every guard live here so a
 * bug that costs money has exactly one place to hide.
 */
export { RejectionReason } from './reasons';
export type { PaymentSource, TransactionEvent, TransactionEventType } from './events';
export type { TransactionContext } from './context';
export { transition, isTerminalState, TERMINAL_STATES, type TransitionResult } from './transition';
