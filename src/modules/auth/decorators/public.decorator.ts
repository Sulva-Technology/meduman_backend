import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Mark a route as public — SupabaseJwtGuard skips token verification. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
