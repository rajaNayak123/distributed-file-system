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
        size: Number.MAX_SAFE_INTEGER,
      })
    ).rejects.toThrow(ValidationError);

    expect(createFileSpy).not.toHaveBeenCalled();
    expect(fakeS3.getPresignedPutUrl).not.toHaveBeenCalled();
  });

  test('disallowed content type throws ValidationError exactly once', async () => {
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

    config.uploads.allowedContentTypes = original;
  });
});
