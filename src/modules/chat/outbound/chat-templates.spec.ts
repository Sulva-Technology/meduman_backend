import { renderChatTemplate } from './chat-templates';

describe('renderChatTemplate', () => {
  it('renders the OTP code and asks the buyer to reply with it', () => {
    const msg = renderChatTemplate('otp.delivery_confirmation', { code: '135790' });
    expect(msg.text).toContain('135790');
    expect(msg.text.toLowerCase()).toContain('reply');
  });

  it('renders a DVA account with the exact Naira amount', () => {
    const msg = renderChatTemplate('payment.dva_assigned', {
      accountNumber: '1234567890',
      bankName: 'Wema Bank',
      amount: 127500,
      transactionTitle: 'Sneakers',
    });
    expect(msg.text).toContain('1234567890');
    expect(msg.text).toContain('Wema Bank');
    expect(msg.text).toContain('1,275.00');
  });

  it('falls back to a generic message for an unknown template', () => {
    const msg = renderChatTemplate('nope.unknown', {});
    expect(msg.text.length).toBeGreaterThan(0);
  });
});
