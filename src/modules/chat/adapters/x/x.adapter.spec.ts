import { XAdapter } from './x.adapter';

describe('XAdapter (stub)', () => {
  const adapter = new XAdapter();

  it('fails signature verification closed (never processes an unverified event)', () => {
    expect(adapter.verifySignature(Buffer.from('{}'), {})).toBe(false);
  });

  it('parses nothing', () => {
    expect(adapter.parse({ anything: true })).toEqual([]);
  });

  it('rejects outbound send as not implemented', async () => {
    await expect(adapter.send('user', { text: 'hi' })).rejects.toThrow('not implemented');
  });
});
