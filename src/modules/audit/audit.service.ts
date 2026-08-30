import { Injectable } from '@nestjs/common';
import { ActorType, type Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

/** One audit entry (money rule 6). Actor is polymorphic — id is not FK'd. */
export interface AuditEntryInput {
  action: string;
  targetType: string;
  targetId?: string;
  actorId?: string;
  actorType?: ActorType;
  reason?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Minimal shape both PrismaService and a `$transaction` client satisfy, so an
 * audit row can be written inside the caller's transaction (all-or-nothing).
 */
export interface AuditWriter {
  auditLog: { create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown> };
}

/**
 * Append-only audit-log writer. NEVER updates or deletes — one immutable row per
 * state transition / admin action (money rule 6). Pass a transaction client to
 * make the audit row share the caller's atomic write.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntryInput, client?: AuditWriter): Promise<void> {
    const db: AuditWriter = client ?? this.prisma;
    await db.auditLog.create({
      data: {
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        actorId: entry.actorId ?? null,
        actorType: entry.actorType ?? ActorType.SYSTEM,
        reason: entry.reason ?? null,
        ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      },
    });
  }
}
