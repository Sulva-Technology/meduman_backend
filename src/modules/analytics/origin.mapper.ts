import { ChatPlatform, TransactionOrigin } from '@prisma/client';

/**
 * Every origin, in a stable order. The endpoint zero-fills against this list so
 * the response shape is constant and a dashboard never has to special-case an
 * absent platform.
 */
export const ALL_ORIGINS: readonly TransactionOrigin[] = [
  TransactionOrigin.WEB,
  TransactionOrigin.TELEGRAM,
  TransactionOrigin.WHATSAPP,
  TransactionOrigin.INSTAGRAM,
  TransactionOrigin.MESSENGER,
  TransactionOrigin.X,
  TransactionOrigin.EAAS,
];

/**
 * The five chat platforms map to the origin of the same name.
 *
 * `Record<ChatPlatform, ...>` rather than a `switch` so the mapping is total by
 * construction: adding a ChatPlatform breaks the build here instead of falling
 * through to a wrong origin at runtime.
 */
const CHAT_ORIGIN: Record<ChatPlatform, TransactionOrigin> = {
  [ChatPlatform.TELEGRAM]: TransactionOrigin.TELEGRAM,
  [ChatPlatform.WHATSAPP]: TransactionOrigin.WHATSAPP,
  [ChatPlatform.INSTAGRAM]: TransactionOrigin.INSTAGRAM,
  [ChatPlatform.MESSENGER]: TransactionOrigin.MESSENGER,
  [ChatPlatform.X]: TransactionOrigin.X,
};

/** The origin a transaction created on this chat platform is recorded under. */
export function toTransactionOrigin(platform: ChatPlatform): TransactionOrigin {
  return CHAT_ORIGIN[platform];
}
