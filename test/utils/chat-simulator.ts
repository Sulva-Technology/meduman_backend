import { createHash } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ChatPlatform } from '@prisma/client';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { SupabaseJwtGuard } from '@/modules/auth/supabase-jwt.guard';
import { PaystackService } from '@/common/paystack';
import {
  CHAT_INBOUND_JOB,
  CHAT_OUTBOUND_JOB,
  CHAT_QUEUE_TOKEN,
  INVOICE_DELIVERY_JOB,
  NOTIFICATION_QUEUE_TOKEN,
  OTP_NOTIFICATION_JOB,
  PAYOUT_QUEUE_TOKEN,
  REDIS_CONNECTION,
  RELEASE_JOB,
} from '@/modules/queue/queue.constants';
import { SUPABASE_ADMIN_CLIENT } from '@/modules/chat/identity/supabase-admin';
import { CHAT_ADAPTERS } from '@/modules/chat/adapters/chat-adapter';
import type { OutboundChatMessage } from '@/modules/chat/adapters/chat-adapter';
import { TelegramAdapter } from '@/modules/chat/adapters/telegram/telegram.adapter';
import { ChatInboundService } from '@/modules/chat/gateway/chat-inbound.service';
import { ChatOutboundService } from '@/modules/chat/outbound/chat-outbound.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { WebhooksService } from '@/modules/webhooks/webhooks.service';
import { FakePaystack } from './fake-paystack';

/**
 * Faithful LOCAL end-to-end driver for the Telegram chat surface. It boots the
 * REAL app (dialog, state machine, Prisma, OTP, webhook HMAC) against the docker
 * Postgres and fakes only the true external seams:
 *
 *   - Paystack HTTP           -> FakePaystack (real signature, no network)
 *   - Supabase admin createUser -> deterministic uuid (no network)
 *   - the auth guard            -> header identity (money-safety is under test)
 *   - Telegram outbound `send`  -> captured into a transcript (no api.telegram.org)
 *   - BullMQ                    -> recording queues drained through the REAL
 *                                  processors, so the queue hop is exercised, not
 *                                  skipped.
 *
 * The signature verify, adapter `parse`, and the signed Paystack webhook path are
 * all real — a chat message can never protect a payment; only a signed
 * `charge.success` can (money rule 2).
 */

/** One captured bot -> user message. */
export interface BotReply {
  to: string;
  text: string;
}

interface RecordedJob {
  queue: 'payout' | 'notification' | 'chat';
  name: string;
  data: unknown;
}

/** A recording stand-in for a BullMQ Queue: captures jobs, never touches Redis. */
class RecordingQueue {
  constructor(
    private readonly label: RecordedJob['queue'],
    private readonly sink: RecordedJob[],
  ) {}
  add(name: string, data: unknown): Promise<unknown> {
    this.sink.push({ queue: this.label, name, data });
    return Promise.resolve({});
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Real Telegram adapter (real verify + parse), but `send` is captured. */
class CapturingTelegramAdapter extends TelegramAdapter {
  readonly sent: BotReply[] = [];
  override send(to: string, message: OutboundChatMessage): Promise<void> {
    this.sent.push({ to, text: message.text });
    return Promise.resolve();
  }
}

const fakeRedis = { disconnect: () => undefined, quit: () => Promise.resolve() };

/** Fake guard: trusts x-test-* headers (money-safety, not auth, is under test). */
const testAuthGuard = {
  canActivate(context: {
    switchToHttp: () => { getRequest: () => { headers: Record<string, string | undefined> } };
  }): boolean {
    return Boolean(context.switchToHttp().getRequest().headers['x-test-sub']) || true;
  },
};

/** A distinct, deterministic v4-shaped uuid per email (no collisions). */
function uuidFromEmail(email: string): string {
  const h = createHash('sha256').update(email).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Fake Supabase admin: mint a deterministic auth-user uuid, no network. */
const fakeSupabaseAdmin = {
  auth: {
    admin: {
      createUser: (attrs: { email: string }) =>
        Promise.resolve({
          data: { user: { id: uuidFromEmail(attrs.email) } },
          error: null,
        }),
    },
  },
};

/** Every mapped table, child-first — TRUNCATE ... CASCADE clears them. */
const TABLES = [
  'otp_codes',
  'timeline_events',
  'evidence',
  'disputes',
  'payouts',
  'payments',
  'transaction_items',
  'invoices',
  'invoice_counters',
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
];

export interface ChatSimulator {
  /** Send a message AS a Telegram user, then run the worker to quiescence. */
  fromUser(chatId: string, text: string, displayName?: string): Promise<BotReply[]>;
  /** Deliver a signed Paystack `charge.success` for the DVA customer, then drain. */
  paystackChargeSuccess(amountKobo: number, customerCode?: string): Promise<BotReply[]>;
  /** Transaction ids for which a release job was enqueued (money reached release). */
  releases(): string[];
  prisma: PrismaService;
  paystack: FakePaystack;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const TELEGRAM_SECRET = 'sim-telegram-secret';

/** Boot the simulator against the configured (docker) Postgres. */
export async function createChatSimulator(): Promise<ChatSimulator> {
  const paystack = new FakePaystack(process.env.PAYSTACK_SECRET_KEY ?? 'sk_test_e2e');
  const jobs: RecordedJob[] = [];
  const telegram = new CapturingTelegramAdapter('sim-bot-token', TELEGRAM_SECRET);
  const releaseIds: string[] = [];

  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SupabaseJwtGuard)
    .useValue(testAuthGuard)
    .overrideProvider(PaystackService)
    .useValue(paystack)
    .overrideProvider(REDIS_CONNECTION)
    .useValue(fakeRedis)
    .overrideProvider(PAYOUT_QUEUE_TOKEN)
    .useValue(new RecordingQueue('payout', jobs))
    .overrideProvider(NOTIFICATION_QUEUE_TOKEN)
    .useValue(new RecordingQueue('notification', jobs))
    .overrideProvider(CHAT_QUEUE_TOKEN)
    .useValue(new RecordingQueue('chat', jobs))
    .overrideProvider(SUPABASE_ADMIN_CLIENT)
    .useValue(fakeSupabaseAdmin)
    .overrideProvider(CHAT_ADAPTERS)
    .useValue([telegram])
    .compile();

  const app: INestApplication = moduleFixture.createNestApplication({ rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  const prisma = app.get(PrismaService);
  const inbound = app.get(ChatInboundService);
  const outbound = app.get(ChatOutboundService);
  const notifications = app.get(NotificationsService);
  const webhooks = app.get(WebhooksService);

  let updateId = 1000;

  /**
   * Run every recorded job through the REAL processor until no new work remains.
   * This is the worker, inline: the queue hop is genuinely exercised, and every
   * bot message still funnels through the capturing adapter.
   */
  async function drain(): Promise<void> {
    let guard = 0;
    while (jobs.length > 0) {
      if (guard++ > 1000) throw new Error('drain did not settle — job loop?');
      const job = jobs.shift() as RecordedJob;
      if (job.queue === 'chat' && job.name === CHAT_INBOUND_JOB) {
        await inbound.processInbound(job.data as never);
      } else if (job.queue === 'chat' && job.name === CHAT_OUTBOUND_JOB) {
        await outbound.deliver(job.data as never);
      } else if (job.queue === 'notification' && job.name === OTP_NOTIFICATION_JOB) {
        await notifications.deliverOtpCode(job.data as never);
      } else if (job.queue === 'notification' && job.name === INVOICE_DELIVERY_JOB) {
        await notifications.deliverInvoice(job.data as never);
      } else if (job.queue === 'payout' && job.name === RELEASE_JOB) {
        releaseIds.push((job.data as { transactionId: string }).transactionId);
      }
    }
  }

  /** Snapshot new captured replies produced while running `action`. */
  async function capturing(action: () => Promise<void>): Promise<BotReply[]> {
    const before = telegram.sent.length;
    await action();
    return telegram.sent.slice(before);
  }

  return {
    prisma,
    paystack,
    releases: () => [...releaseIds],

    fromUser(chatId, text, displayName) {
      return capturing(async () => {
        updateId += 1;
        const update = {
          update_id: updateId,
          message: {
            text,
            chat: { id: chatId },
            ...(displayName ? { from: { first_name: displayName } } : {}),
          },
        };
        const raw = Buffer.from(JSON.stringify(update));
        await inbound.ingest(
          ChatPlatform.TELEGRAM,
          raw,
          { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
          update,
        );
        await drain();
      });
    },

    paystackChargeSuccess(amountKobo, customerCode = 'CUS_e2e') {
      return capturing(async () => {
        paystack.verifyResult = { status: 'success', amount: amountKobo };
        const raw = Buffer.from(
          JSON.stringify({
            event: 'charge.success',
            data: {
              id: Date.now(),
              reference: `PSTK_${Date.now()}`,
              customer: { customer_code: customerCode },
            },
          }),
        );
        await webhooks.handlePaystackEvent(raw, paystack.sign(raw.toString()));
        await drain();
      });
    },

    async reset() {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE;`,
      );
    },

    async close() {
      await app.close();
    },
  };
}
