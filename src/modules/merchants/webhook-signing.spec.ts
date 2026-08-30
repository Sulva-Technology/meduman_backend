import { buildSignatureHeader, signPayload } from './webhook-signing';

describe('webhook-signing', () => {
  it('signs over "timestamp.body" deterministically', () => {
    const s1 = signPayload('whsec_x', 1000, '{"a":1}');
    const s2 = signPayload('whsec_x', 1000, '{"a":1}');
    expect(s1).toEqual(s2);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with secret, timestamp, or body', () => {
    const base = signPayload('whsec_x', 1000, 'b');
    expect(signPayload('whsec_y', 1000, 'b')).not.toEqual(base);
    expect(signPayload('whsec_x', 1001, 'b')).not.toEqual(base);
    expect(signPayload('whsec_x', 1000, 'c')).not.toEqual(base);
  });

  it('builds a t=,v1= header', () => {
    const header = buildSignatureHeader('whsec_x', 1000, 'b');
    expect(header).toBe(`t=1000,v1=${signPayload('whsec_x', 1000, 'b')}`);
  });
});
