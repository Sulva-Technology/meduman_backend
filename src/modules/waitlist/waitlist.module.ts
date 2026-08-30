import { Module } from '@nestjs/common';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';

/** Pre-launch waitlist / lead capture. Unauthenticated public endpoint. */
@Module({
  controllers: [WaitlistController],
  providers: [WaitlistService],
})
export class WaitlistModule {}
