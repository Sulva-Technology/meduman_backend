import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { Env } from '@/config/env.validation';
import { StorageService } from './storage.service';
import { SUPABASE_CLIENT } from './storage.constants';

/**
 * Storage: Supabase Storage for evidence/proof uploads. Bucket is PRIVATE —
 * files are never publicly readable. Access via short-lived signed URLs this
 * backend mints (StorageService). The service-role client is provided here.
 */
@Module({
  providers: [
    {
      provide: SUPABASE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createClient(
          config.get('SUPABASE_URL', { infer: true }),
          config.get('SUPABASE_SERVICE_ROLE_KEY', { infer: true }),
          { auth: { persistSession: false, autoRefreshToken: false } },
        ),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
