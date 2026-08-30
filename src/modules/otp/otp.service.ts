import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorType, OtpPurpose } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import type { Env } from '@/config/env.validation';
import type { TransitionActor } from '@/modules/transactions/transactions.service';
import { generateNumericCode, hashCode, timingSafeEqualHex } from './otp.crypto';
import { OtpFailureReason, OtpNotIssuableError, OtpVerificationError } from './otp.errors';

export interface IssueOtpInput {
  transactionId: string;
  purpose: OtpPurpose;
  actor: TransitionActor;
}

export interface IssueOtpResult {
  otpId: string;
  /** Plaintext code — for the delivery layer ONLY. Never returned to the buyer's
   *  own client and never logged. */
  code: string;
  expiresAt: Date;
}

export interface VerifyOtpInput {
  transactionId: string;
  purpose: OtpPurpose;
  code: string;
  actor: TransitionActor;
}

/**
 * One-time codes for buyer confirmation / release step-up. Owns the OTP security
 * boundary: cryptographically-random codes, keyed-hash-at-rest (never plaintext),
 * single-use (`consumedAt`), attempt-capped, expiring, constant-time compared.
 *
 * `issue` returns the plaintext code to a *server-side* delivery caller (bot / SMS
 * / WhatsApp). Verification is deliberately generic to the client (no oracle),
 * with the precise failure kept in logs + audit rows (money rule 6).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Issue a fresh code for a transaction awaiting buyer confirmation. Invalidates
   * any prior unconsumed codes of the same purpose (only the newest one is ever
   * valid), stores the keyed hash, and audits the issuance without the plaintext.
   */
  async issue(input: IssueOtpInput): Promise<IssueOtpResult> {
    const tx = await this.prisma.transaction.findUnique({
      where: { id: input.transactionId },
    });
    if (!tx) {
      throw new NotFoundException(`Transaction ${input.transactionId} not found`);
    }
    if (tx.status !== 'CONFIRMATION_PENDING') {
      throw new OtpNotIssuableError(tx.status);
    }

    // Only the newest code is valid — retire any earlier unconsumed ones.
    await this.prisma.otpCode.updateMany({
      where: { transactionId: input.transactionId, purpose: input.purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const code = generateNumericCode(this.config.get('OTP_LENGTH', { infer: true }));
    const ttlSeconds = this.config.get('OTP_TTL_SECONDS', { infer: true });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const created = await this.prisma.otpCode.create({
      data: {
        transactionId: input.transactionId,
        purpose: input.purpose,
        codeHash: hashCode(code, this.config.get('OTP_HASH_SECRET', { infer: true })),
        expiresAt,
      },
    });

    await this.audit.log({
      action: 'otp.issued',
      targetType: 'OtpCode',
      targetId: created.id,
      actorType: input.actor.type,
      ...(input.actor.id ? { actorId: input.actor.id } : {}),
      metadata: { transactionId: input.transactionId, purpose: input.purpose, expiresAt },
    });

    // Enqueue out-of-band delivery (SMS/WhatsApp). The plaintext code rides only
    // on the transient job — it is never persisted to Postgres.
    await this.notifications.enqueueOtpCode({
      transactionId: input.transactionId,
      otpId: created.id,
      code,
      purpose: input.purpose,
    });

    return { otpId: created.id, code, expiresAt };
  }

  /**
   * Verify a submitted code against the newest active code for the transaction.
   * Fail-closed: a locked, expired, missing, or mismatched code all throw a
   * generic {@link OtpVerificationError}. On a correct match the code is consumed
   * atomically (single-use) and the success is audited. Throws — resolves silently
   * only on success, so the caller can safely proceed to drive BUYER_CONFIRM.
   */
  async verify(input: VerifyOtpInput): Promise<void> {
    const active = await this.prisma.otpCode.findFirst({
      where: { transactionId: input.transactionId, purpose: input.purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!active) {
      throw this.fail(input, OtpFailureReason.NO_ACTIVE_CODE);
    }
    if (active.expiresAt.getTime() <= Date.now()) {
      throw this.fail(input, OtpFailureReason.EXPIRED, active.id);
    }
    if (active.attemptCount >= this.config.get('OTP_MAX_ATTEMPTS', { infer: true })) {
      throw this.fail(input, OtpFailureReason.LOCKED, active.id);
    }

    const candidate = hashCode(input.code, this.config.get('OTP_HASH_SECRET', { infer: true }));
    if (!timingSafeEqualHex(candidate, active.codeHash)) {
      await this.prisma.otpCode.update({
        where: { id: active.id },
        data: { attemptCount: { increment: 1 } },
      });
      throw this.fail(input, OtpFailureReason.MISMATCH, active.id);
    }

    // Single-use: consume only if still unconsumed (guards a concurrent double-use).
    const consumed = await this.prisma.otpCode.updateMany({
      where: { id: active.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw this.fail(input, OtpFailureReason.NO_ACTIVE_CODE, active.id);
    }

    await this.audit.log({
      action: 'otp.verified',
      targetType: 'OtpCode',
      targetId: active.id,
      actorType: input.actor.type ?? ActorType.USER,
      ...(input.actor.id ? { actorId: input.actor.id } : {}),
      metadata: { transactionId: input.transactionId, purpose: input.purpose },
    });
  }

  /** Log + audit a verification failure, then return the generic client error. */
  private fail(
    input: VerifyOtpInput,
    reason: OtpFailureReason,
    otpId?: string,
  ): OtpVerificationError {
    this.logger.warn(
      `OTP verify failed (${reason}) tx=${input.transactionId} purpose=${input.purpose}`,
    );
    void this.audit.log({
      action: 'otp.failed',
      targetType: 'OtpCode',
      actorType: input.actor.type ?? ActorType.USER,
      reason,
      ...(otpId ? { targetId: otpId } : {}),
      ...(input.actor.id ? { actorId: input.actor.id } : {}),
      metadata: { transactionId: input.transactionId, purpose: input.purpose },
    });
    return new OtpVerificationError(reason);
  }
}
