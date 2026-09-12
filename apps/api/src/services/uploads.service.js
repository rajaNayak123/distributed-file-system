import { randomUUID } from 'crypto';
import FilesRepository from '../repositories/files.repository.js';
import StorageService from './storage.service.js';
import QueueService from './queue.service.js';
import config from '../config/index.js';
import { STATUS, assertValidTransition } from '../utils/uploadStateMachine.js';
import { ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

function deriveS3Key(userId, fileId) {
  return `users/${userId}/files/${fileId}`;
}

export default class UploadsService {
  constructor(
    filesRepository = new FilesRepository(),
    storageService = new StorageService(),
    queueService = new QueueService()
  ) {
    this.filesRepository = filesRepository;
    this.storageService = storageService;
    this.queueService = queueService;
  }


  async initiateUpload({ userId, fileName, contentType, size }) {
    if (size > config.uploads.maxFileSizeBytes) {
      throw new ValidationError(
        `size exceeds maximum allowed upload size of ${config.uploads.maxFileSizeBytes} bytes`
      );
    }
    if (config.uploads.allowedContentTypes) {
      const allowed = config.uploads.allowedContentTypes.split(',').map((s) => s.trim());
      if (!allowed.includes(contentType)) {
        throw new ValidationError(`contentType ${contentType} is not permitted`);
      }
    }

    const fileId = randomUUID();
    const s3Key = deriveS3Key(userId, fileId);
    const now = new Date().toISOString();

    const multipartThreshold = config.uploads.multipartThresholdBytes || 50 * 1024 * 1024;

    await this.filesRepository.createFile({
      fileId,
      userId,
      fileName,
      size,
      contentType,
      s3Key,
      status: STATUS.INITIATED,
      createdAt: now,
      updatedAt: now,
    });

    if (size > multipartThreshold) {
      logger.info('upload_initiated_multipart_pending', { userId, fileId, operation: 'initiateUpload', status: 'INITIATED' });
      return {
        uploadId: fileId,
        fileId,
        multipartRequired: true,
      };
    }

    const expiresInSeconds = config.uploads.presignedPutExpirySeconds;
    let presignedUrl;
    try {
      presignedUrl = await this.storageService.getPresignedPutUrl({
        key: s3Key,
        contentType,
        expiresInSeconds,
      });
    } catch (err) {
      logger.error('upload_presign_failed', {
        userId, fileId, operation: 'initiateUpload', status: 'FAILED',
        errorCategory: 'S3_PRESIGN_FAILED', error: err.message,
      });
      await this.filesRepository.updateFileStatus({
        userId, fileId,
        fromStatuses: [STATUS.INITIATED],
        toStatus: STATUS.FAILED,
        extraAttributes: { failureReason: `Failed to generate presigned URL: ${err.message}` },
      }).catch(() => {}); 
      throw err;
    }

    assertValidTransition(STATUS.INITIATED, STATUS.UPLOADING);
    try {
      await this.filesRepository.updateFileStatus({
        userId,
        fileId,
        fromStatuses: [STATUS.INITIATED],
        toStatus: STATUS.UPLOADING,
      });
    } catch (err) {
      logger.error('upload_status_update_failed', {
        userId, fileId, operation: 'initiateUpload', status: 'PARTIAL_FAILURE',
        errorCategory: 'DYNAMODB_UPDATE_FAILED_AFTER_S3_PRESIGN', error: err.message,
      });
      throw err;
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    logger.info('upload_initiated', { userId, fileId, operation: 'initiateUpload', status: 'UPLOADING' });

    return {
      uploadId: fileId,
      fileId,
      presignedUrl,
      expiresAt,
    };
  }

  async completeUpload({ userId, fileId }) {
    const file = await this.filesRepository.requireOwnedFile({ userId, fileId });

    if (file.status === STATUS.COMPLETED) {
      return file;
    }

    if (file.status !== STATUS.UPLOADING) {
      throw new ValidationError(
        `Upload ${fileId} cannot be completed from status ${file.status}`
      );
    }

    assertValidTransition(STATUS.UPLOADING, STATUS.COMPLETING);
    await this.filesRepository.updateFileStatus({
      userId,
      fileId,
      fromStatuses: [STATUS.UPLOADING],
      toStatus: STATUS.COMPLETING,
    });

    const headResult = await this.storageService.headObject({ key: file.s3Key });

    if (!headResult.exists) {
      assertValidTransition(STATUS.COMPLETING, STATUS.FAILED);
      const failed = await this.filesRepository.updateFileStatus({
        userId,
        fileId,
        fromStatuses: [STATUS.COMPLETING],
        toStatus: STATUS.FAILED,
        extraAttributes: { failureReason: 'S3 object not found at completion time' },
      });
      logger.warn('upload_complete_object_missing', {
        userId,
        fileId,
        operation: 'completeUpload',
        status: 'FAILED',
        errorCategory: 'OBJECT_NOT_FOUND',
      });
      return failed;
    }

    assertValidTransition(STATUS.COMPLETING, STATUS.COMPLETED);
    const completed = await this.filesRepository.updateFileStatus({
      userId,
      fileId,
      fromStatuses: [STATUS.COMPLETING],
      toStatus: STATUS.COMPLETED,
      extraAttributes: {
        size: headResult.size,
        etag: headResult.etag,
        checksum: null,
      },
    });

    logger.info('upload_completed', { userId, fileId, operation: 'completeUpload', status: 'COMPLETED' });

    this.queueService.publishFileUploaded({ fileId, userId, s3Key: file.s3Key });

    return completed;
  }

  async initiateMultipartUpload({ userId, fileId }) {
    const file = await this.filesRepository.requireOwnedFile({ userId, fileId });
    if (file.status !== STATUS.INITIATED) {
      throw new ValidationError(`Cannot initiate multipart upload for file in status ${file.status}`);
    }

    const { uploadId } = await this.storageService.createMultipartUpload({
      key: file.s3Key,
      contentType: file.contentType,
    });

    await this.filesRepository.updateFileStatus({
      userId,
      fileId,
      fromStatuses: [STATUS.INITIATED],
      toStatus: STATUS.INITIATED,
      extraAttributes: { s3UploadId: uploadId, uploadType: 'multipart' },
    });

    return { fileId, s3UploadId: uploadId };
  }

  async getMultipartUploadPartUrls({ userId, fileId, partNumbers }) {
    const file = await this.filesRepository.requireOwnedFile({ userId, fileId });
    if (file.status !== STATUS.INITIATED && file.status !== STATUS.UPLOADING) {
      throw new ValidationError(`Cannot get part URLs for file in status ${file.status}`);
    }
    if (!file.s3UploadId) {
      throw new ValidationError(`File is not a multipart upload`);
    }

    if (file.status === STATUS.INITIATED) {
      assertValidTransition(STATUS.INITIATED, STATUS.UPLOADING);
      await this.filesRepository.updateFileStatus({
        userId,
        fileId,
        fromStatuses: [STATUS.INITIATED],
        toStatus: STATUS.UPLOADING,
      });
    }

    const expiresInSeconds = config.uploads.presignedPutExpirySeconds;
    const presignedUrls = await Promise.all(
      partNumbers.map(async (partNumber) => {
        const url = await this.storageService.getPresignedUploadPartUrl({
          key: file.s3Key,
          uploadId: file.s3UploadId,
          partNumber,
          expiresInSeconds,
        });
        return { partNumber, url };
      })
    );

    return { presignedUrls };
  }

  async completeMultipartUpload({ userId, fileId, parts }) {
    const file = await this.filesRepository.requireOwnedFile({ userId, fileId });

    if (file.status === STATUS.COMPLETED) {
      return file;
    }
    if (file.status !== STATUS.UPLOADING) {
      throw new ValidationError(`Upload ${fileId} cannot be completed from status ${file.status}`);
    }
    if (!file.s3UploadId) {
      throw new ValidationError(`File is not a multipart upload`);
    }

    assertValidTransition(STATUS.UPLOADING, STATUS.COMPLETING);
    await this.filesRepository.updateFileStatus({
      userId,
      fileId,
      fromStatuses: [STATUS.UPLOADING],
      toStatus: STATUS.COMPLETING,
    });

    await this.storageService.completeMultipartUpload({
      key: file.s3Key,
      uploadId: file.s3UploadId,
      parts,
    });

    const headResult = await this.storageService.headObject({ key: file.s3Key });

    if (!headResult.exists) {
      assertValidTransition(STATUS.COMPLETING, STATUS.FAILED);
      const failed = await this.filesRepository.updateFileStatus({
        userId,
        fileId,
        fromStatuses: [STATUS.COMPLETING],
        toStatus: STATUS.FAILED,
        extraAttributes: { failureReason: 'S3 object not found at completion time' },
      });
      logger.warn('multipart_upload_complete_object_missing', {
        userId, fileId, operation: 'completeMultipartUpload', status: 'FAILED', errorCategory: 'OBJECT_NOT_FOUND',
      });
      return failed;
    }

    assertValidTransition(STATUS.COMPLETING, STATUS.COMPLETED);
    const completed = await this.filesRepository.updateFileStatus({
      userId,
      fileId,
      fromStatuses: [STATUS.COMPLETING],
      toStatus: STATUS.COMPLETED,
      extraAttributes: {
        size: headResult.size,
        etag: headResult.etag,
        checksum: null,
      },
    });

    logger.info('multipart_upload_completed', { userId, fileId, operation: 'completeMultipartUpload', status: 'COMPLETED' });

    this.queueService.publishFileUploaded({ fileId, userId, s3Key: file.s3Key });

    return completed;
  }

  async abortMultipartUpload({ userId, fileId }) {
    const file = await this.filesRepository.requireOwnedFile({ userId, fileId });
    if (file.status === STATUS.COMPLETED || file.status === STATUS.FAILED) {
      return file;
    }
    if (!file.s3UploadId) {
      throw new ValidationError(`File is not a multipart upload`);
    }

    await this.storageService.abortMultipartUpload({
      key: file.s3Key,
      uploadId: file.s3UploadId,
    });

    const failed = await this.filesRepository.updateFileStatus({
      userId,
      fileId,
      fromStatuses: [STATUS.INITIATED, STATUS.UPLOADING, STATUS.COMPLETING],
      toStatus: STATUS.FAILED,
      extraAttributes: { failureReason: 'Aborted by user' },
    });

    logger.info('multipart_upload_aborted', { userId, fileId, operation: 'abortMultipartUpload', status: 'FAILED' });
    return failed;
  }

  async retryFailedUpload({ userId, fileId }) {
    const file = await this.filesRepository.requireOwnedFile({ userId, fileId });

    if (file.status !== STATUS.FAILED) {
      throw new ValidationError(
        `Upload ${fileId} cannot be retried from status ${file.status}. Only FAILED uploads are retryable.`
      );
    }

    assertValidTransition(STATUS.FAILED, STATUS.UPLOADING);

    const multipartThreshold = config.uploads.multipartThresholdBytes || 50 * 1024 * 1024;
    const isMultipart =
      file.uploadType === 'multipart' ||
      Boolean(file.s3UploadId) ||
      (file.size && file.size > multipartThreshold);

    if (isMultipart) {
      if (file.s3UploadId) {
        try {
          await this.storageService.abortMultipartUpload({
            key: file.s3Key,
            uploadId: file.s3UploadId,
          });
        } catch (abortErr) {
          logger.warn('retry_abort_old_multipart_failed', {
            userId,
            fileId,
            oldUploadId: file.s3UploadId,
            error: abortErr.message,
          });
        }
      }

      let newUploadId;
      try {
        const multipartRes = await this.storageService.createMultipartUpload({
          key: file.s3Key,
          contentType: file.contentType,
        });
        newUploadId = multipartRes.uploadId;
      } catch (err) {
        logger.error('upload_retry_multipart_create_failed', {
          userId,
          fileId,
          operation: 'retryFailedUpload',
          errorCategory: 'S3_MULTIPART_CREATE_FAILED',
          error: err.message,
        });
        throw err;
      }

      await this.filesRepository.updateFileStatus({
        userId,
        fileId,
        fromStatuses: [STATUS.FAILED],
        toStatus: STATUS.UPLOADING,
        extraAttributes: {
          s3UploadId: newUploadId,
          uploadType: 'multipart',
          failureReason: null,
        },
      });

      logger.info('upload_retried_multipart', {
        userId,
        fileId,
        operation: 'retryFailedUpload',
        status: 'UPLOADING',
        s3UploadId: newUploadId,
      });

      return {
        fileId,
        uploadType: 'multipart',
        s3UploadId: newUploadId,
      };
    }

    const expiresInSeconds = config.uploads.presignedPutExpirySeconds;
    let presignedUrl;
    try {
      presignedUrl = await this.storageService.getPresignedPutUrl({
        key: file.s3Key,
        contentType: file.contentType,
        expiresInSeconds,
      });
    } catch (err) {
      logger.error('upload_retry_presign_failed', {
        userId,
        fileId,
        operation: 'retryFailedUpload',
        errorCategory: 'S3_PRESIGN_FAILED',
        error: err.message,
      });
      throw err;
    }

    await this.filesRepository.updateFileStatus({
      userId,
      fileId,
      fromStatuses: [STATUS.FAILED],
      toStatus: STATUS.UPLOADING,
      extraAttributes: { failureReason: null },
    });

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    logger.info('upload_retried', {
      userId,
      fileId,
      operation: 'retryFailedUpload',
      status: 'UPLOADING',
    });

    return { fileId, uploadType: 'single', presignedUrl, expiresAt };
  }
}
