import * as Sentry from '@sentry/node';

/** True only when a non-empty DSN is configured. */
export function shouldEnableSentry(dsn?: string): boolean {
  return typeof dsn === 'string' && dsn.length > 0;
}

/**
 * Initialise Sentry error tracking. No-op (returns false) when no DSN is set, so
 * the same call is safe in every entrypoint (API/worker/cron) and in local dev.
 */
export function initSentry(opts: {
  dsn?: string | undefined;
  environment?: string | undefined;
}): boolean {
  if (!shouldEnableSentry(opts.dsn)) {
    return false;
  }
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment ?? 'development',
    // Error tracking only by default — no perf tracing overhead.
    tracesSampleRate: 0,
  });
  return true;
}
