import { NotFoundException } from '@nestjs/common';
import { ActorType, OtpPurpose } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { AuditService } from '@/modules/audit/audit.service';
import type { NotificationsService } from '@/modules/notifications/notifications.service';
import { OtpService } from './otp.service';
import { hashCode } from './otp.crypto';
import { OtpFailureReason, OtpNotIssuableError, OtpVerificationError } from './otp.errors';

const SECRET = 'unit-test-otp-secret-0123456789';

const CONFIG: Record<string, unknown> = {
  OTP_LENGTH: 6,
  OTP_TTL_SECONDS: 600,
  OTP_HASH_SECRET: SECRET,
  OTP_MAX_ATTEMPTS: 5,
};

const ACTOR = { id: 'buyer-1', type: ActorType.USER, role: 'BUYER' };

function makeDeps(
  overrides: {
    tx?: Record<string, unknown> | null;
    activeCode?: Record<string, unknown> | null;
  } = {},
) {
  const txRow = { id: 'tx-1', status: 'CONFIRMATION_PENDING' };
  const txFindUnique = jest
    .fn()
    .mockResolvedValue(overrides.tx === undefined ? txRow : overrides.tx);

  const otpCreate = jest
    .fn()
    .mockImplementation(({ data }) => Promise.resolve({ id: 'otp-1', ...data }));
  const otpUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const otpUpdate = jest.fn().mockResolvedValue({});
  const otpFindFirst = jest
    .fn()
    .mockResolvedValue(overrides.activeCode === undefined ? null : overrides.activeCode);

  const prisma = {
    transaction: { findUnique: txFindUnique },
    otpCode: {
      create: otpCreate,
      updateMany: otpUpdateMany,
      update: otpUpdate,
      findFirst: otpFindFirst,
    },
  } as unknown as PrismaService;

  const config = { get: (k: string) => CONFIG[k] } as never;
  const log = jest.fn().mockResolvedValue(undefined);
  const audit = { log } as unknown as AuditService;

  const enqueueOtpCode = jest.fn().mockResolvedValue(undefined);
  const notifications = { enqueueOtpCode } as unknown as NotificationsService;

  const service = new OtpService(prisma, config, audit, notifications);
  return {
    service,
    txFindUnique,
    otpCreate,
    otpUpdateMany,
    otpUpdate,
    otpFindFirst,
    log,
    enqueueOtpCode,
  };
}

/** Build a stored OtpCode row for `code`, active (unconsumed) by default. */
function storedCode(code: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'otp-1',
    transactionId: 'tx-1',
    purpose: OtpPurpose.DELIVERY_CONFIRMATION,
    codeHash: hashCode(code, SECRET),
    expiresAt: new Date(Date.now() + 60_000),
    attemptCount: 0,
    consumedAt: null,
    ...extra,
  };
}

describe('OtpService.issue', () => {
  it('creates a hashed code in CONFIRMATION_PENDING and returns a plaintext code + expiry', async () => {
    const { service, otpCreate } = makeDeps();

    const result = await service.issue({
      transactionId: 'tx-1',
      purpose: OtpPurpose.DELIVERY_CONFIRMATION,
      actor: ACTOR,
    });

    expect(result.code).toMatch(/^[0-9]{6}$/);
    expect(result.otpId).toBe('otp-1');
    expect(result.expiresAt).toBeInstanceOf(Date);

    const created = otpCreate.mock.calls[0][0].data;
    expect(created.codeHash).toBe(hashCode(result.code, SECRET));
    expect(created.purpose).toBe(OtpPurpose.DELIVERY_CONFIRMATION);
    // The plaintext must never be persisted.
    expect(created.codeHash).not.toContain(result.code);
  });

  it('enqueues out-of-band delivery of the same code it returns', async () => {
    const { service, enqueueOtpCode } = makeDeps();

    const result = await service.issue({
      transactionId: 'tx-1',
      purpose: OtpPurpose.DELIVERY_CONFIRMATION,
      actor: ACTOR,
    });

    expect(enqueueOtpCode).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-1', otpId: 'otp-1', code: result.code }),
    );
  });

  it('invalidates any prior unconsumed codes before issuing a new one', async () => {
    const { service, otpUpdateMany } = makeDeps();

    await service.issue({
      transactionId: 'tx-1',
      purpose: OtpPurpose.DELIVERY_CONFIRMATION,
      actor: ACTOR,
    });

    expect(otpUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          transactionId: 'tx-1',
          purpose: OtpPurpose.DELIVERY_CONFIRMATION,
          consumedAt: null,
        }),
      }),
    );
  });

  it('writes an audit row that never contains the plaintext code', async () => {
    const { service, log } = makeDeps();

    const result = await service.issue({
      transactionId: 'tx-1',
      purpose: OtpPurpose.DELIVERY_CONFIRMATION,
      actor: ACTOR,
    });

    const entry = log.mock.calls[0][0];
    expect(entry.action).toBe('otp.issued');
    expect(JSON.stringify(entry)).not.toContain(result.code);
  });

  it('refuses to issue when the transaction is not CONFIRMATION_PENDING', async () => {
    const { service, otpCreate } = makeDeps({ tx: { id: 'tx-1', status: 'PAYMENT_PROTECTED' } });

    await expect(
      service.issue({
        transactionId: 'tx-1',
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(OtpNotIssuableError);
    expect(otpCreate).not.toHaveBeenCalled();
  });

  it('throws NotFound when the transaction does not exist', async () => {
    const { service } = makeDeps({ tx: null });

    await expect(
      service.issue({
        transactionId: 'tx-x',
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OtpService.verify', () => {
  it('consumes the code and audits on a correct match', async () => {
    const { service, otpUpdateMany, log } = makeDeps({ activeCode: storedCode('123456') });

    await service.verify({
      transactionId: 'tx-1',
      purpose: OtpPurpose.DELIVERY_CONFIRMATION,
      code: '123456',
      actor: ACTOR,
    });

    // Single-use consume: guarded by id + consumedAt null.
    expect(otpUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'otp-1', consumedAt: null }),
        data: expect.objectContaining({ consumedAt: expect.any(Date) }),
      }),
    );
    expect(log.mock.calls.some((c) => c[0].action === 'otp.verified')).toBe(true);
  });

  it('rejects a wrong code, increments the attempt count, and audits the failure', async () => {
    const { service, otpUpdate, log } = makeDeps({ activeCode: storedCode('123456') });

    await expect(
      service.verify({
        transactionId: 'tx-1',
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        code: '000000',
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ reason: OtpFailureReason.MISMATCH });

    expect(otpUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'otp-1' },
        data: expect.objectContaining({ attemptCount: { increment: 1 } }),
      }),
    );
    expect(log.mock.calls.some((c) => c[0].action === 'otp.failed')).toBe(true);
  });

  it('rejects an expired code', async () => {
    const expired = storedCode('123456', { expiresAt: new Date(Date.now() - 1000) });
    const { service } = makeDeps({ activeCode: expired });

    await expect(
      service.verify({
        transactionId: 'tx-1',
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        code: '123456',
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ reason: OtpFailureReason.EXPIRED });
  });

  it('rejects when no active code exists', async () => {
    const { service } = makeDeps({ activeCode: null });

    await expect(
      service.verify({
        transactionId: 'tx-1',
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        code: '123456',
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ reason: OtpFailureReason.NO_ACTIVE_CODE });
  });

  it('locks the code once the attempt cap is reached (even with the right code)', async () => {
    const capped = storedCode('123456', { attemptCount: 5 });
    const { service, otpUpdateMany } = makeDeps({ activeCode: capped });

    await expect(
      service.verify({
        transactionId: 'tx-1',
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        code: '123456',
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ reason: OtpFailureReason.LOCKED });
    // A locked code is never consumed as a success.
    expect(otpUpdateMany).not.toHaveBeenCalled();
  });

  it('throws OtpVerificationError (generic) to the client', async () => {
    const { service } = makeDeps({ activeCode: null });

    await expect(
      service.verify({
        transactionId: 'tx-1',
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        code: '123456',
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(OtpVerificationError);
  });
});
