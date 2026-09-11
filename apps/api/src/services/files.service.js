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

    let shouldDeleteS3 = true;

    if (existing.isDedup) {
      // Case 1: Deduplicated alias referencing a canonical object.
      let canonicalActive = false;
      let remainingCanonicalRefCount = 0;

      if (existing.canonicalUserId && existing.canonicalFileId) {
        try {
          const canonical = await this.filesRepository.getFile({
            userId: existing.canonicalUserId,
            fileId: existing.canonicalFileId,
          });

          if (canonical && canonical.status === 'COMPLETED') {
            canonicalActive = true;
            const updatedCanonical = await this.filesRepository.decrementRefCount({
              userId: existing.canonicalUserId,
              fileId: existing.canonicalFileId,
            });
            remainingCanonicalRefCount = updatedCanonical?.refCount ?? 0;
          }
        } catch (err) {
          logger.warn('dedup_decrement_canonical_failed', {
            userId: existing.canonicalUserId,
            fileId: existing.canonicalFileId,
            error: err.message,
          });
        }
      }

      if (canonicalActive && remainingCanonicalRefCount > 0) {
        // Canonical file still exists and has active references (or is itself active)
        shouldDeleteS3 = false;
      } else {
        // Canonical record no longer exists or has no remaining active references.
        // Check if any other active (COMPLETED) files share this contentHash / s3Key.
        const hash = existing.contentHash || existing.checksum;
        let otherActiveMatches = [];

        if (hash && typeof this.filesRepository.findByContentHash === 'function') {
          try {
            const matches = await this.filesRepository.findByContentHash(hash);
            otherActiveMatches = (matches || []).filter(
              (m) => !(m.userId === userId && m.fileId === fileId) && m.status === 'COMPLETED'
            );
          } catch (err) {
            logger.warn('dedup_find_matches_failed', { error: err.message });
          }
        }

        shouldDeleteS3 = otherActiveMatches.length === 0;
      }
    } else if (existing.refCount && existing.refCount > 1) {
      // Case 2: Canonical object with active references.
      // S3 object must be preserved because other files still point to it.
      shouldDeleteS3 = false;
      try {
        await this.filesRepository.decrementRefCount({ userId, fileId });
      } catch (err) {
        logger.warn('dedup_decrement_refcount_failed', { userId, fileId, error: err.message });
      }
    } else {
      // Case 3: Canonical object with refCount <= 1 or no refCount.
      // Check if any other records share contentHash before deleting S3.
      const hash = existing.contentHash || existing.checksum;
      if (hash && typeof this.filesRepository.findByContentHash === 'function') {
        try {
          const matches = await this.filesRepository.findByContentHash(hash);
          const activeOthers = (matches || []).filter(
            (m) => !(m.userId === userId && m.fileId === fileId) && m.status === 'COMPLETED'
          );
          if (activeOthers.length > 0) {
            shouldDeleteS3 = false;
          }
        } catch (err) {
          // ignore lookup error and proceed
        }
      }
    }

    if (shouldDeleteS3) {
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

    logger.info('file_deleted', {
      userId,
      fileId,
      operation: 'deleteFile',
      status: 'OK',
      s3Deleted: shouldDeleteS3,
    });
    return { deleted: true, alreadyDeleted: false, s3Deleted: shouldDeleteS3 };
  }
}
