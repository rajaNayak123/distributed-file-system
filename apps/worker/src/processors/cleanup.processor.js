import FilesRepository from '../repositories/files.repository.js';
import config from '../config/index.js';

async function abortS3MultipartUpload({ s3Key, s3UploadId, s3Client, bucket }) {
  const { AbortMultipartUploadCommand } = await import('@aws-sdk/client-s3');
  await s3Client.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: s3Key,
      UploadId: s3UploadId,
    })
  );
}

export async function runCleanup({
  filesRepository = new FilesRepository(),
  s3Client = null,
  logger = console,
} = {}) {
  const retentionHours = config.cleanup.retentionHours;
  const stuckCompletingHours = config.cleanup.stuckCompletingHours;
  const bucket = config.s3.bucket;

  if (!s3Client) {
    const { default: defaultS3Client } = await import('../clients/s3Client.js');
    s3Client = defaultS3Client;
  }

  const abandonedCutoff = new Date(
    Date.now() - retentionHours * 60 * 60 * 1000
  ).toISOString();

  const abandonedUploads = await filesRepository.findAbandonedUploads(abandonedCutoff);

  if (abandonedUploads.length > 0) {
    logger.info(`[cleanup] Found ${abandonedUploads.length} abandoned uploads`);
  }

  for (const upload of abandonedUploads) {
    if (upload.s3UploadId) {
      try {
        await abortS3MultipartUpload({
          s3Key: upload.s3Key,
          s3UploadId: upload.s3UploadId,
          s3Client,
          bucket,
        });
        logger.info(JSON.stringify({
          level: 'info',
          event: 'abandoned_multipart_aborted',
          userId: upload.userId,
          fileId: upload.fileId,
        }));
      } catch (err) {
        logger.error(JSON.stringify({
          level: 'error',
          event: 'abandoned_multipart_abort_failed',
          userId: upload.userId,
          fileId: upload.fileId,
          error: err.message,
        }));
      }
    }

    try {
      await filesRepository.updateFileStatus({
        userId: upload.userId,
        fileId: upload.fileId,
        fromStatuses: ['UPLOADING'],
        toStatus: 'FAILED',
        extraAttributes: { failureReason: 'Upload abandoned — marked FAILED by cleanup worker after retention threshold' },
      });
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException') {
        logger.error(JSON.stringify({
          level: 'error',
          event: 'abandoned_mark_failed_error',
          userId: upload.userId,
          fileId: upload.fileId,
          error: err.message,
        }));
      }
    }
  }

  const stuckCutoff = new Date(
    Date.now() - stuckCompletingHours * 60 * 60 * 1000
  ).toISOString();

  const stuckCompleting = await filesRepository.findStuckCompleting(stuckCutoff);

  for (const upload of stuckCompleting) {
    try {
      await filesRepository.updateFileStatus({
        userId: upload.userId,
        fileId: upload.fileId,
        fromStatuses: ['COMPLETING'],
        toStatus: 'FAILED',
        extraAttributes: {
          failureReason: `Upload stuck in COMPLETING for >${stuckCompletingHours}h; marked FAILED by cleanup worker`,
        },
      });
      logger.info(JSON.stringify({
        level: 'warn',
        event: 'completing_stuck_marked_failed',
        userId: upload.userId,
        fileId: upload.fileId,
      }));
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException') {
        logger.error(JSON.stringify({
          level: 'error',
          event: 'completing_stuck_mark_failed_error',
          userId: upload.userId,
          fileId: upload.fileId,
          error: err.message,
        }));
      }
    }
  }

  return {
    abandonedProcessed: abandonedUploads.length,
    stuckCompletingProcessed: stuckCompleting.length,
  };
}
