import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import { StorageService } from './storage.service';
import type { StorageBucketApi, SupabaseStorageClient } from './storage.constants';

function makeConfig(): ConfigService<Env, true> {
  return {
    get: (key: string) =>
      ({ SUPABASE_STORAGE_BUCKET: 'evidence', SUPABASE_SIGNED_URL_TTL: 300 })[key],
  } as unknown as ConfigService<Env, true>;
}

function makeClient(bucket: Partial<StorageBucketApi>) {
  const from = jest.fn().mockReturnValue(bucket);
  return {
    client: { storage: { from } } as unknown as SupabaseStorageClient,
    from,
  };
}

describe('StorageService.createUploadUrl', () => {
  it('signs an upload URL against the configured private bucket', async () => {
    const createSignedUploadUrl = jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://x/upload', token: 'tok', path: 'evidence/tx-1/f.png' },
      error: null,
    });
    const { client, from } = makeClient({ createSignedUploadUrl });
    const service = new StorageService(makeConfig(), client);

    const result = await service.createUploadUrl('evidence/tx-1/f.png');

    expect(from).toHaveBeenCalledWith('evidence');
    expect(createSignedUploadUrl).toHaveBeenCalledWith('evidence/tx-1/f.png');
    expect(result).toEqual({
      signedUrl: 'https://x/upload',
      token: 'tok',
      path: 'evidence/tx-1/f.png',
    });
  });

  it('raises when Supabase returns an error', async () => {
    const createSignedUploadUrl = jest
      .fn()
      .mockResolvedValue({ data: null, error: { message: 'nope' } });
    const { client } = makeClient({ createSignedUploadUrl });
    const service = new StorageService(makeConfig(), client);

    await expect(service.createUploadUrl('evidence/tx-1/f.png')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('StorageService.createDownloadUrl', () => {
  it('signs a short-lived download URL with the configured TTL by default', async () => {
    const createSignedUrl = jest
      .fn()
      .mockResolvedValue({ data: { signedUrl: 'https://x/dl' }, error: null });
    const { client } = makeClient({ createSignedUrl });
    const service = new StorageService(makeConfig(), client);

    const result = await service.createDownloadUrl('evidence/tx-1/f.png');

    expect(createSignedUrl).toHaveBeenCalledWith('evidence/tx-1/f.png', 300);
    expect(result).toEqual({ signedUrl: 'https://x/dl', expiresIn: 300 });
  });

  it('honours an explicit expiry', async () => {
    const createSignedUrl = jest
      .fn()
      .mockResolvedValue({ data: { signedUrl: 'https://x/dl' }, error: null });
    const { client } = makeClient({ createSignedUrl });
    const service = new StorageService(makeConfig(), client);

    await service.createDownloadUrl('evidence/tx-1/f.png', 60);

    expect(createSignedUrl).toHaveBeenCalledWith('evidence/tx-1/f.png', 60);
  });
});

describe('StorageService.uploadFile', () => {
  it('uploads raw bytes to the private bucket with the given content type', async () => {
    const upload = jest
      .fn()
      .mockResolvedValue({ data: { path: 'evidence/tx-1/f.jpg' }, error: null });
    const { client, from } = makeClient({ upload });
    const service = new StorageService(makeConfig(), client);

    await service.uploadFile('evidence/tx-1/f.jpg', Buffer.from([1, 2]), 'image/jpeg');

    expect(from).toHaveBeenCalledWith('evidence');
    expect(upload).toHaveBeenCalledWith('evidence/tx-1/f.jpg', Buffer.from([1, 2]), {
      contentType: 'image/jpeg',
      upsert: false,
    });
  });

  it('raises when the upload errors', async () => {
    const upload = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { client } = makeClient({ upload });
    const service = new StorageService(makeConfig(), client);

    await expect(
      service.uploadFile('evidence/tx-1/f.jpg', Buffer.from([1]), 'image/jpeg'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('StorageService.buildEvidencePath', () => {
  it('namespaces by transaction and sanitises the filename', () => {
    const service = new StorageService(makeConfig(), makeClient({}).client);

    const path = service.buildEvidencePath('tx-1', '../../etc/pass wd.png');

    expect(path).toMatch(/^evidence\/tx-1\/[0-9a-f-]+-etc_pass_wd\.png$/);
  });
});
