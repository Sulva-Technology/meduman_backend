import { UnauthorizedException } from '@nestjs/common';
import { SignJWT, generateKeyPair } from 'jose';
import { verifySupabaseJwt } from './supabase-jwt';

const ISSUER = 'https://ref.supabase.co/auth/v1';
const AUDIENCE = 'authenticated';
const SECRET = new TextEncoder().encode('super-secret-value-at-least-32-chars-long');

async function signHs256(
  payload: Record<string, unknown>,
  opts: { exp?: string; issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setExpirationTime(opts.exp ?? '1h')
    .sign(SECRET);
}

describe('verifySupabaseJwt', () => {
  const verifyOpts = { issuer: ISSUER, audience: AUDIENCE };

  it('returns claims for a valid HS256 token', async () => {
    const token = await signHs256({
      sub: 'user-123',
      email: 'buyer@example.com',
      role: 'authenticated',
    });

    const claims = await verifySupabaseJwt(token, SECRET, verifyOpts);

    expect(claims.sub).toBe('user-123');
    expect(claims.email).toBe('buyer@example.com');
    expect(claims.role).toBe('authenticated');
  });

  it('extracts app role from app_metadata', async () => {
    const token = await signHs256({
      sub: 'user-123',
      role: 'authenticated',
      app_metadata: { role: 'SELLER' },
    });

    const claims = await verifySupabaseJwt(token, SECRET, verifyOpts);

    expect(claims.appRole).toBe('SELLER');
  });

  it('rejects an expired token', async () => {
    const token = await signHs256({ sub: 'user-123', role: 'authenticated' }, { exp: '-1h' });

    await expect(verifySupabaseJwt(token, SECRET, verifyOpts)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await signHs256({ sub: 'user-123', role: 'authenticated' }, { audience: 'anon' });

    await expect(verifySupabaseJwt(token, SECRET, verifyOpts)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = await signHs256(
      { sub: 'user-123', role: 'authenticated' },
      { issuer: 'https://evil.example.com' },
    );

    await expect(verifySupabaseJwt(token, SECRET, verifyOpts)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with the wrong key', async () => {
    const token = await signHs256({ sub: 'user-123', role: 'authenticated' });
    const wrongKey = new TextEncoder().encode('a-completely-different-secret-key-value');

    await expect(verifySupabaseJwt(token, wrongKey, verifyOpts)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token missing the sub claim', async () => {
    const token = await signHs256({ role: 'authenticated' });

    await expect(verifySupabaseJwt(token, SECRET, verifyOpts)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('verifies an asymmetric (RS256) token with a public key — the JWKS family', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ sub: 'user-999', role: 'authenticated' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('1h')
      .sign(privateKey);

    const claims = await verifySupabaseJwt(token, publicKey, verifyOpts);

    expect(claims.sub).toBe('user-999');
  });
});
