/** DI token for the Supabase client used by StorageService (service-role key). */
export const SUPABASE_CLIENT = Symbol('SUPABASE_CLIENT');

/** Minimal Supabase Storage surface StorageService depends on (testable seam). */
export interface SignedUploadUrl {
  signedUrl: string;
  token: string;
  path: string;
}
export interface SignedDownloadUrl {
  signedUrl: string;
}
export interface StorageBucketApi {
  createSignedUploadUrl(
    path: string,
  ): Promise<{ data: SignedUploadUrl | null; error: { message: string } | null }>;
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ data: SignedDownloadUrl | null; error: { message: string } | null }>;
  /** Server-side upload of raw bytes (used for chat media re-upload). */
  upload(
    path: string,
    body: Buffer | Uint8Array | ArrayBuffer | Blob,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{ data: { path: string } | null; error: { message: string } | null }>;
}
export interface SupabaseStorageClient {
  storage: { from(bucket: string): StorageBucketApi };
}
