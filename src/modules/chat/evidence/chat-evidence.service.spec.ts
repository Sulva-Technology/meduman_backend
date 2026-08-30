import type { PrismaService } from '@/prisma/prisma.service';
import type { StorageService } from '@/modules/storage/storage.service';
import type { ChatAdapter } from '../adapters/chat-adapter';
import { ChatEvidenceService, UnsupportedMediaError } from './chat-evidence.service';

function makeDeps(mimeType = 'image/jpeg') {
  const downloadMedia = jest
    .fn()
    .mockResolvedValue({ buffer: Buffer.from([1, 2, 3, 4]), mimeType });
  const adapter = {
    platform: 'TELEGRAM',
    capabilities: { buttons: true, media: true },
    downloadMedia,
  } as unknown as ChatAdapter;

  const uploadFile = jest.fn().mockResolvedValue(undefined);
  const buildEvidencePath = jest.fn().mockReturnValue('evidence/tx-1/uuid-chat-evidence.jpeg');
  const storage = { uploadFile, buildEvidencePath } as unknown as StorageService;

  const create = jest.fn().mockResolvedValue({ id: 'ev-1' });
  const prisma = { evidence: { create } } as unknown as PrismaService;

  return {
    service: new ChatEvidenceService(prisma, storage),
    adapter,
    downloadMedia,
    uploadFile,
    create,
  };
}

describe('ChatEvidenceService.capture', () => {
  it('downloads from the platform, re-uploads to private storage, and records Evidence', async () => {
    const { service, adapter, uploadFile, create } = makeDeps();

    const ev = await service.capture(
      adapter,
      { id: 'file-1', mimeType: 'image/jpeg' },
      { transactionId: 'tx-1', disputeId: 'disp-1', uploadedBy: 'user-1' },
    );

    expect(uploadFile).toHaveBeenCalledWith(
      'evidence/tx-1/uuid-chat-evidence.jpeg',
      Buffer.from([1, 2, 3, 4]),
      'image/jpeg',
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          transactionId: 'tx-1',
          disputeId: 'disp-1',
          uploadedBy: 'user-1',
          storagePath: 'evidence/tx-1/uuid-chat-evidence.jpeg',
          mimeType: 'image/jpeg',
          sizeBytes: 4,
        }),
      }),
    );
    expect(ev).toEqual({ id: 'ev-1' });
  });

  it('refuses an unsupported media type and never uploads or records it', async () => {
    const { service, adapter, uploadFile, create } = makeDeps('application/zip');

    await expect(
      service.capture(adapter, { id: 'file-2' }, { transactionId: 'tx-1', uploadedBy: 'user-1' }),
    ).rejects.toBeInstanceOf(UnsupportedMediaError);

    expect(uploadFile).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
