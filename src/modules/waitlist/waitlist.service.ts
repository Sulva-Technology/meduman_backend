import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import type { CreateWaitlistDto } from './dto/create-waitlist.dto';

@Injectable()
export class WaitlistService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent on email — a re-submit updates the existing lead instead of
   * failing on the unique constraint. Returns nothing identifying (this is an
   * unauthenticated endpoint; don't leak whether the email already existed).
   */
  async join(dto: CreateWaitlistDto): Promise<{ ok: true }> {
    await this.prisma.waitlistEntry.upsert({
      where: { email: dto.email },
      create: { ...dto },
      update: { ...dto },
    });
    return { ok: true };
  }
}
