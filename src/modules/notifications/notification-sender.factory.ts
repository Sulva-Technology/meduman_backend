import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import type { NotificationSender } from './notification-sender';
import { WhatsAppNotificationSender } from './whatsapp-notification.sender';

const logger = new Logger('NotificationSenderFactory');

/**
 * Choose the transport bound to NOTIFICATION_SENDER. The WhatsApp Cloud API is
 * used only when its full credential set is present — access token, phone-number
 * id and an approved template name — mirroring how ChatModule registers a chat
 * adapter. Anything short of that falls back to the log stub, so an unconfigured
 * environment (CI, e2e, a fresh dev box) behaves exactly as before.
 */
export function createNotificationSender(
  config: ConfigService<Env, true>,
  fallback: NotificationSender,
): NotificationSender {
  const accessToken = config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
  const phoneNumberId = config.get('WHATSAPP_PHONE_NUMBER_ID', { infer: true });
  const otpTemplateName = config.get('WHATSAPP_OTP_TEMPLATE_NAME', { infer: true });

  if (!accessToken || !phoneNumberId || !otpTemplateName) {
    // Half-set CREDENTIALS are almost always a deploy mistake — say so, without
    // ever echoing a value. (A template name on its own is inert, so it is not
    // treated as intent: test/dev envs carry one with no credentials.)
    if (accessToken || phoneNumberId) {
      logger.warn(
        'WhatsApp OTP transport NOT enabled — WHATSAPP_ACCESS_TOKEN, ' +
          'WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_OTP_TEMPLATE_NAME must ALL be set. ' +
          'Falling back to the log stub: OTP codes will not be delivered.',
      );
    }
    return fallback;
  }

  logger.log(`WhatsApp OTP transport enabled (template ${otpTemplateName})`);
  return new WhatsAppNotificationSender(
    {
      accessToken,
      phoneNumberId,
      graphVersion: config.get('META_GRAPH_VERSION', { infer: true }),
      otpTemplateName,
      otpTemplateLang: config.get('WHATSAPP_OTP_TEMPLATE_LANG', { infer: true }),
      otpTemplateHasButton: config.get('WHATSAPP_OTP_TEMPLATE_HAS_BUTTON', { infer: true }),
      defaultCountryCode: config.get('WHATSAPP_DEFAULT_COUNTRY_CODE', { infer: true }),
    },
    fallback,
  );
}
