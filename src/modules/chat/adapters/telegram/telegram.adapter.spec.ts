import { TelegramAdapter } from './telegram.adapter';

const SECRET = 'super-secret-token';

function makeAdapter() {
  return new TelegramAdapter('bot-token', SECRET);
}

describe('TelegramAdapter.verifySignature', () => {
  it('accepts the matching secret header', () => {
    const adapter = makeAdapter();
    expect(
      adapter.verifySignature(Buffer.from('{}'), { 'x-telegram-bot-api-secret-token': SECRET }),
    ).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const adapter = makeAdapter();
    expect(
      adapter.verifySignature(Buffer.from('{}'), { 'x-telegram-bot-api-secret-token': 'nope' }),
    ).toBe(false);
  });

  it('rejects a missing header', () => {
    const adapter = makeAdapter();
    expect(adapter.verifySignature(Buffer.from('{}'), {})).toBe(false);
  });
});

describe('TelegramAdapter.parse', () => {
  it('parses a text message', () => {
    const adapter = makeAdapter();
    const out = adapter.parse({
      update_id: 42,
      message: { text: '/sell', chat: { id: 12345 }, from: { first_name: 'Ada' } },
    });
    expect(out).toEqual([
      {
        platform: 'TELEGRAM',
        providerMessageId: 'msg:42',
        from: '12345',
        displayName: 'Ada',
        text: '/sell',
      },
    ]);
  });

  it('parses a button tap (callback_query) into a payload', () => {
    const adapter = makeAdapter();
    const out = adapter.parse({
      update_id: 43,
      callback_query: { id: 'cb1', data: 'CONFIRM', message: { chat: { id: 777 } } },
    });
    expect(out[0]).toMatchObject({
      providerMessageId: 'cbq:cb1',
      from: '777',
      payload: 'CONFIRM',
    });
  });

  it('returns nothing for an update with no message or callback', () => {
    const adapter = makeAdapter();
    expect(adapter.parse({ update_id: 44 })).toEqual([]);
    expect(adapter.parse({})).toEqual([]);
  });

  it('parses a photo (largest size) with its caption as text', () => {
    const adapter = makeAdapter();
    const out = adapter.parse({
      update_id: 50,
      message: {
        caption: 'broken item',
        chat: { id: 5 },
        photo: [
          { file_id: 'small', file_size: 100 },
          { file_id: 'large', file_size: 9000 },
        ],
      },
    });
    expect(out[0]).toMatchObject({
      providerMessageId: 'msg:50',
      from: '5',
      text: 'broken item',
      media: [{ id: 'large', mimeType: 'image/jpeg' }],
    });
  });

  it('parses a document with its mime type and filename', () => {
    const adapter = makeAdapter();
    const out = adapter.parse({
      update_id: 51,
      message: {
        chat: { id: 5 },
        document: { file_id: 'doc1', mime_type: 'application/pdf', file_name: 'receipt.pdf' },
      },
    });
    expect(out[0]?.media).toEqual([
      { id: 'doc1', mimeType: 'application/pdf', filename: 'receipt.pdf' },
    ]);
  });
});

describe('TelegramAdapter.downloadMedia', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('resolves a file_id via getFile then downloads the bytes', async () => {
    const adapter = makeAdapter();
    const fetchMock = jest
      .fn()
      // getFile
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { file_path: 'photos/f.jpg' } }),
      })
      // file download
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      });
    global.fetch = fetchMock;

    const out = await adapter.downloadMedia({ id: 'file-1', mimeType: 'image/jpeg' });

    expect(fetchMock.mock.calls[0][0]).toContain('/getFile?file_id=file-1');
    expect(fetchMock.mock.calls[1][0]).toContain('/file/botbot-token/photos/f.jpg');
    expect(out.mimeType).toBe('image/jpeg');
    expect(out.buffer).toEqual(Buffer.from([1, 2, 3]));
  });

  it('throws when getFile has no file_path', async () => {
    const adapter = makeAdapter();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: {} }),
    }) as never;
    await expect(adapter.downloadMedia({ id: 'x' })).rejects.toThrow('no file_path');
  });
});
