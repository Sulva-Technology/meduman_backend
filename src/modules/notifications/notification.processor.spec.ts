import type { Job } from 'bullmq';
import type { NotificationsService } from './notifications.service';
import { createNotificationProcessor } from './notification.processor';
import {
  INVOICE_DELIVERY_JOB,
  OTP_NOTIFICATION_JOB,
  type OtpNotificationJobData,
} from '@/modules/queue/queue.constants';

const data: OtpNotificationJobData = {
  transactionId: 'tx-1',
  otpId: 'otp-1',
  code: '123456',
  purpose: 'DELIVERY_CONFIRMATION',
};

describe('createNotificationProcessor', () => {
  it('routes an otp job to deliverOtpCode', async () => {
    const deliverOtpCode = jest.fn().mockResolvedValue(undefined);
    const process = createNotificationProcessor({
      deliverOtpCode,
    } as unknown as NotificationsService);

    await process({ name: OTP_NOTIFICATION_JOB, data } as unknown as Job<OtpNotificationJobData>);

    expect(deliverOtpCode).toHaveBeenCalledWith(data);
  });

  it('routes an invoice job to deliverInvoice', async () => {
    const deliverOtpCode = jest.fn();
    const deliverInvoice = jest.fn().mockResolvedValue(undefined);
    const process = createNotificationProcessor({
      deliverOtpCode,
      deliverInvoice,
    } as unknown as NotificationsService);

    await process({
      name: INVOICE_DELIVERY_JOB,
      data: { invoiceId: 'inv-1' },
    } as unknown as Job<OtpNotificationJobData>);

    expect(deliverInvoice).toHaveBeenCalledWith({ invoiceId: 'inv-1' });
    expect(deliverOtpCode).not.toHaveBeenCalled();
  });

  it('ignores an unknown job name', async () => {
    const deliverOtpCode = jest.fn();
    const process = createNotificationProcessor({
      deliverOtpCode,
    } as unknown as NotificationsService);

    await process({ name: 'something-else', data } as unknown as Job<OtpNotificationJobData>);

    expect(deliverOtpCode).not.toHaveBeenCalled();
  });
});
