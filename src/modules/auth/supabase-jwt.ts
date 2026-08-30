import { UnauthorizedException } from '@nestjs/common';
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey, type KeyLike } from 'jose';

/** Normalized identity extracted from a verified Supabase JWT. */
export interface SupabaseJwtClaims {
  /** Supabase auth user id (auth.users.id). */
  sub: string;
  email?: string;
  phone?: string;
  /** Supabase token role claim, e.g. "authenticated". */
  role: string;
  /** App-level role from app_metadata.role (BUYER/SELLER/ADMIN), if present. */
  appRole?: string;
  /** Full verified payload for anything else callers need. */
  raw: JWTPayload;
}

export interface VerifyOptions {
  issuer?: string | undefined;
  audience?: string | undefined;
}

/** Key material accepted by jose: a symmetric secret, a public key, or a JWKS resolver. */
export type VerificationKey = Uint8Array | KeyLike | JWTVerifyGetKey;

/**
 * Verify a Supabase-issued JWT and map it to normalized claims.
 * Works for both HS256 (shared secret) and asymmetric algorithms (JWKS family).
 * Any verification failure becomes an UnauthorizedException — never leaks jose internals.
 */
export async function verifySupabaseJwt(
  token: string,
  key: VerificationKey,
  options: VerifyOptions = {},
): Promise<SupabaseJwtClaims> {
  let payload: JWTPayload;
  try {
    // jose's overloads split on key type; the union is safe to pass through.
    const result = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1], {
      ...(options.issuer ? { issuer: options.issuer } : {}),
      ...(options.audience ? { audience: options.audience } : {}),
    });
    payload = result.payload;
  } catch {
    throw new UnauthorizedException('Invalid or expired token');
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new UnauthorizedException('Token missing subject');
  }

  const appMetadata = payload.app_metadata;
  const appRole =
    appMetadata && typeof appMetadata === 'object' && 'role' in appMetadata
      ? (appMetadata as { role?: unknown }).role
      : undefined;

  return {
    sub: payload.sub,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    ...(typeof payload.phone === 'string' ? { phone: payload.phone } : {}),
    role: typeof payload.role === 'string' ? payload.role : 'authenticated',
    ...(typeof appRole === 'string' ? { appRole } : {}),
    raw: payload,
  };
}
