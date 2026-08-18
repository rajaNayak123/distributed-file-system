import { randomUUID } from 'crypto';
import FilesRepository from '../repositories/files.repository.js';
import StorageService from './storage.service.js';
import config from '../config/index.js';
import { STATUS, assertValidTransition } from '../utils/uploadStateMachine.js';
import { ValidationError, NotFoundError, AuthorizationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

function deriveS3Key(userId, fileId) {
  return `users/${userId}/files/${fileId}`;
}

export default class UploadsService {
  constructor(
    filesRepository = new FilesRepository(),
    storageService = new StorageService()
  ) {
    this.filesRepository = filesRepository;
    this.storageService = storageService;
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

    const expiresInSeconds = config.uploads.presignedPutExpirySeconds;
    const presignedUrl = await this.storageService.getPresignedPutUrl({
      key: s3Key,
      contentType,
      expiresInSeconds,
    });

    assertValidTransition(STATUS.INITIATED, STATUS.UPLOADING);
    await this.filesRepository.updateFileStatus({
      userId,
      fileId,
      fromStatuses: [STATUS.INITIATED],
      toStatus: STATUS.UPLOADING,
    });

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
    return completed;
  }

  async requireOwnedFileForDownload({ userId, fileId }) {
    const file = await this.filesRepository.requireOwnedFile({ userId, fileId });
    if (file.userId !== userId) {
      throw new AuthorizationError('Not authorized to access this file');
    }
    if (!file.s3Key) {
      throw new NotFoundError('File has no associated storage object');
    }
    return file;
  }
}
