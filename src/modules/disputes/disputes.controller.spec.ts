import { DisputeReason } from '@prisma/client';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { DisputesController } from './disputes.controller';
import type { DisputesService } from './disputes.service';

const buyer: SupabaseJwtClaims = {
  sub: 'user-1',
  email: 'b@example.com',
  role: 'authenticated',
  appRole: 'BUYER',
  raw: { sub: 'user-1' },
};
const admin: SupabaseJwtClaims = {
  sub: 'admin-1',
  email: 'a@example.com',
  role: 'authenticated',
  appRole: 'ADMIN',
  raw: { sub: 'admin-1' },
};

describe('DisputesController', () => {
  it('raise passes the caller as opener with their role tag', async () => {
    const service = { raise: jest.fn().mockResolvedValue({ id: 'disp-1' }), resolve: jest.fn() };
    const controller = new DisputesController(service as unknown as DisputesService);

    await controller.raise(buyer, 'tx-1', {
      reason: DisputeReason.NOT_AS_DESCRIBED,
      description: 'wrong colour',
    });

    expect(service.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        openedBy: 'user-1',
        role: 'BUYER',
        reason: DisputeReason.NOT_AS_DESCRIBED,
      }),
    );
  });

  it('resolve passes the admin as resolver', async () => {
    const service = { raise: jest.fn(), resolve: jest.fn().mockResolvedValue({ id: 'disp-1' }) };
    const controller = new DisputesController(service as unknown as DisputesService);

    await controller.resolve(admin, 'disp-1', { outcome: 'RELEASE', resolution: 'delivered' });

    expect(service.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        disputeId: 'disp-1',
        resolvedBy: 'admin-1',
        outcome: 'RELEASE',
      }),
    );
  });
});
