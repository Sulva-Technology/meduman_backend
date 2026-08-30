import type { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import type { NotificationSender } from './notification-sender';
import { createNotificationSender } from './notification-sender.factory';
import { WhatsAppNotificationSender } from './whatsapp-notification.sender';

const FULL: Partial<Env> = {
  WHATSAPP_ACCESS_TOKEN: 'waba-token',
  WHATSAPP_PHONE_NUMBER_ID: '109876543210',
  WHATSAPP_OTP_TEMPLATE_NAME: 'meduman_otp',
  WHATSAPP_OTP_TEMPLATE_LANG: 'en',
  WHATSAPP_OTP_TEMPLATE_HAS_BUTTON: true,
  WHATSAPP_DEFAULT_COUNTRY_CODE: '234',
  META_GRAPH_VERSION: 'v21.0',
};

function makeConfig(env: Partial<Env>): ConfigService<Env, true> {
  return {
    get: (key: keyof Env) => env[key],
  } as unknown as ConfigService<Env, true>;
}

const fallback = { send: jest.fn() } as unknown as NotificationSender;

describe('createNotificationSender', () => {
  it('binds the WhatsApp transport when the whole credential set is present', () => {
    const sender = createNotificationSender(makeConfig(FULL), fallback);
    expect(sender).toBeInstanceOf(WhatsAppNotificationSender);
  });

  it.each([
    ['WHATSAPP_ACCESS_TOKEN'],
    ['WHATSAPP_PHONE_NUMBER_ID'],
    ['WHATSAPP_OTP_TEMPLATE_NAME'],
  ])('falls back to the log stub when %s is missing', (missing) => {
    const env = { ...FULL, [missing]: undefined };
    expect(createNotificationSender(makeConfig(env), fallback)).toBe(fallback);
  });

  it('falls back to the log stub in a completely unconfigured environment', () => {
    expect(createNotificationSender(makeConfig({}), fallback)).toBe(fallback);
  });
});
