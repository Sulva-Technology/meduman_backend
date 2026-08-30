import { createHmac } from 'node:crypto';
import { ChatPlatform } from '@prisma/client';
import { MetaAdapter, type MetaAdapterConfig } from './meta.adapter';

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'verify-me';

function makeAdapter(overrides: Partial<MetaAdapterConfig> = {}) {
  return new MetaAdapter({
    platform: ChatPlatform.WHATSAPP,
    product: 'whatsapp',
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    accessToken: 'token',
    senderId: '100',
    graphVersion: 'v21.0',
    ...overrides,
  });
}

function sign(raw: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(Buffer.from(raw)).digest('hex');
}

describe('MetaAdapter.verifySignature', () => {
  it('accepts a correct X-Hub-Signature-256', () => {
    const adapter = makeAdapter();
    const raw = '{"hello":"world"}';
    expect(adapter.verifySignature(Buffer.from(raw), { 'x-hub-signature-256': sign(raw) })).toBe(
      true,
    );
  });

  it('rejects a tampered body', () => {
    const adapter = makeAdapter();
    expect(
      adapter.verifySignature(Buffer.from('{"hello":"evil"}'), {
        'x-hub-signature-256': sign('{"hello":"world"}'),
      }),
    ).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    const adapter = makeAdapter();
    expect(adapter.verifySignature(Buffer.from('{}'), {})).toBe(false);
    expect(adapter.verifySignature(Buffer.from('{}'), { 'x-hub-signature-256': 'nope' })).toBe(
      false,
    );
  });
});

describe('MetaAdapter.verifyChallenge', () => {
  it('echoes the challenge when the verify token matches', () => {
    const adapter = makeAdapter();
    expect(
      adapter.verifyChallenge({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '12345',
      }),
    ).toBe('12345');
  });

  it('rejects a wrong verify token', () => {
    const adapter = makeAdapter();
    expect(
      adapter.verifyChallenge({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': '12345',
      }),
    ).toBeNull();
  });
});

describe('MetaAdapter.parse (WhatsApp Cloud API shape)', () => {
  it('parses a text message with the contact name', () => {
    const adapter = makeAdapter();
    const out = adapter.parse({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: 'Ada' } }],
                messages: [{ id: 'wamid.1', from: '2348012345678', text: { body: '/help' } }],
              },
            },
          ],
        },
      ],
    });
    expect(out).toEqual([
      {
        platform: ChatPlatform.WHATSAPP,
        providerMessageId: 'wamid.1',
        from: '2348012345678',
        displayName: 'Ada',
        text: '/help',
      },
    ]);
  });

  it('parses an interactive button reply into a payload', () => {
    const adapter = makeAdapter();
    const out = adapter.parse({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'wamid.2', from: '234', interactive: { button_reply: { id: 'CONFIRM' } } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(out[0]).toMatchObject({ providerMessageId: 'wamid.2', payload: 'CONFIRM' });
  });

  it('parses an image (id + caption) into media', () => {
    const adapter = makeAdapter();
    const out = adapter.parse({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.3',
                    from: '234',
                    image: { id: 'media-9', mime_type: 'image/jpeg', caption: 'proof' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(out[0]).toMatchObject({
      providerMessageId: 'wamid.3',
      text: 'proof',
      media: [{ id: 'media-9', mimeType: 'image/jpeg' }],
    });
  });
});

describe('MetaAdapter media', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('parses a Messenger attachment url into media', () => {
    const adapter = makeAdapter({ platform: ChatPlatform.MESSENGER, product: 'messenger' });
    const out = adapter.parse({
      entry: [
        {
          messaging: [
            {
              sender: { id: 'psid-1' },
              message: {
                mid: 'm.9',
                attachments: [{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }],
              },
            },
          ],
        },
      ],
    });
    expect(out[0]?.media).toEqual([{ id: 'https://cdn/x.jpg', url: 'https://cdn/x.jpg' }]);
  });

  it('downloadMedia resolves a WhatsApp id to a url then fetches the bytes', async () => {
    const adapter = makeAdapter();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ url: 'https://lookaside/x' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/png' },
        arrayBuffer: () => Promise.resolve(new Uint8Array([9, 9]).buffer),
      });
    global.fetch = fetchMock;

    const out = await adapter.downloadMedia({ id: 'media-9' });

    expect(fetchMock.mock.calls[0][0]).toContain('/media-9');
    expect(fetchMock.mock.calls[1][0]).toBe('https://lookaside/x');
    expect(out.buffer).toEqual(Buffer.from([9, 9]));
    expect(out.mimeType).toBe('image/png');
  });

  it('downloadMedia fetches a Messenger url directly', async () => {
    const adapter = makeAdapter({ platform: ChatPlatform.MESSENGER, product: 'messenger' });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });
    global.fetch = fetchMock;

    const out = await adapter.downloadMedia({ id: 'https://cdn/x.jpg', url: 'https://cdn/x.jpg' });

    // No id-resolution hop — one fetch, straight to the url.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.buffer).toEqual(Buffer.from([1]));
  });
});

describe('MetaAdapter.parse (Messenger / Instagram Send API shape)', () => {
  it('parses a Messenger text event', () => {
    const adapter = makeAdapter({ platform: ChatPlatform.MESSENGER, product: 'messenger' });
    const out = adapter.parse({
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'm.1', text: 'hi' } }] }],
    });
    expect(out).toEqual([
      { platform: ChatPlatform.MESSENGER, providerMessageId: 'm.1', from: 'psid-1', text: 'hi' },
    ]);
  });

  it('parses a postback payload', () => {
    const adapter = makeAdapter({ platform: ChatPlatform.INSTAGRAM, product: 'messenger' });
    const out = adapter.parse({
      entry: [
        { messaging: [{ sender: { id: 'ig-1' }, postback: { mid: 'p.1', payload: 'PAY' } }] },
      ],
    });
    expect(out[0]).toMatchObject({
      platform: ChatPlatform.INSTAGRAM,
      from: 'ig-1',
      payload: 'PAY',
    });
  });

  it('returns nothing for an empty body', () => {
    const adapter = makeAdapter();
    expect(adapter.parse({})).toEqual([]);
  });
});
