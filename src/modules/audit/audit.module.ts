import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Append-only audit log (money rule 6). Global — every domain module writes
 * audit rows, so AuditService is available everywhere without re-importing.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
