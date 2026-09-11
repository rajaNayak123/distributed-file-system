/**
 * tests/failure/dynamoPostS3.test.js
 *
 * Failure scenario: S3 presign succeeds, but the subsequent DynamoDB
 * updateFileStatus (INITIATED→UPLOADING) throws.
 *
 * Assert:
 *   1. The error is logged with category DYNAMODB_UPDATE_FAILED_AFTER_S3_PRESIGN.
 *   2. The upload does NOT silently succeed (an error is propagated).
 *   3. This is the seed of the reconciliation problem (Phase 7): the presigned
 *      URL was issued, the client may have PUT bytes, but we have no record.
 *      For now we log distinctly so the ops team can detect it.
 */
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

    // Patch updateFileStatus to succeed for INITIATED→FAILED (cleanup path)
    // but throw for INITIATED→UPLOADING (the main path).
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

    // The logger.error must have been called with the distinct category.
    expect(logger.error).toHaveBeenCalledWith(
      'upload_status_update_failed',
      expect.objectContaining({
        errorCategory: 'DYNAMODB_UPDATE_FAILED_AFTER_S3_PRESIGN',
      })
    );
  });
});
