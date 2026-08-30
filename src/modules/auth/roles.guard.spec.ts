import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY, type AppRole } from './decorators/roles.decorator';
import type { SupabaseJwtClaims } from './supabase-jwt';

function contextFor(user?: SupabaseJwtClaims): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeGuard(requiredRoles?: AppRole[]): RolesGuard {
  const reflector = {
    getAllAndOverride: (key: string) => (key === ROLES_KEY ? requiredRoles : undefined),
  } as unknown as Reflector;
  return new RolesGuard(reflector);
}

const seller: SupabaseJwtClaims = {
  sub: 'u1',
  role: 'authenticated',
  appRole: 'SELLER',
  raw: {},
};

describe('RolesGuard', () => {
  it('allows when no roles are required', () => {
    expect(makeGuard(undefined).canActivate(contextFor(seller))).toBe(true);
  });

  it('allows when the user has a required role', () => {
    expect(makeGuard(['SELLER', 'ADMIN']).canActivate(contextFor(seller))).toBe(true);
  });

  it('forbids when the user lacks the required role', () => {
    expect(() => makeGuard(['ADMIN']).canActivate(contextFor(seller))).toThrow(ForbiddenException);
  });

  it('forbids when the user has no app role at all', () => {
    const noRole: SupabaseJwtClaims = { sub: 'u2', role: 'authenticated', raw: {} };
    expect(() => makeGuard(['BUYER']).canActivate(contextFor(noRole))).toThrow(ForbiddenException);
  });
});
