import { processMetadataValidation } from '../../src/processors/metadata.processor.js';

describe('metadata.processor — unit', () => {
  const userId = 'user-456';
  const fileId = 'file-def';
  const s3Key = `users/${userId}/files/${fileId}`;

  function makeFilesRepository(overrides = {}) {
    return {
      getFile: jest.fn().mockResolvedValue({
        userId,
        fileId,
        s3Key,
        status: 'COMPLETED',
        contentType: 'application/pdf',
        ...overrides,
      }),
    };
  }

  function makeS3Client(contentType, statusCode = 200) {
    if (statusCode === 404) {
      const err = new Error('Not Found');
      err.$metadata = { httpStatusCode: 404 };
      return { send: jest.fn().mockRejectedValue(err) };
    }
    return {
      send: jest.fn().mockResolvedValue({
        ContentType: contentType,
        ContentLength: 1024,
      }),
    };
  }

  it('returns {validated: true} when S3 content-type matches declared type', async () => {
    const s3Client = makeS3Client('application/pdf');
    const filesRepository = makeFilesRepository();

    const result = await processMetadataValidation(
      { fileId, userId, s3Key },
      { s3Client, filesRepository }
    );

    expect(result.validated).toBe(true);
    expect(result.contentType).toBe('application/pdf');
    expect(result.mismatch).toBeUndefined();
  });

  it('returns {mismatch: true} and does NOT throw when content-type mismatches', async () => {
    const s3Client = makeS3Client('application/octet-stream');
    const filesRepository = makeFilesRepository({ contentType: 'application/pdf' });

    const result = await processMetadataValidation(
      { fileId, userId, s3Key },
      { s3Client, filesRepository }
    );

    expect(result.mismatch).toBe(true);
    expect(result.declaredContentType).toBe('application/pdf');
    expect(result.s3ContentType).toBe('application/octet-stream');
  });

  it('ignores charset params when comparing content-types', async () => {
    const s3Client = makeS3Client('text/plain; charset=utf-8');
    const filesRepository = makeFilesRepository({ contentType: 'text/plain' });

    const result = await processMetadataValidation(
      { fileId, userId, s3Key },
      { s3Client, filesRepository }
    );

    expect(result.validated).toBe(true);
    expect(result.mismatch).toBeUndefined();
  });

  it('skips if S3 object is missing (404) — no throw', async () => {
    const s3Client = makeS3Client('', 404);
    const filesRepository = makeFilesRepository();

    const result = await processMetadataValidation(
      { fileId, userId, s3Key },
      { s3Client, filesRepository }
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('s3_object_missing');
  });

  it('propagates unexpected S3 errors so SQS can retry', async () => {
    const err = new Error('Network timeout');
    const s3Client = { send: jest.fn().mockRejectedValue(err) };
    const filesRepository = makeFilesRepository();

    await expect(
      processMetadataValidation({ fileId, userId, s3Key }, { s3Client, filesRepository })
    ).rejects.toThrow('Network timeout');
  });

  it('skips if file is not COMPLETED', async () => {
    const s3Client = makeS3Client('application/pdf');
    const filesRepository = makeFilesRepository({ status: 'UPLOADING' });

    const result = await processMetadataValidation(
      { fileId, userId, s3Key },
      { s3Client, filesRepository }
    );

    expect(result.skipped).toBe(true);
    expect(s3Client.send).not.toHaveBeenCalled();
  });

  it('skips if the file has been deleted', async () => {
    const s3Client = makeS3Client('application/pdf');
    const filesRepository = { getFile: jest.fn().mockResolvedValue(null) };

    const result = await processMetadataValidation(
      { fileId, userId, s3Key },
      { s3Client, filesRepository }
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('file_not_found');
    expect(s3Client.send).not.toHaveBeenCalled();
  });
});
