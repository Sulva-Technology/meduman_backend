import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import type { User } from '@prisma/client';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import type { BankOption } from '@/common/paystack/paystack.service';
import { UsersService } from './users.service';
import { SellerProfileService, type SellerProfileSelfView } from './seller-profile.service';
import { UpdateSellerProfileDto } from './dto/update-seller-profile.dto';
import { CreateSubaccountDto } from './dto/create-subaccount.dto';
import { CreateTransferRecipientDto } from './dto/create-transfer-recipient.dto';

@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly sellerProfiles: SellerProfileService,
  ) {}

  /**
   * The caller's own mirror. Syncs identity from the verified JWT on every call
   * (first request creates the row), then returns it. Protected by the global
   * SupabaseJwtGuard — no @Public here.
   */
  @Get('me')
  async me(@CurrentUser() claims: SupabaseJwtClaims): Promise<User> {
    return this.users.syncFromClaims(claims);
  }

  /** The caller's seller profile (created empty on first read). */
  @Get('me/seller')
  async seller(@CurrentUser() claims: SupabaseJwtClaims): Promise<SellerProfileSelfView> {
    const profile = await this.sellerProfiles.getOrCreate(claims.sub);
    return this.sellerProfiles.toSelfView(profile);
  }

  /** Update client-writable seller-profile fields. */
  @Patch('me/seller')
  async updateSeller(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Body() dto: UpdateSellerProfileDto,
  ): Promise<SellerProfileSelfView> {
    const profile = await this.sellerProfiles.update(claims.sub, dto);
    return this.sellerProfiles.toSelfView(profile);
  }

  /** Bank list for the settlement-account picker (authenticated, not public). */
  @Get('me/seller/banks')
  async banks(): Promise<BankOption[]> {
    return this.sellerProfiles.listBanks();
  }

  /**
   * Onboard the seller's payout destination: resolve the NUBAN account with the
   * bank, create a Paystack transfer recipient, store the code + masked details.
   * This is what makes a seller settlement-ready (decision D-0).
   */
  @Post('me/seller/recipient')
  async createTransferRecipient(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Body() dto: CreateTransferRecipientDto,
  ): Promise<SellerProfileSelfView> {
    const profile = await this.sellerProfiles.createTransferRecipient(claims.sub, dto);
    return this.sellerProfiles.toSelfView(profile);
  }

  /**
   * @deprecated Decision D-2 — split settlement is not used. A subaccount pays
   * the seller at collection time, which would break the funds hold. Kept only
   * so existing clients don't 404; do not build against it.
   */
  @Post('me/seller/subaccount')
  async createSubaccount(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Body() dto: CreateSubaccountDto,
  ): Promise<SellerProfileSelfView> {
    const profile = await this.sellerProfiles.createSubaccount(claims.sub, dto);
    return this.sellerProfiles.toSelfView(profile);
  }
}
