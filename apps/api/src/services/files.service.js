import FilesRepository from '../repositories/files.repository.js';
import StorageService from './storage.service.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { NotFoundError, ConflictError } from '../utils/errors.js';

export default class FilesService {
  constructor(
    filesRepository = new FilesRepository(),
    storageService = new StorageService()
  ) {
    this.filesRepository = filesRepository;
    this.storageService = storageService;
  }

  async listFiles({ userId, includeIncomplete = false }) {
    return this.filesRepository.listFilesForUser({ userId, includeIncomplete });
  }

  async getFile({ userId, fileId, includeIncomplete = false }) {
    const file = await this.filesRepository.requireOwnedFile({ userId, fileId });
    if (!includeIncomplete && file.status !== 'COMPLETED') {
      throw new NotFoundError('File not found');
    }
    return file;
  }

  async getDownloadUrl({ userId, fileId }) {
    const file = await this.filesRepository.requireOwnedFile({ userId, fileId });
    if (file.status !== 'COMPLETED') {
      throw new ConflictError(
        `File ${fileId} is not available for download (status: ${file.status}). Only COMPLETED uploads can be downloaded.`
      );
    }
    const presignedUrl = await this.storageService.getPresignedGetUrl({
      key: file.s3Key,
      expiresInSeconds: config.uploads.presignedGetExpirySeconds,
    });
    const expiresAt = new Date(
      Date.now() + config.uploads.presignedGetExpirySeconds * 1000
    ).toISOString();
    logger.info('download_url_issued', { userId, fileId, operation: 'getDownloadUrl', status: 'OK' });
    return { downloadUrl: presignedUrl, expiresAt };
  }

  async deleteFile({ userId, fileId }) {
    const existing = await this.filesRepository.getFile({ userId, fileId });
    if (!existing) {
      return { deleted: true, alreadyDeleted: true };
    }

    try {
      await this.storageService.deleteObject({ key: existing.s3Key });
    } catch (err) {
      logger.error('delete_s3_failed', {
        userId,
        fileId,
        operation: 'deleteFile',
        status: 'FAILED',
        errorCategory: 'S3_DELETE_FAILED',
        error: err.message,
      });
      throw err;
    }

    try {
      await this.filesRepository.deleteFile({ userId, fileId });
    } catch (err) {
      logger.error('delete_dynamodb_failed_after_s3_delete', {
        userId,
        fileId,
        operation: 'deleteFile',
        status: 'PARTIAL_FAILURE',
        errorCategory: 'DYNAMODB_DELETE_FAILED_AFTER_S3_DELETE',
        error: err.message,
      });
      throw err;
    }

    logger.info('file_deleted', { userId, fileId, operation: 'deleteFile', status: 'OK' });
    return { deleted: true, alreadyDeleted: false };
  }
}
