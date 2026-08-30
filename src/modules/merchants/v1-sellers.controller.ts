import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { ApiKeyGuard, type MerchantContext } from './api-key.guard';
import { CurrentMerchant } from './decorators/current-merchant.decorator';
import { MerchantSellersService } from './merchant-sellers.service';
import { SellerProfileService } from '@/modules/users/seller-profile.service';
import { CreateSellerDto } from './dto/create-seller.dto';
import { CreateTransferRecipientDto } from '@/modules/users/dto/create-transfer-recipient.dto';

/**
 * Public /v1 API — gated by ApiKeyGuard, NOT the global Supabase JWT guard.
 * @Public() makes SupabaseJwtGuard skip this controller; ApiKeyGuard is the
 * real gate (merchant-scoped bearer sk_ key). Every handler is merchant-scoped
 * via @CurrentMerchant + an ownership check before touching a seller row.
 */
@Public()
@UseGuards(ApiKeyGuard)
@Controller('v1/sellers')
export class V1SellersController {
  constructor(
    private readonly sellers: MerchantSellersService,
    private readonly sellerProfiles: SellerProfileService,
  ) {}

  @Post()
  create(@CurrentMerchant() m: MerchantContext, @Body() dto: CreateSellerDto) {
    return this.sellers.createSeller(m.id, dto);
  }

  @Get()
  list(@CurrentMerchant() m: MerchantContext) {
    return this.sellers.listSellers(m.id);
  }

  @Get(':id')
  get(@CurrentMerchant() m: MerchantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.sellers.getSeller(m.id, id);
  }

  @Post(':id/recipient')
  async recipient(
    @CurrentMerchant() m: MerchantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateTransferRecipientDto,
  ) {
    await this.sellers.assertOwnedSeller(m.id, id);
    const profile = await this.sellerProfiles.createTransferRecipient(id, dto);
    // Lean, non-secret projection — never the raw SellerProfile (providerRecipientCode,
    // paystackSubaccountCode, userId, merchantId must never leave this endpoint).
    return {
      settlementReady: !!profile.providerRecipientCode,
      bankCode: profile.settlementBankCode,
      accountName: profile.settlementAccountName,
      accountLast4: profile.settlementAccountLast4,
    };
  }
}
