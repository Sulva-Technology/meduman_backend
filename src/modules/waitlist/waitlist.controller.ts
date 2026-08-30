import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@/modules/auth';
import { WaitlistService } from './waitlist.service';
import { CreateWaitlistDto } from './dto/create-waitlist.dto';

@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  // Public + unauthenticated → throttle hard against spam / email enumeration.
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  @HttpCode(202)
  join(@Body() dto: CreateWaitlistDto): Promise<{ ok: true }> {
    return this.waitlist.join(dto);
  }
}
