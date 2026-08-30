import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { SupabaseJwtService } from './supabase-jwt.service';
import type { SupabaseJwtClaims } from './supabase-jwt';

interface AuthedRequest {
  headers: Record<string, string | undefined>;
  user?: SupabaseJwtClaims;
}

/**
 * Verifies the Supabase JWT on every request and attaches the claims to
 * request.user. Routes marked @Public() bypass verification.
 */
@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: SupabaseJwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    request.user = await this.jwt.verify(token);
    return true;
  }
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) {
    return undefined;
  }
  return value;
}
