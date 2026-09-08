import { processFileUploaded } from '../../src/processors/checksum.processor.js';
import { Readable } from 'stream';

/**
 * Unit tests for checksum.processor.js
 *
 * All AWS SDK calls are replaced with in-memory fakes — no LocalStack needed.
 * Tests verify:
 *   - SHA-256 is computed correctly and written to the repository.
 *   - Already-checksummed files are skipped (idempotency).
 *   - Non-COMPLETED files are skipped.
 *   - Deleted files (null from repo) are skipped.
 *   - S3 errors propagate (so SQS retries).
 */
describe('checksum.processor — unit', () => {
  const userId = 'user-123';
  const fileId = 'file-abc';
  const s3Key = `users/${userId}/files/${fileId}`;

  function makeS3Client(bodyContent) {
    return {
      send: jest.fn().mockResolvedValue({
        Body: Readable.from([Buffer.from(bodyContent)]),
      }),
    };
  }

  function makeFilesRepository(overrides = {}) {
    return {
      getFile: jest.fn().mockResolvedValue({
        userId,
        fileId,
        s3Key,
        status: 'COMPLETED',
        checksum: null,
        ...overrides,
      }),
      updateChecksum: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('computes SHA-256 of the S3 object body and writes it to the repository', async () => {
    const content = 'hello world';
    const s3Client = makeS3Client(content);
    const filesRepository = makeFilesRepository();

    const result = await processFileUploaded(
      { fileId, userId, s3Key },
      { s3Client, filesRepository }
    );

    expect(result.skipped).toBeUndefined();
    expect(result.checksum).toBeDefined();
    expect(result.checksum).toHaveLength(64); // SHA-256 hex = 64 chars

    // Verify the checksum is the real SHA-256 of 'hello world'
    const { createHash } = await import('crypto');
    const expected = createHash('sha256').update('hello world').digest('hex');
    expect(result.checksum).toBe(expected);

    expect(filesRepository.updateChecksum).toHaveBeenCalledWith({
      userId,
      fileId,
      checksum: expected,
    });
  });

  it('skips and returns {skipped} if file is already checksummed', async () => {
    const filesRepository = makeFilesRepository({ checksum: 'abc123deadbeef' });
    const s3Client = makeS3Client('');

    const result = await processFileUploaded(
      { fileId, userId, s3Key },
      { s3Client, filesRepository }
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already_checksummed');
    expect(s3Client.send).not.toHaveBeenCalled();
    expect(filesRepository.updateChecksum).not.toHaveBeenCalled();
  });

  it('skips if the file status is not COMPLETED', async () => {
    const filesRepository = makeFilesRepository({ status: 'FAILED', checksum: null });
    const s3Client = makeS3Client('');

    const result = await processFileUploaded(
      { fileId, userId, s3Key },
      { s3Client, filesRepository }
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('unexpected_status');
    expect(filesRepository.updateChecksum).not.toHaveBeenCalled();
  });

  it('skips if the file has been deleted (repo returns null)', async () => {
    const filesRepository = {
      getFile: jest.fn().mockResolvedValue(null),
      updateChecksum: jest.fn(),
    };
    const s3Client = makeS3Client('');

    const result = await processFileUploaded(
      { fileId, userId, s3Key },
      { s3Client, filesRepository }
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('file_not_found');
    expect(filesRepository.updateChecksum).not.toHaveBeenCalled();
  });

  it('propagates S3 errors so SQS can retry', async () => {
    const filesRepository = makeFilesRepository();
    const s3Client = {
      send: jest.fn().mockRejectedValue(new Error('S3 connection reset')),
    };

    await expect(
      processFileUploaded({ fileId, userId, s3Key }, { s3Client, filesRepository })
    ).rejects.toThrow('S3 connection reset');

    expect(filesRepository.updateChecksum).not.toHaveBeenCalled();
  });

  it('propagates DynamoDB errors when writing checksum so SQS can retry', async () => {
    const content = 'some file content';
    const s3Client = makeS3Client(content);
    const filesRepository = {
      getFile: jest.fn().mockResolvedValue({
        userId, fileId, s3Key, status: 'COMPLETED', checksum: null,
      }),
      updateChecksum: jest.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
    };

    await expect(
      processFileUploaded({ fileId, userId, s3Key }, { s3Client, filesRepository })
    ).rejects.toThrow('DynamoDB unavailable');
  });
});
