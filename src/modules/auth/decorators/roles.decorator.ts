import { SetMetadata } from '@nestjs/common';

export type AppRole = 'BUYER' | 'SELLER' | 'ADMIN';

export const ROLES_KEY = 'roles';

/** Restrict a route to the given app roles (checked by RolesGuard). */
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
