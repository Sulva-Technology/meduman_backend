import { Injectable } from '@nestjs/common';
import type { AuditLog, Dispute, Transaction } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import type { AdminListDisputesDto, AdminListTransactionsDto } from './dto/admin-list.dto';

/** Read-only admin views. No money mutations happen here — resolution lives in
 * the disputes module through the state machine. */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listTransactions(
    q: AdminListTransactionsDto,
  ): Promise<{ items: Transaction[]; nextCursor: string | null }> {
    const take = q.limit ?? 25;
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.sellerId ? { sellerId: q.sellerId } : {}),
      ...(q.buyerId ? { buyerId: q.buyerId } : {}),
    };
    const rows = await this.prisma.transaction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, take);
    const last = items.at(-1);
    const nextCursor = rows.length > take && last ? last.id : null;
    return { items, nextCursor };
  }

  async listDisputes(
    q: AdminListDisputesDto,
  ): Promise<{ items: Dispute[]; nextCursor: string | null }> {
    const take = q.limit ?? 25;
    const where = { ...(q.status ? { status: q.status } : {}) };
    const rows = await this.prisma.dispute.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: {
        transaction: {
          select: { id: true, title: true, amount: true, currency: true, status: true },
        },
      },
    });
    const items = rows.slice(0, take);
    const last = items.at(-1);
    const nextCursor = rows.length > take && last ? last.id : null;
    return { items, nextCursor };
  }

  /** Immutable audit trail for one transaction (rule 6), oldest first. */
  async getAuditForTx(id: string): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { targetType: 'Transaction', targetId: id },
      orderBy: { createdAt: 'asc' },
    });
  }
}
