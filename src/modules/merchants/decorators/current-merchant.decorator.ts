import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { MerchantContext } from '../api-key.guard';

/** Inject the merchant attached by ApiKeyGuard. Only valid on /v1 routes it guards. */
export const CurrentMerchant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MerchantContext => {
    const request = ctx.switchToHttp().getRequest<{ merchant?: MerchantContext }>();
    if (!request.merchant) {
      throw new Error('CurrentMerchant used on a route without ApiKeyGuard');
    }
    return request.merchant;
  },
);
