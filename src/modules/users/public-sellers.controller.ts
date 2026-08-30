import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@/modules/auth';
import { SellerProfileService, type SellerPublicView } from './seller-profile.service';

/** Public seller trust badge (storefront proof). No auth, lean projection. */
@Controller('public/sellers')
export class PublicSellersController {
  constructor(private readonly sellers: SellerProfileService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':badgeSlug')
  get(@Param('badgeSlug') badgeSlug: string): Promise<SellerPublicView> {
    return this.sellers.getPublicByBadgeSlug(badgeSlug);
  }
}
