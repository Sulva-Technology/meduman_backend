import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet } from 'jose';
import type { Env } from '@/config/env.validation';
import {
  verifySupabaseJwt,
  type SupabaseJwtClaims,
  type VerificationKey,
  type VerifyOptions,
} from './supabase-jwt';

/**
 * Builds the verification key from config once (JWKS resolver or HS256 secret,
 * per SUPABASE_JWT_STRATEGY) and verifies tokens against it.
 */
@Injectable()
export class SupabaseJwtService {
  private readonly logger = new Logger(SupabaseJwtService.name);
  private readonly key: VerificationKey;
  private readonly options: VerifyOptions;

  constructor(config: ConfigService<Env, true>) {
    const strategy = config.get('SUPABASE_JWT_STRATEGY', { infer: true });
    if (strategy === 'secret') {
      const secret = config.get('SUPABASE_JWT_SECRET', { infer: true });
      this.key = new TextEncoder().encode(secret);
      this.logger.log('JWT verification: HS256 shared secret');
    } else {
      const jwksUrl = config.get('SUPABASE_JWKS_URL', { infer: true });
      this.key = createRemoteJWKSet(new URL(jwksUrl as string));
      this.logger.log('JWT verification: remote JWKS');
    }

    this.options = {
      issuer: config.get('SUPABASE_JWT_ISSUER', { infer: true }),
      audience: config.get('SUPABASE_JWT_AUDIENCE', { infer: true }),
    };
  }

  verify(token: string): Promise<SupabaseJwtClaims> {
    return verifySupabaseJwt(token, this.key, this.options);
  }
}
