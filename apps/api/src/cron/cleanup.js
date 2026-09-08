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

      const stuckCompletingCutoffISO = new Date(Date.now() - 60 * 60 * 1000).toISOString(); 
      const stuckCompleting = await filesRepository.findStuckCompleting(stuckCompletingCutoffISO);

      for (const upload of stuckCompleting) {
        try {
          await filesRepository.updateFileStatus({
            userId: upload.userId,
            fileId: upload.fileId,
            fromStatuses: ['COMPLETING'],
            toStatus: 'FAILED',
            extraAttributes: { failureReason: 'Upload stuck in COMPLETING for > 1 hour; marked FAILED by cleanup job' },
          });
          logger.warn('completing_stuck_marked_failed', {
            userId: upload.userId,
            fileId: upload.fileId,
            errorCategory: 'STUCK_COMPLETING',
          });
        } catch (err) {
          if (err.name !== 'ConflictError' && err.statusCode !== 409) {
            logger.error('Failed to mark stuck COMPLETING upload as FAILED', {
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
