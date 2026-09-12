import UploadsService from '../../src/services/uploads.service.js';
import FakeFilesRepository from '../fakes/fakeFilesRepository.js';
import { UpstreamServiceError } from '../../src/utils/errors.js';
import logger from '../../src/utils/logger.js';

jest.spyOn(logger, 'error').mockImplementation(() => {});

beforeEach(() => {
  FakeFilesRepository.__reset();
  jest.clearAllMocks();
});

describe('DynamoDB update failure after S3 presign', () => {
  test('propagates error and logs with DYNAMODB_UPDATE_FAILED_AFTER_S3_PRESIGN category', async () => {
    const fakeRepo = new FakeFilesRepository();
    const fakeS3 = {
      getPresignedPutUrl: jest.fn().mockResolvedValue('https://fake-s3.local/put-url'),
    };

    const originalUpdate = fakeRepo.updateFileStatus.bind(fakeRepo);
    fakeRepo.updateFileStatus = jest.fn().mockImplementation(({ toStatus }) => {
      if (toStatus === 'UPLOADING') {
        throw new UpstreamServiceError('DynamoDB provisioned throughput exceeded');
      }
      return originalUpdate({ userId: 'user-1', fileId: 'any', fromStatuses: ['INITIATED'], toStatus, extraAttributes: {} });
    });

    const service = new UploadsService(fakeRepo, fakeS3);

    await expect(
      service.initiateUpload({
        userId: 'user-1',
        fileName: 'test.pdf',
        contentType: 'application/pdf',
        size: 1024,
      })
    ).rejects.toThrow(UpstreamServiceError);

    expect(logger.error).toHaveBeenCalledWith(
      'upload_status_update_failed',
      expect.objectContaining({
        errorCategory: 'DYNAMODB_UPDATE_FAILED_AFTER_S3_PRESIGN',
      })
    );
  });
});
