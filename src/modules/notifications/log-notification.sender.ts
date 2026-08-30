import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import type { NotificationSender, OutboundMessage } from './notification-sender';
import { maskRecipient } from './phone';

/**
 * Default no-op transport: logs that a message was dispatched instead of hitting
 * a real provider (no SMS/WhatsApp creds required to run). In non-production it
 * also logs the OTP `code` so dev/e2e can complete the flow; in production the
 * code is NEVER logged. Swap this binding for a real provider before launch.
 */
@Injectable()
export class LogNotificationSender implements NotificationSender {
  private readonly logger = new Logger(LogNotificationSender.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  send(message: OutboundMessage): Promise<void> {
    const isProd = this.config.get('NODE_ENV', { infer: true }) === 'production';
    const code = message.data.code;
    const codeText = typeof code === 'string' || typeof code === 'number' ? String(code) : '';
    const codePart = !isProd && codeText ? ` code=${codeText}` : '';
    this.logger.log(
      `[stub ${message.channel}] -> ${maskRecipient(message.to)} template=${message.templateKey}${codePart}`,
    );
    return Promise.resolve();
  }
}
