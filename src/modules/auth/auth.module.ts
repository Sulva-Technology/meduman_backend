import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SupabaseJwtService } from './supabase-jwt.service';
import { SupabaseJwtGuard } from './supabase-jwt.guard';
import { RolesGuard } from './roles.guard';

/**
 * Auth: verifies Supabase-issued JWTs (JWKS or HS256 secret, config-driven).
 * This backend does NOT store passwords or implement login endpoints.
 *
 * Secure-by-default: SupabaseJwtGuard and RolesGuard are registered globally.
 * Every route requires a valid token unless marked @Public(). Order matters —
 * the JWT guard runs first so RolesGuard can read request.user.
 */
@Global()
@Module({
  providers: [
    SupabaseJwtService,
    // Bound by their own token first, then aliased onto APP_GUARD with
    // `useExisting`. With a bare `useClass` Nest builds the instance under the
    // APP_GUARD token instead, and the guard class becomes unreachable — which
    // silently defeats `overrideGuard()`, so an e2e suite that means to swap the
    // identity check would run against the real one and 401 on every request.
    SupabaseJwtGuard,
    RolesGuard,
    { provide: APP_GUARD, useExisting: SupabaseJwtGuard },
    { provide: APP_GUARD, useExisting: RolesGuard },
  ],
  exports: [SupabaseJwtService],
})
export class AuthModule {}
