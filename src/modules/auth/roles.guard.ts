import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, type AppRole } from './decorators/roles.decorator';
import type { SupabaseJwtClaims } from './supabase-jwt';

/**
 * Enforces @Roles() on a route. Runs after SupabaseJwtGuard, so request.user
 * is already populated. Routes without @Roles() are unrestricted (any
 * authenticated user).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AppRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: SupabaseJwtClaims }>();
    const appRole = request.user?.appRole;
    if (!appRole || !required.includes(appRole as AppRole)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
