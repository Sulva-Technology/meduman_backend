import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { SupabaseJwtGuard } from '@/modules/auth/supabase-jwt.guard';
import { PaystackService } from '@/common/paystack';
import {
  CHAT_QUEUE_TOKEN,
  NOTIFICATION_QUEUE_TOKEN,
  PAYOUT_QUEUE_TOKEN,
  REDIS_CONNECTION,
  WEBHOOK_OUT_QUEUE_TOKEN,
} from '@/modules/queue/queue.constants';
import { SUPABASE_ADMIN_CLIENT } from '@/modules/chat/identity/supabase-admin';
import { FakePaystack } from './fake-paystack';

/** Fake guard: trusts the x-test-* headers. Money-safety, not auth, is under test. */
const testAuthGuard = {
  canActivate(context: {
    switchToHttp: () => {
      getRequest: () => { headers: Record<string, string | undefined>; user?: unknown };
    };
  }): boolean {
    const req = context.switchToHttp().getRequest();
    const sub = req.headers['x-test-sub'];
    if (sub) {
      req.user = {
        sub,
        email: req.headers['x-test-email'],
        role: 'authenticated',
        appRole: req.headers['x-test-role'],
        raw: { sub },
      };
    }
    return true;
  },
};

const fakeQueue = { add: () => Promise.resolve({}), close: () => Promise.resolve() };
const fakeRedis = { disconnect: () => undefined, quit: () => Promise.resolve() };

/** Fake Supabase admin: mint a deterministic auth user id, no network. */
const fakeSupabaseAdmin = {
  auth: {
    admin: {
      createUser: (attrs: { email: string }) =>
        Promise.resolve({
          data: {
            user: {
              // Deterministic uuid derived from the synthetic email keeps tests stable.
              id: `00000000-0000-4000-8000-${Buffer.from(attrs.email).toString('hex').slice(0, 12).padEnd(12, '0')}`,
            },
          },
          error: null,
        }),
    },
  },
};

/** Every mapped table, child-first — TRUNCATE ... CASCADE clears them between tests. */
const TABLES = [
  'otp_codes',
  'timeline_events',
  'evidence',
  'disputes',
  'payouts',
  'payments',
  'transaction_items',
  'transactions',
  'notifications',
  'audit_logs',
  'webhook_events',
  'chat_sessions',
  'chat_identities',
  'chat_inbound_events',
  'seller_profiles',
  'profiles',
  'users',
  'admin_users',
  'waitlist_entries',
  'merchant_api_keys',
  // Slice 2 outbound-webhooks tables — child-first, before merchants (FK).
  'outbound_events',
  'webhook_endpoints',
  'merchants',
];

export interface MoneyE2EContext {
  app: INestApplication;
  prisma: PrismaService;
  paystack: FakePaystack;
  reset: () => Promise<void>;
  seedUser: (id: string, opts?: { email?: string; phone?: string }) => Promise<void>;
  /** Onboard a seller payout destination — without one, no transfer can be sent. */
  seedSellerRecipient: (userId: string, recipientCode?: string) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Boot the full app against a REAL database, with only the external seams faked:
 * Paystack (no network), the auth guard (header identity), and the BullMQ/Redis
 * providers (so the specs need Postgres only — no Redis). Everything else — the
 * state machine, Prisma writes, audit log — is exercised for real.
 */
export async function createMoneyE2EApp(paystackSecret: string): Promise<MoneyE2EContext> {
  const paystack = new FakePaystack(paystackSecret);

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    // overrideProvider, not overrideGuard: the guard is bound globally through
    // APP_GUARD, and only a provider-token override reaches that binding.
    .overrideProvider(SupabaseJwtGuard)
    .useValue(testAuthGuard)
    .overrideProvider(PaystackService)
    .useValue(paystack)
    .overrideProvider(REDIS_CONNECTION)
    .useValue(fakeRedis)
    .overrideProvider(PAYOUT_QUEUE_TOKEN)
    .useValue(fakeQueue)
    .overrideProvider(NOTIFICATION_QUEUE_TOKEN)
    .useValue(fakeQueue)
    .overrideProvider(CHAT_QUEUE_TOKEN)
    .useValue(fakeQueue)
    .overrideProvider(WEBHOOK_OUT_QUEUE_TOKEN)
    .useValue(fakeQueue)
    .overrideProvider(SUPABASE_ADMIN_CLIENT)
    .useValue(fakeSupabaseAdmin)
    .compile();

  const app = moduleFixture.createNestApplication({ rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  const prisma = app.get(PrismaService);

  const reset = async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE;`,
    );
  };

  const seedUser = async (
    id: string,
    opts: { email?: string; phone?: string } = {},
  ): Promise<void> => {
    await prisma.user.create({
      data: {
        id,
        email: opts.email ?? `${id}@e2e.test`,
        ...(opts.phone ? { phone: opts.phone } : {}),
      },
    });
  };

  const seedSellerRecipient = async (
    userId: string,
    recipientCode = 'RCP_e2e_seller',
  ): Promise<void> => {
    await prisma.sellerProfile.create({
      data: { userId, providerRecipientCode: recipientCode, settlementBankVerified: true },
    });
  };

  const close = async (): Promise<void> => {
    await app.close();
  };

  return { app, prisma, paystack, reset, seedUser, seedSellerRecipient, close };
}
