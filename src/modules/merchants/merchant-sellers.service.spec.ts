/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { NotFoundException } from '@nestjs/common';
import { MerchantSellersService } from './merchant-sellers.service';

function prismaMock() {
  return {
    user: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
    sellerProfile: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  } as any;
}

describe('MerchantSellersService', () => {
  it('mints a merchant-scoped seller User + SellerProfile with no Supabase account', async () => {
    const prisma = prismaMock();
    prisma.user.create.mockResolvedValue({ id: 'u1' });
    prisma.sellerProfile.create.mockResolvedValue({ id: 'sp1', businessName: 'Store A' });
    const svc = new MerchantSellersService(prisma, {} as any);

    const seller = await svc.createSeller('m1', { businessName: 'Store A' });

    const userData = prisma.user.create.mock.calls[0][0].data;
    expect(userData.merchantId).toBe('m1');
    expect(userData.roleFlags).toEqual(['SELLER']);
    expect(userData.email).toContain('@'); // synthetic email
    const profileData = prisma.sellerProfile.create.mock.calls[0][0].data;
    expect(profileData.merchantId).toBe('m1');
    expect(seller.id).toBe('u1');
  });

  it('assertOwnedSeller 404s a seller from another merchant', async () => {
    const prisma = prismaMock();
    prisma.user.findFirst.mockResolvedValue(null); // no row with (id, merchantId=m1)
    const svc = new MerchantSellersService(prisma, {} as any);
    await expect(svc.assertOwnedSeller('m1', 'other')).rejects.toBeInstanceOf(NotFoundException);
  });
});
