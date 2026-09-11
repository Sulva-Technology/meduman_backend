import { ChatLinkController } from './chat-link.controller';
import type { ChatLinkService } from './chat-link.service';

describe('ChatLinkController', () => {
  const links = {
    mint: jest
      .fn()
      .mockResolvedValue({ code: 'ABCD2345', expiresAt: new Date('2026-09-11T12:00:00Z') }),
    statusFor: jest
      .fn()
      .mockResolvedValue({ linked: false, pendingCode: true, underReview: false }),
  };
  const controller = new ChatLinkController(links as unknown as ChatLinkService);
  const claims = { sub: 'user-1' } as never;

  it('returns the plaintext code exactly once, with an ISO expiry', async () => {
    await expect(controller.mint(claims)).resolves.toEqual({
      code: 'ABCD2345',
      expiresAt: '2026-09-11T12:00:00.000Z',
    });
    expect(links.mint).toHaveBeenCalledWith('user-1');
  });

  it('never returns code material from the status route', async () => {
    const status = await controller.status(claims);
    expect(status).toEqual({ linked: false, pendingCode: true, underReview: false });
    expect(JSON.stringify(status)).not.toMatch(/[A-Z2-9]{8}/);
  });
});
