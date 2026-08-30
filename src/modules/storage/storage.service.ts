import { randomUUID } from 'node:crypto';
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import {
  SUPABASE_CLIENT,
  type SignedUploadUrl,
  type SupabaseStorageClient,
} from './storage.constants';

export interface DownloadUrl {
  signedUrl: string;
  expiresIn: number;
}

/**
 * Signed-URL access to the private Supabase Storage evidence bucket. Files are
 * NEVER publicly readable — upload and download always go through a short-lived
 * signed URL this backend mints. We store storage paths, never public URLs.
 */
@Injectable()
export class StorageService {
  private readonly bucket: string;
  private readonly defaultTtl: number;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(SUPABASE_CLIENT) private readonly client: SupabaseStorageClient,
  ) {
    this.bucket = config.get('SUPABASE_STORAGE_BUCKET', { infer: true });
    this.defaultTtl = config.get('SUPABASE_SIGNED_URL_TTL', { infer: true });
  }

  /** A one-time signed URL the client PUTs the evidence file to. */
  async createUploadUrl(path: string): Promise<SignedUploadUrl> {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUploadUrl(path);
    if (error || !data) {
      throw new InternalServerErrorException(
        `Could not sign upload URL: ${error?.message ?? 'unknown error'}`,
      );
    }
    return data;
  }

  /**
   * Server-side upload of raw bytes to the private bucket. Used for chat media:
   * the bot downloads the file from the platform CDN and re-uploads it here, so
   * evidence lives in our private bucket and is only ever served via a signed URL.
   */
  async uploadFile(path: string, body: Buffer, contentType: string): Promise<void> {
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(path, body, { contentType, upsert: false });
    if (error) {
      throw new InternalServerErrorException(`Could not upload file: ${error.message}`);
    }
  }

  /** A short-lived signed URL to read a private evidence file. */
  async createDownloadUrl(path: string, expiresIn = this.defaultTtl): Promise<DownloadUrl> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(path, expiresIn);
    if (error || !data) {
      throw new InternalServerErrorException(
        `Could not sign download URL: ${error?.message ?? 'unknown error'}`,
      );
    }
    return { signedUrl: data.signedUrl, expiresIn };
  }

  /**
   * Server-generated storage path. The client never chooses where its file
   * lands: we namespace by transaction and prefix a random id, and strip any
   * path separators from the supplied name so it can't traverse the bucket.
   */
  buildEvidencePath(transactionId: string, filename: string): string {
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^[._-]+/, '');
    return `evidence/${transactionId}/${randomUUID()}-${safe}`;
  }
}
