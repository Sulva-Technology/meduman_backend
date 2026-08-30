import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { PrismaService } from '@/prisma/prisma.service';
import { StorageService, type DownloadUrl } from '@/modules/storage/storage.service';
import type { SignedUploadUrl } from '@/modules/storage/storage.constants';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { CreateEvidenceDto } from './dto/create-evidence.dto';

/**
 * Evidence upload/download. Files live in the PRIVATE Supabase Storage bucket and
 * are only ever reachable through short-lived signed URLs this backend mints. The
 * server picks the (traversal-safe) storage path — the client never chooses it.
 */
@Controller()
export class EvidenceController {
  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
  ) {}

  /**
   * Register an evidence file and hand back a one-time signed upload URL. The
   * client PUTs the raw file to `upload.signedUrl`; we never proxy file bytes.
   */
  @Post('transactions/:id/evidence')
  async create(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateEvidenceDto,
  ): Promise<{ evidenceId: string; upload: SignedUploadUrl }> {
    const tx = await this.transactions.getById(id);
    this.assertParticipant(tx.sellerId, tx.buyerId, claims);

    const path = this.storage.buildEvidencePath(id, dto.filename);
    const upload = await this.storage.createUploadUrl(path);
    const evidence = await this.prisma.evidence.create({
      data: {
        transactionId: id,
        uploadedBy: claims.sub,
        storagePath: path,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        ...(dto.disputeId ? { disputeId: dto.disputeId } : {}),
      },
    });
    return { evidenceId: evidence.id, upload };
  }

  /** Short-lived signed URL to read one evidence file (participant/admin only). */
  @Get('evidence/:evidenceId/download-url')
  async download(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('evidenceId', new ParseUUIDPipe()) evidenceId: string,
  ): Promise<DownloadUrl> {
    const ev = await this.prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: { transaction: { select: { sellerId: true, buyerId: true } } },
    });
    if (!ev) {
      throw new NotFoundException('Evidence not found');
    }
    this.assertParticipant(ev.transaction.sellerId, ev.transaction.buyerId, claims);
    return this.storage.createDownloadUrl(ev.storagePath);
  }

  private assertParticipant(
    sellerId: string,
    buyerId: string | null,
    claims: SupabaseJwtClaims,
  ): void {
    const isParticipant = sellerId === claims.sub || buyerId === claims.sub;
    if (!isParticipant && claims.appRole !== 'ADMIN') {
      throw new ForbiddenException('Not a participant of this transaction');
    }
  }
}
