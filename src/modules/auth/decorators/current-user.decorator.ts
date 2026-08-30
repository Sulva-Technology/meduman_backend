import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { SupabaseJwtClaims } from '../supabase-jwt';

/**
 * Inject the verified Supabase claims attached by SupabaseJwtGuard.
 * Only valid on routes the guard protects.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SupabaseJwtClaims => {
    const request = ctx.switchToHttp().getRequest<{ user?: SupabaseJwtClaims }>();
    if (!request.user) {
      throw new Error('CurrentUser used on a route without SupabaseJwtGuard');
    }
    return request.user;
  },
);
