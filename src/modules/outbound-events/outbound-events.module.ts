import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { OutboundEventsService } from './outbound-events.service';

@Module({
  imports: [PrismaModule],
  providers: [OutboundEventsService],
  exports: [OutboundEventsService],
})
export class OutboundEventsModule {}
