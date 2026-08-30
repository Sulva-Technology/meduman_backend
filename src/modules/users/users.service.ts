import { BadRequestException, Injectable } from '@nestjs/common';
import { UserRole, type User } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import type { SupabaseJwtClaims } from '@/modules/auth';

/** App roles the mirror understands. Anything else (e.g. ADMIN) maps to no flag. */
const APP_ROLE_TO_USER_ROLE: Partial<Record<string, UserRole>> = {
  BUYER: UserRole.BUYER,
  SELLER: UserRole.SELLER,
  FREELANCER: UserRole.FREELANCER,
  BUSINESS: UserRole.BUSINESS,
};

/** Pull a display name out of the Supabase user_metadata claim, if present. */
function extractFullName(claims: SupabaseJwtClaims): string | undefined {
  const meta = claims.raw.user_metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as { full_name?: unknown; name?: unknown };
  if (typeof m.full_name === 'string' && m.full_name.length > 0) return m.full_name;
  if (typeof m.name === 'string' && m.name.length > 0) return m.name;
  return undefined;
}

/**
 * User mirror + seller subaccount management. Auth/passwords live in Supabase;
 * this backend only mirrors the verified identity so transactions can FK to it.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert the local mirror from a verified JWT on first (and every) request.
   * Create seeds identity + initial role flags; update keeps only the identity
   * fields in sync — roleFlags and status are server-owned and never clobbered
   * by a token claim.
   */
  async syncFromClaims(claims: SupabaseJwtClaims): Promise<User> {
    if (!claims.email) {
      throw new BadRequestException('Cannot mirror a user without an email');
    }

    const fullName = extractFullName(claims);
    const identity = {
      email: claims.email,
      ...(claims.phone ? { phone: claims.phone } : {}),
      ...(fullName ? { fullName } : {}),
    };

    const roleFlag = claims.appRole ? APP_ROLE_TO_USER_ROLE[claims.appRole] : undefined;

    return this.prisma.user.upsert({
      where: { id: claims.sub },
      create: {
        id: claims.sub,
        ...identity,
        roleFlags: roleFlag ? [roleFlag] : [],
      },
      update: { ...identity },
    });
  }
}
