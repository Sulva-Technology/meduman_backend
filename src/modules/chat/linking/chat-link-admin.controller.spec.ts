import { ConflictException, NotFoundException } from '@nestjs/common';
import { ChatLinkAdminController } from './chat-link-admin.controller';
import type { ChatLinkService } from './chat-link.service';

describe('ChatLinkAdminController', () => {
  const links = {
    listForReview: jest.fn(),
    resolve: jest.fn(),
  };
  const controller = new ChatLinkAdminController(links as unknown as ChatLinkService);
  const admin = { sub: 'admin-1' } as never;

  it('lists review requests', async () => {
    links.listForReview.mockResolvedValue({ items: [], nextCursor: null });
    await expect(controller.list({})).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('completes a request with an explicit winning profile', async () => {
    links.resolve.mockResolvedValue({ status: 'COMPLETED' });
    await expect(
      controller.resolve('req-1', { outcome: 'COMPLETE', keepProfile: 'TARGET' }, admin),
    ).resolves.toEqual({ status: 'COMPLETED' });
    expect(links.resolve).toHaveBeenCalledWith('req-1', 'COMPLETE', {
      keepProfile: 'TARGET',
      adminId: 'admin-1',
    });
  });

  it('surfaces a self-transaction conflict as 409 — no profile choice can fix it', async () => {
    links.resolve.mockRejectedValue(
      new ConflictException('SELF_TRANSACTION_CONFLICT cannot be resolved by choosing a profile'),
    );
    await expect(controller.resolve('req-1', { outcome: 'COMPLETE' }, admin)).rejects.toThrow(
      ConflictException,
    );
  });

  it('404s an unknown request', async () => {
    links.resolve.mockRejectedValue(new NotFoundException('Link request not found'));
    await expect(controller.resolve('nope', { outcome: 'REJECT' }, admin)).rejects.toThrow(
      NotFoundException,
    );
  });
});
