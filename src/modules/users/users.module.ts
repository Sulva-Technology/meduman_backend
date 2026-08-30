import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { SellerProfileService } from './seller-profile.service';
import { PublicSellersController } from './public-sellers.controller';

/**
 * Users: mirror of Supabase Auth users + seller profile / subaccount management.
 * The mirror is upserted from verified JWT claims on request (UsersService).
 * SellerProfileService owns the seller profile, Paystack subaccount onboarding,
 * and the public trust badge.
 */
@Module({
  controllers: [UsersController, PublicSellersController],
  providers: [UsersService, SellerProfileService],
  exports: [UsersService, SellerProfileService],
})
export class UsersModule {}
