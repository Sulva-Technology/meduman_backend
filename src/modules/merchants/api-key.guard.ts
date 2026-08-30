import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { MerchantsService } from './merchants.service';

export interface MerchantContext {
  id: string;
  livemode: boolean;
}

interface MerchantRequest {
  headers: Record<string, string | undefined>;
  merchant?: MerchantContext;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly merchants: MerchantsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MerchantRequest>();
    const key = extractBearer(request.headers.authorization);
    if (!key || !key.startsWith('sk_')) {
      throw new UnauthorizedException('Missing API key');
    }
    const verified = await this.merchants.verifyKey(key);
    if (!verified) {
      throw new UnauthorizedException('Invalid API key');
    }
    if (verified.livemode && !verified.merchant.livemodeEnabled) {
      throw new ForbiddenException('Live mode is not enabled for this merchant');
    }
    request.merchant = { id: verified.merchant.id, livemode: verified.livemode };
    return true;
  }
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value ? value : undefined;
}
