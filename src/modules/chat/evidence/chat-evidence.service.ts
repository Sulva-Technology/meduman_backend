import { Injectable, Logger } from '@nestjs/common';
import type { Evidence } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { StorageService } from '@/modules/storage/storage.service';
import type { ChatAdapter, InboundMedia } from '../adapters/chat-adapter';

/** Mime types we accept as chat evidence. Anything else is refused. */
const ALLOWED_MIME = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/i;

export interface CaptureEvidenceContext {
  transactionId: string;
  disputeId?: string;
  uploadedBy: string;
}

/** Thrown when a chat attachment is a type we won't store. */
export class UnsupportedMediaError extends Error {
  constructor(readonly mimeType: string) {
    super(`Unsupported media type: ${mimeType}`);
    this.name = 'UnsupportedMediaError';
  }
}

/**
 * Turns a chat attachment into an Evidence row. The bytes are pulled from the
 * platform CDN by the adapter and re-uploaded to the PRIVATE Supabase bucket, so
 * evidence is never served from the platform's own CDN and is only ever reachable
 * through a short-lived signed URL. The server picks the (traversal-safe) path.
 */
@Injectable()
export class ChatEvidenceService {
  private readonly logger = new Logger(ChatEvidenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async capture(
    adapter: ChatAdapter,
    media: InboundMedia,
    ctx: CaptureEvidenceContext,
  ): Promise<Evidence> {
    if (!adapter.downloadMedia) {
      throw new Error(`Adapter ${adapter.platform} cannot download media`);
    }

    const { buffer, mimeType } = await adapter.downloadMedia(media);
    if (!ALLOWED_MIME.test(mimeType)) {
      throw new UnsupportedMediaError(mimeType);
    }

    const filename = media.filename ?? this.defaultFilename(mimeType);
    const path = this.storage.buildEvidencePath(ctx.transactionId, filename);
    await this.storage.uploadFile(path, buffer, mimeType);

    const evidence = await this.prisma.evidence.create({
      data: {
        transactionId: ctx.transactionId,
        uploadedBy: ctx.uploadedBy,
        storagePath: path,
        mimeType,
        sizeBytes: buffer.length,
        ...(ctx.disputeId ? { disputeId: ctx.disputeId } : {}),
      },
    });
    this.logger.log(`Chat evidence ${evidence.id} stored for tx ${ctx.transactionId}`);
    return evidence;
  }

  private defaultFilename(mimeType: string): string {
    const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1] || 'bin';
    return `chat-evidence.${ext}`;
  }
}
