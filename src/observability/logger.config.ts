import type { Env } from '@/config/env.validation';

/**
 * Fields scrubbed from every log line (money-safety §2 — never log secrets/PII).
 * Wildcards catch OTP codes / hashes wherever they appear one level deep.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-paystack-signature"]',
  'res.headers["set-cookie"]',
  '*.code',
  '*.codeHash',
  '*.authorization',
];

/**
 * nestjs-pino config: structured JSON logs keyed off LOG_LEVEL, with redaction.
 * Pulled out as a pure builder so the level mapping + redaction list are unit-
 * testable without booting Nest.
 */
export function buildLoggerConfig(env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>) {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      // A correlation id per request; pino-http generates one when absent.
      autoLogging: true,
    },
  };
}
