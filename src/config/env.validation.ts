import { z } from 'zod';

/**
 * Runtime env schema. Fail fast at boot if anything required is missing.
 * Keep in sync with `.env.example`.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().min(1),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),

  // Database (two-URL Supabase config)
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),

  // JWT verification — support both strategies
  SUPABASE_JWT_STRATEGY: z.enum(['jwks', 'secret']).default('jwks'),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_JWT_ISSUER: z.string().optional(),
  SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),

  // Storage
  SUPABASE_STORAGE_BUCKET: z.string().default('evidence'),
  SUPABASE_SIGNED_URL_TTL: z.coerce.number().int().positive().default(300),

  // Paystack
  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_PUBLIC_KEY: z.string().min(1),
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  /// Platform's percentage cut on a seller subaccount's settlements (0–100).
  PAYSTACK_SUBACCOUNT_PERCENTAGE_CHARGE: z.coerce.number().min(0).max(100).default(0),

  // Redis / BullMQ
  REDIS_URL: z.string().min(1),
  REDIS_TLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  QUEUE_PREFIX: z.string().default('meduman'),

  // Business config
  AUTO_RELEASE_WINDOW_HOURS: z.coerce.number().int().positive().default(72),
  OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  // Server-side key for the OTP HMAC hash. Required — a plain digest of a
  // short numeric code is trivially brute-forced from a DB leak.
  OTP_HASH_SECRET: z.string().min(16),
  // Max wrong guesses before a code locks (single-use, attempt-capped).
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Server-side key for EAAS API-key hash. Keys tenant API credentials.
  EAAS_API_KEY_SECRET: z.string().min(16),
  // Server-side key for EAAS webhook signing (AES-GCM secret encryption).
  EAAS_WEBHOOK_SIGNING_KEY: z.string().min(32),
  // Timeout per webhook delivery attempt (milliseconds).
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Max delivery retries per webhook.
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Reject signed-but-stale webhook replays whose payload timestamp is older than
  // this. Generous by default (24h) — Paystack legitimately retries over hours;
  // the providerEventId unique guard handles exact-duplicate retries. Backstop only.
  WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(86_400),

  // Observability — Sentry error tracking. Optional: absent = disabled (no-op).
  SENTRY_DSN: z.string().url().optional(),

  // Chat-native bot gateway
  // Telegram adapter registers ONLY when a token is present, so a deploy without
  // chat configured still boots cleanly. The webhook secret is required whenever
  // the token is set (enforced as a cross-field check below).
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  /// Domain for synthetic chat-user emails (chat+<platform>-<id>@<domain>). A
  /// chat user may have no real email; Supabase Auth still requires one.
  CHAT_IDENTITY_EMAIL_DOMAIN: z.string().min(1).default('chat.meduman.local'),
  /// How long a dialog session stays live between messages.
  CHAT_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),

  // Meta chat surfaces (WhatsApp / Instagram / Messenger). One Graph app secret +
  // verify token cover all three; each platform additionally needs its own
  // access token + sender id. A platform whose set is incomplete is simply not
  // registered — no boot failure.
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v21.0'),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  // Real OTP transport (WhatsApp Cloud API). Business-initiated messages outside
  // the 24h service window must use a PRE-APPROVED template, so the transport is
  // bound only when the template name is configured alongside the credentials
  // above; anything less falls back to the log stub (see NotificationsModule).
  WHATSAPP_OTP_TEMPLATE_NAME: z.string().optional(),
  WHATSAPP_OTP_TEMPLATE_LANG: z.string().default('en'),
  /// Authentication templates carry an OTP (copy-code / one-tap) button and the
  /// code must be repeated in its parameter. Set false only for a template
  /// without a button.
  WHATSAPP_OTP_TEMPLATE_HAS_BUTTON: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /// Country code assumed when a stored number is in national form (`0803...`).
  WHATSAPP_DEFAULT_COUNTRY_CODE: z
    .string()
    .regex(/^[1-9]\d{0,2}$/, 'must be 1-3 digits, no leading zero')
    .default('234'),
  MESSENGER_PAGE_ACCESS_TOKEN: z.string().optional(),
  MESSENGER_PAGE_ID: z.string().optional(),
  INSTAGRAM_ACCESS_TOKEN: z.string().optional(),
  INSTAGRAM_ACCOUNT_ID: z.string().optional(),

  // X (Twitter) DMs — slice 3 stub. Flip on only to register the placeholder
  // adapter; it fails closed until the Account Activity integration is built.
  X_ADAPTER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Cross-field checks that Zod's object schema can't express inline.
 * Enforces the correct secret is present for the selected JWT strategy.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  const env = parsed.data;
  if (env.SUPABASE_JWT_STRATEGY === 'jwks' && !env.SUPABASE_JWKS_URL) {
    throw new Error('SUPABASE_JWKS_URL is required when SUPABASE_JWT_STRATEGY=jwks');
  }
  if (env.SUPABASE_JWT_STRATEGY === 'secret' && !env.SUPABASE_JWT_SECRET) {
    throw new Error('SUPABASE_JWT_SECRET is required when SUPABASE_JWT_STRATEGY=secret');
  }
  // A Telegram webhook with no shared secret would accept forged updates.
  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is set');
  }
  return env;
}
