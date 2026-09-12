import UploadsService from '../../src/services/uploads.service.js';
import FakeFilesRepository from '../fakes/fakeFilesRepository.js';
import { UpstreamServiceError } from '../../src/utils/errors.js';

beforeEach(() => {
  FakeFilesRepository.__reset();
});

describe('S3 getPresignedPutUrl failure', () => {
  test('upload ends in FAILED when S3 presign throws', async () => {
    const fakeRepo = new FakeFilesRepository();
    const fakeS3 = {
      getPresignedPutUrl: jest.fn().mockRejectedValue(
        new UpstreamServiceError('S3 connection timed out')
      ),
    };

    const service = new UploadsService(fakeRepo, fakeS3);

    await expect(
      service.initiateUpload({
        userId: 'user-1',
        fileName: 'test.pdf',
        contentType: 'application/pdf',
        size: 1024,
      })
    ).rejects.toThrow(UpstreamServiceError);

    const files = await fakeRepo.listFilesForUser({ userId: 'user-1', includeIncomplete: true });
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('FAILED');
    expect(files[0].failureReason).toMatch(/presigned URL/i);
  });

  test('FAILED upload is retryable via retryFailedUpload', async () => {
    const fakeRepo = new FakeFilesRepository();
    let callCount = 0;
    const fakeS3 = {
      getPresignedPutUrl: jest.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) throw new UpstreamServiceError('S3 timeout');
        return Promise.resolve('https://fake-s3.local/retry-url');
      }),
    };

    const service = new UploadsService(fakeRepo, fakeS3);

    await expect(
      service.initiateUpload({
        userId: 'user-1',
        fileName: 'test.pdf',
        contentType: 'application/pdf',
        size: 1024,
      })
    ).rejects.toThrow();

    const [failedFile] = await fakeRepo.listFilesForUser({ userId: 'user-1', includeIncomplete: true });
    const { fileId } = failedFile;

    const result = await service.retryFailedUpload({ userId: 'user-1', fileId });

    expect(result.presignedUrl).toBe('https://fake-s3.local/retry-url');
    expect(result.fileId).toBe(fileId);

    const files = await fakeRepo.listFilesForUser({ userId: 'user-1', includeIncomplete: true });
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('UPLOADING');
  });
});
