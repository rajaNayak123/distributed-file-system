import logger from '../utils/logger.js';
import FilesRepository from '../repositories/files.repository.js';
import UploadsService from '../services/uploads.service.js';

export function startCleanupJob(intervalMs = 60 * 60 * 1000) {
  logger.info('Starting multipart upload cleanup job', { intervalMs });

  const filesRepository = new FilesRepository();
  const uploadsService = new UploadsService();

  setInterval(async () => {
    try {
      const retentionHours = 24;
      const cutoffTimeISO = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();
      
      const abandonedUploads = await filesRepository.findAbandonedUploads(cutoffTimeISO);
      
      if (abandonedUploads.length > 0) {
        logger.info(`Found ${abandonedUploads.length} abandoned uploads, attempting cleanup...`);
      }

      for (const upload of abandonedUploads) {
        if (upload.s3UploadId) {
          try {
            await uploadsService.abortMultipartUpload({
              userId: upload.userId,
              fileId: upload.fileId,
            });
            logger.info('Successfully aborted abandoned multipart upload', {
              userId: upload.userId,
              fileId: upload.fileId,
            });
          } catch (err) {
            logger.error('Failed to abort abandoned multipart upload', {
              userId: upload.userId,
              fileId: upload.fileId,
              error: err.message,
            });
          }
        }
      }
    } catch (err) {
      logger.error('Error in multipart upload cleanup job', { error: err.message });
    }
  }, intervalMs);
}
