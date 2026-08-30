import { Module } from '@nestjs/common';
import { StorageModule } from '@/modules/storage/storage.module';
import { TransactionsModule } from '@/modules/transactions/transactions.module';
import { EvidenceController } from './evidence.controller';

/**
 * Evidence: HTTP seam over StorageService (private bucket signed URLs) plus the
 * Evidence row. Files are never publicly readable; access is participant/admin
 * only and always via a short-lived signed URL.
 */
@Module({
  imports: [StorageModule, TransactionsModule],
  controllers: [EvidenceController],
})
export class EvidenceModule {}
