import { UserStatus } from '@prisma/client';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { UsersController } from './users.controller';
import type { UsersService } from './users.service';
import type { SellerProfileService } from './seller-profile.service';

const claims: SupabaseJwtClaims = {
  sub: '22222222-2222-2222-2222-222222222222',
  email: 'buyer@example.com',
  role: 'authenticated',
  appRole: 'BUYER',
  raw: { sub: '22222222-2222-2222-2222-222222222222' },
};

describe('UsersController.me', () => {
  it('mirrors the caller from their verified claims and returns the row', async () => {
    const mirrored = { id: claims.sub, email: claims.email, status: UserStatus.ACTIVE };
    const service = { syncFromClaims: jest.fn().mockResolvedValue(mirrored) };
    const sellerProfiles = {} as unknown as SellerProfileService;
    const controller = new UsersController(service as unknown as UsersService, sellerProfiles);

    const result = await controller.me(claims);

    expect(service.syncFromClaims).toHaveBeenCalledWith(claims);
    expect(result).toBe(mirrored);
  });
});
