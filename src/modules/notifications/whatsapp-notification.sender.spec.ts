import { Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import {
  OTP_TEMPLATE_KEY,
  type NotificationSender,
  type OutboundMessage,
} from './notification-sender';
import { UnroutablePhoneNumberError } from './phone';
import {
  WhatsAppNotificationSender,
  type WhatsAppSenderConfig,
} from './whatsapp-notification.sender';

const ACCESS_TOKEN = 'EAAG-super-secret-waba-token';
const CODE = '483920';

function makeSender(overrides: Partial<WhatsAppSenderConfig> = {}) {
  const fallbackSend = jest.fn().mockResolvedValue(undefined);
  const fallback = { send: fallbackSend } as unknown as NotificationSender;
  const sender = new WhatsAppNotificationSender(
    {
      accessToken: ACCESS_TOKEN,
      phoneNumberId: '109876543210',
      graphVersion: 'v21.0',
      otpTemplateName: 'meduman_otp',
      otpTemplateLang: 'en',
      otpTemplateHasButton: true,
      defaultCountryCode: '234',
      ...overrides,
    },
    fallback,
  );
  return { sender, fallbackSend };
}

function otpMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channel: NotificationChannel.SMS,
    to: '08031234567',
    templateKey: OTP_TEMPLATE_KEY,
    data: { code: CODE, transactionId: 'tx-1' },
    ...overrides,
  };
}

function okFetch() {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve('{}'),
  });
}

describe('WhatsAppNotificationSender.send', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('POSTs the authentication template to the Graph messages endpoint', async () => {
    const { sender } = makeSender();
    const fetchMock = okFetch();
    global.fetch = fetchMock;

    await sender.send(otpMessage());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/109876543210/messages');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      // Normalized to E.164 without the leading '+'.
      to: '2348031234567',
      type: 'template',
      template: {
        name: 'meduman_otp',
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: CODE }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: CODE }],
          },
        ],
      },
    });
  });

  it('carries the access token as a bearer header', async () => {
    const { sender } = makeSender();
    const fetchMock = okFetch();
    global.fetch = fetchMock;

    await sender.send(otpMessage());

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('omits the button component when the approved template has no OTP button', async () => {
    const { sender } = makeSender({ otpTemplateHasButton: false, otpTemplateLang: 'en_US' });
    const fetchMock = okFetch();
    global.fetch = fetchMock;

    await sender.send(otpMessage());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      template: { language: { code: string }; components: { type: string }[] };
    };
    expect(body.template.components).toHaveLength(1);
    expect(body.template.components[0]?.type).toBe('body');
    expect(body.template.language.code).toBe('en_US');
  });

  it('accepts every Nigerian input shape and always sends E.164 digits', async () => {
    const { sender } = makeSender();
    const fetchMock = okFetch();
    global.fetch = fetchMock;

    for (const to of ['08031234567', '+2348031234567', '2348031234567']) {
      await sender.send(otpMessage({ to }));
    }

    const sent = fetchMock.mock.calls.map(
      (call) => (JSON.parse(call[1].body as string) as { to: string }).to,
    );
    expect(sent).toEqual(['2348031234567', '2348031234567', '2348031234567']);
  });

  it('refuses an unnormalizable recipient without calling Graph', async () => {
    const { sender } = makeSender();
    const fetchMock = okFetch();
    global.fetch = fetchMock;

    await expect(sender.send(otpMessage({ to: 'not-a-phone' }))).rejects.toThrow(
      UnroutablePhoneNumberError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx Graph response so BullMQ retries', async () => {
    const { sender } = makeSender();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":{"message":"Invalid OAuth access token"}}'),
    });

    await expect(sender.send(otpMessage())).rejects.toThrow('WhatsApp OTP send failed: 401');
  });

  it('throws on a network failure so BullMQ retries', async () => {
    const { sender } = makeSender();
    global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed'));

    await expect(sender.send(otpMessage())).rejects.toThrow('WhatsApp OTP send failed (network)');
  });

  it('scrubs the code out of a Graph error body before throwing', async () => {
    const { sender } = makeSender();
    // Graph can echo request parameters back; a thrown message lands in BullMQ's
    // failedReason and in Sentry, so it must never carry a live code.
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve(`{"error":{"message":"bad param ${CODE}"}}`),
    });

    await expect(sender.send(otpMessage())).rejects.toThrow(/\[redacted\]/);
    const err = await sender.send(otpMessage()).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(CODE);
  });

  it('delegates non-OTP messages (invoice email) to the fallback transport', async () => {
    const { sender, fallbackSend } = makeSender();
    const fetchMock = okFetch();
    global.fetch = fetchMock;
    const email: OutboundMessage = {
      channel: NotificationChannel.EMAIL,
      to: 'buyer@example.com',
      templateKey: 'invoice.sent',
      data: { invoiceId: 'inv-1' },
    };

    await sender.send(email);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fallbackSend).toHaveBeenCalledWith(email);
  });

  it('refuses to send an OTP message that carries no code', async () => {
    const { sender } = makeSender();
    const fetchMock = okFetch();
    global.fetch = fetchMock;

    await expect(sender.send(otpMessage({ data: { transactionId: 'tx-1' } }))).rejects.toThrow(
      'carries no code',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WhatsAppNotificationSender secrecy', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  /** Capture every line written through the Nest logger, whatever the level. */
  function spyOnLogger() {
    const lines: unknown[][] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      const method = Logger.prototype[level] as unknown;
      if (typeof method !== 'function') continue;
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => void lines.push(args));
    }
    return lines;
  }

  it('never writes the plaintext code to the logger — success path', async () => {
    const { sender } = makeSender();
    global.fetch = okFetch();
    const lines = spyOnLogger();

    await sender.send(otpMessage());

    expect(lines.length).toBeGreaterThan(0); // it did log something...
    expect(JSON.stringify(lines)).not.toContain(CODE); // ...just never the code.
  });

  it('never writes the plaintext code (or the token) to the logger — failure paths', async () => {
    const { sender } = makeSender();
    const lines = spyOnLogger();

    global.fetch = jest.fn().mockRejectedValue(new Error(`boom ${CODE} ${ACCESS_TOKEN}`));
    await expect(sender.send(otpMessage())).rejects.toThrow();

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve(`server said ${CODE}`),
    });
    await expect(sender.send(otpMessage())).rejects.toThrow();

    const dump = JSON.stringify(lines);
    expect(dump).not.toContain(CODE);
    expect(dump).not.toContain(ACCESS_TOKEN);
  });

  it('never leaks the recipient unmasked', async () => {
    const { sender } = makeSender();
    global.fetch = okFetch();
    const lines = spyOnLogger();

    await sender.send(otpMessage());

    const dump = JSON.stringify(lines);
    expect(dump).not.toContain('2348031234567');
    expect(dump).toContain('4567');
  });
});
