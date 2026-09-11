/**
 * tests/failure/retryNotRetried.test.js
 *
 * Proves that a ValidationError from uploads.service is NOT retried by
 * the SDK retry layer. The service method is called exactly once.
 *
 * Why this matters: we must never retry validation failures (oversized file,
 * bad content type) — they are deterministic client errors that will always
 * fail, so retrying wastes resources and masks bugs.
 */
import UploadsService from '../../src/services/uploads.service.js';
import FakeFilesRepository from '../fakes/fakeFilesRepository.js';
import { ValidationError } from '../../src/utils/errors.js';

beforeEach(() => {
  FakeFilesRepository.__reset();
});

describe('Validation errors are not retried', () => {
  test('oversized file throws ValidationError exactly once (no retry)', async () => {
    const fakeRepo = new FakeFilesRepository();
    const fakeS3 = {
      getPresignedPutUrl: jest.fn().mockResolvedValue('https://fake-s3.local/url'),
    };
    const createFileSpy = jest.spyOn(fakeRepo, 'createFile');

    const service = new UploadsService(fakeRepo, fakeS3);

    await expect(
      service.initiateUpload({
        userId: 'user-1',
        fileName: 'huge.zip',
        contentType: 'application/zip',
        size: Number.MAX_SAFE_INTEGER, // way over any limit
      })
    ).rejects.toThrow(ValidationError);

    // createFile must never have been called — validation rejected before any I/O.
    expect(createFileSpy).not.toHaveBeenCalled();

    // S3 must never have been called.
    expect(fakeS3.getPresignedPutUrl).not.toHaveBeenCalled();
  });

  test('disallowed content type throws ValidationError exactly once', async () => {
    // Temporarily set allowedContentTypes to a restricted list.
    const { default: config } = await import('../../src/config/index.js');
    const original = config.uploads.allowedContentTypes;
    config.uploads.allowedContentTypes = 'image/png,image/jpeg';

    const fakeRepo = new FakeFilesRepository();
    const fakeS3 = { getPresignedPutUrl: jest.fn() };
    const service = new UploadsService(fakeRepo, fakeS3);

    await expect(
      service.initiateUpload({
        userId: 'user-1',
        fileName: 'virus.exe',
        contentType: 'application/x-msdownload',
        size: 100,
      })
    ).rejects.toThrow(ValidationError);

    expect(fakeS3.getPresignedPutUrl).not.toHaveBeenCalled();

    // Restore.
    config.uploads.allowedContentTypes = original;
  });
});
