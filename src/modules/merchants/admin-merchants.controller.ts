import { Body, Controller, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '@/modules/auth/decorators/roles.decorator';
import { MerchantsService } from './merchants.service';
import { CreateMerchantDto, IssueKeyDto, UpdateMerchantDto } from './dto/create-merchant.dto';

@Roles('ADMIN')
@Controller('admin/merchants')
export class AdminMerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  @Post()
  create(@Body() dto: CreateMerchantDto) {
    return this.merchants.createMerchant(dto.name); // returns { merchant, apiKey } — apiKey shown once
  }

  @Post(':id/keys')
  issueKey(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: IssueKeyDto) {
    return this.merchants.issueKey(id, dto.livemode ?? false); // { apiKey, keyId } — apiKey shown once
  }

  @Post(':id/keys/:keyId/revoke')
  async revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('keyId', new ParseUUIDPipe()) keyId: string,
  ) {
    await this.merchants.revokeKey(id, keyId);
    return { ok: true };
  }

  @Patch(':id')
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateMerchantDto) {
    if (dto.livemodeEnabled !== undefined)
      await this.merchants.setLivemodeEnabled(id, dto.livemodeEnabled);
    if (dto.status) await this.merchants.setStatus(id, dto.status);
    return { ok: true };
  }
}
