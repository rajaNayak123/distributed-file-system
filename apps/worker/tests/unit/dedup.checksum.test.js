import { processFileUploaded } from '../../src/processors/checksum.processor.js';
import { Readable } from 'stream';

describe('dedup.checksum — unit', () => {
  const file1 = {
    userId: 'user-1',
    fileId: 'file-1',
    s3Key: 'users/user-1/files/file-1',
    status: 'COMPLETED',
    checksum: null,
  };

  const file2 = {
    userId: 'user-2',
    fileId: 'file-2',
    s3Key: 'users/user-2/files/file-2',
    status: 'COMPLETED',
    checksum: null,
  };

  const fileContent = 'identical file content for deduplication test';

  it('marks first upload as canonical and leaves S3 object untouched', async () => {
    const s3Client = {
      send: jest.fn().mockImplementation((cmd) => {
        const name = cmd.constructor?.name || '';
        if (name.includes('GetObject')) {
          return Promise.resolve({
            Body: Readable.from([Buffer.from(fileContent)]),
          });
        }
        return Promise.resolve({});
      }),
    };

    const filesRepository = {
      getFile: jest.fn().mockResolvedValue(file1),
      findByContentHash: jest.fn().mockResolvedValue([]), // no existing match
      updateDedupRecord: jest.fn().mockResolvedValue({}),
      incrementRefCount: jest.fn(),
    };

    const result = await processFileUploaded(
      { fileId: file1.fileId, userId: file1.userId, s3Key: file1.s3Key },
      { s3Client, filesRepository }
    );

    expect(result.isDedup).toBe(false);
    expect(result.refCount).toBe(1);
    expect(result.checksum).toBeDefined();

    // S3 delete was not called
    const deleteCalls = s3Client.send.mock.calls.filter(
      ([cmd]) => (cmd.constructor?.name || '').includes('DeleteObject')
    );
    expect(deleteCalls.length).toBe(0);

    // Repository recorded non-dedup file
    expect(filesRepository.updateDedupRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        fileId: 'file-1',
        isDedup: false,
        contentHash: result.checksum,
      })
    );
    expect(filesRepository.incrementRefCount).not.toHaveBeenCalled();
  });

  it('detects identical content on second upload, increments canonical refCount, points to canonical s3Key, and deletes redundant S3 object', async () => {
    const canonicalHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    const s3Client = {
      send: jest.fn().mockImplementation((cmd) => {
        const name = cmd.constructor?.name || '';
        if (name.includes('GetObject')) {
          return Promise.resolve({
            Body: Readable.from([Buffer.from(fileContent)]),
          });
        }
        if (name.includes('DeleteObject')) {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      }),
    };

    const canonicalItem = {
      userId: 'user-1',
      fileId: 'file-1',
      s3Key: 'users/user-1/files/file-1',
      status: 'COMPLETED',
      contentHash: canonicalHash,
      isDedup: false,
      refCount: 1,
    };

    const filesRepository = {
      getFile: jest.fn().mockResolvedValue(file2),
      findByContentHash: jest.fn().mockResolvedValue([canonicalItem]), // match found!
      incrementRefCount: jest.fn().mockResolvedValue({ refCount: 2 }),
      updateDedupRecord: jest.fn().mockResolvedValue({}),
    };

    const result = await processFileUploaded(
      { fileId: file2.fileId, userId: file2.userId, s3Key: file2.s3Key },
      { s3Client, filesRepository }
    );

    expect(result.isDedup).toBe(true);
    expect(result.canonicalFileId).toBe('file-1');
    expect(result.canonicalUserId).toBe('user-1');
    expect(result.canonicalS3Key).toBe('users/user-1/files/file-1');

    // Incremented canonical refCount
    expect(filesRepository.incrementRefCount).toHaveBeenCalledWith({
      userId: 'user-1',
      fileId: 'file-1',
    });

    // Redundant S3 object deleted
    const deleteCalls = s3Client.send.mock.calls.filter(
      ([cmd]) => (cmd.constructor?.name || '').includes('DeleteObject')
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0].input).toEqual(
      expect.objectContaining({
        Key: 'users/user-2/files/file-2',
      })
    );

    // Dedup record updated
    expect(filesRepository.updateDedupRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        fileId: 'file-2',
        isDedup: true,
        s3Key: 'users/user-1/files/file-1',
        canonicalFileId: 'file-1',
        canonicalUserId: 'user-1',
      })
    );
  });
});
