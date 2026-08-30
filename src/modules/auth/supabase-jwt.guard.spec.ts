import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseJwtGuard } from './supabase-jwt.guard';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import type { SupabaseJwtClaims } from './supabase-jwt';

type MutableRequest = { headers: Record<string, string>; user?: SupabaseJwtClaims };

function contextFor(request: MutableRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

const claims: SupabaseJwtClaims = {
  sub: 'user-123',
  role: 'authenticated',
  appRole: 'BUYER',
  raw: { sub: 'user-123' },
};

function makeGuard(opts: {
  verify?: (token: string) => Promise<SupabaseJwtClaims>;
  isPublic?: boolean;
}): SupabaseJwtGuard {
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === IS_PUBLIC_KEY ? (opts.isPublic ?? false) : undefined,
  } as unknown as Reflector;
  const jwtService = {
    verify: opts.verify ?? ((): Promise<SupabaseJwtClaims> => Promise.resolve(claims)),
  };
  return new SupabaseJwtGuard(reflector, jwtService as never);
}

describe('SupabaseJwtGuard', () => {
  it('allows public routes without a token', async () => {
    const guard = makeGuard({ isPublic: true });
    const req: MutableRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
  });

  it('rejects when the Authorization header is missing', async () => {
    const guard = makeGuard({});
    const req: MutableRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the scheme is not Bearer', async () => {
    const guard = makeGuard({});
    const req: MutableRequest = { headers: { authorization: 'Basic abc' } };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches verified claims to the request and allows access', async () => {
    const guard = makeGuard({});
    const req: MutableRequest = { headers: { authorization: 'Bearer good.token.here' } };

    const result = await guard.canActivate(contextFor(req));

    expect(result).toBe(true);
    expect(req.user).toEqual(claims);
  });

  it('propagates the verifier rejection when the token is invalid', async () => {
    const guard = makeGuard({
      verify: () => Promise.reject(new UnauthorizedException('Invalid or expired token')),
    });
    const req: MutableRequest = { headers: { authorization: 'Bearer bad' } };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
