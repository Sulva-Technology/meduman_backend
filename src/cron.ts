import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AutoReleaseService } from './modules/transactions/auto-release.service';
import { InvoicesService } from './modules/invoices/invoices.service';
import { OutboundEventRelay } from './modules/merchants/outbound-event-relay.service';
import { initSentry } from './observability/sentry';

/**
 * Cron entrypoint (Render cron service). Runs once per invocation, then exits.
 * Scans AUTO_AFTER_WINDOW transactions whose confirmation window has elapsed and
 * enqueues their release (never releases inline). Safe to run repeatedly — the
 * machine + payout idempotency make a double tick a no-op.
 */
async function bootstrapCron(): Promise<void> {
  initSentry({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  const logger = app.get(PinoLogger);
  try {
    logger.log('Cron tick started — scanning for auto-release');
    const { released } = await app.get(AutoReleaseService).scanAndRelease();
    logger.log(`Auto-release scan complete — ${released} release job(s) enqueued`);

    logger.log('Scanning for overdue invoices');
    const overdue = await app.get(InvoicesService).scanOverdue();
    logger.log(`Overdue scan complete — ${overdue} invoice(s) marked OVERDUE`);

    logger.log('Relaying stranded outbound webhook events');
    const redispatched = await app.get(OutboundEventRelay).redispatchPending();
    logger.log(`Outbound relay complete — ${redispatched} event(s) re-enqueued`);
  } finally {
    await app.close();
  }
}

void bootstrapCron();
