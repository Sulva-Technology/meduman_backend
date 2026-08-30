import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

function ctx(authorization?: string): ExecutionContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = { headers: { authorization } };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

describe('ApiKeyGuard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merchants = { verifyKey: jest.fn() } as any;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const guard = new ApiKeyGuard(merchants);
  beforeEach(() => jest.resetAllMocks());

  it('rejects a missing bearer key', async () => {
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown/revoked key', async () => {
    merchants.verifyKey.mockResolvedValue(null);
    await expect(guard.canActivate(ctx('Bearer sk_test_x'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts a valid test key and attaches the merchant', async () => {
    merchants.verifyKey.mockResolvedValue({
      merchant: { id: 'm1', livemodeEnabled: false },
      livemode: false,
    });
    const c = ctx('Bearer sk_test_x');
    await expect(guard.canActivate(c)).resolves.toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-type-assertion
    const req = c.switchToHttp().getRequest() as any;
    expect(req.merchant).toEqual({ id: 'm1', livemode: false });
  });

  it('forbids a live key when livemode is not enabled for the merchant', async () => {
    merchants.verifyKey.mockResolvedValue({
      merchant: { id: 'm1', livemodeEnabled: false },
      livemode: true,
    });
    await expect(guard.canActivate(ctx('Bearer sk_live_x'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
