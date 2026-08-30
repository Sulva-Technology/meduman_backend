import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { SellerProfileService } from '@/modules/users/seller-profile.service';

@Injectable()
export class MerchantSellersService {
  constructor(
    private readonly prisma: PrismaService,
    public readonly sellerProfiles: SellerProfileService, // exported for Task 8 controller recipient onboarding
  ) {}

  async createSeller(
    merchantId: string,
    input: { businessName: string; email?: string },
  ): Promise<{ id: string; businessName: string | null }> {
    const email = input.email ?? `seller+${randomUUID()}@eaas.meduman.local`;
    const user = await this.prisma.user.create({
      data: {
        id: randomUUID(),
        email,
        fullName: input.businessName,
        roleFlags: ['SELLER'],
        merchantId,
      },
    });
    const profile = await this.prisma.sellerProfile.create({
      data: {
        userId: user.id,
        businessName: input.businessName,
        merchantId,
      },
    });
    return { id: user.id, businessName: profile.businessName };
  }

  async listSellers(
    merchantId: string,
  ): Promise<Array<{ id: string; businessName: string | null; settlementReady: boolean }>> {
    const rows = await this.prisma.sellerProfile.findMany({ where: { merchantId } });
    return rows.map((p) => ({
      id: p.userId,
      businessName: p.businessName,
      settlementReady: !!p.providerRecipientCode,
    }));
  }

  async getSeller(
    merchantId: string,
    sellerId: string,
  ): Promise<{ id: string; businessName: string | null; settlementReady: boolean }> {
    await this.assertOwnedSeller(merchantId, sellerId);
    const profile = await this.prisma.sellerProfile.findUnique({ where: { userId: sellerId } });
    return {
      id: sellerId,
      businessName: profile?.businessName ?? null,
      settlementReady: !!profile?.providerRecipientCode,
    };
  }

  async assertOwnedSeller(merchantId: string, sellerId: string): Promise<void> {
    const owned = await this.prisma.user.findFirst({
      where: { id: sellerId, merchantId },
    });
    if (!owned) throw new NotFoundException(`Seller ${sellerId} not found`);
  }
}
