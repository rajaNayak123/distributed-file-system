import FilesRepository from '../repositories/files.repository.js';
import config from '../config/index.js';

/**
 * Cleanup processor — runs on a node-cron schedule inside the worker.
 *
 * This is the cleanup job that previously lived in apps/api/src/cron/cleanup.js.
 * Moving it here achieves two things:
 *   1. The API server no longer starts background work on startup — it's a
 *      pure request/response process.
 *   2. The cleanup job can scale with the worker replicas. SQS-driven work and
 *      cron-driven work live in the same process, which is operationally simpler
 *      than running a separate "cron service."
 *
 * IMPORTANT: With two worker replicas (worker-1, worker-2) both running the same
 * cron, the cleanup job fires on BOTH replicas at the same time. This is safe
 * because the DynamoDB UpdateItem calls use conditional expressions (fromStatuses)
 * that make concurrent executions idempotent — the second one will get a
 * ConditionalCheckFailedException and silently skip, just as documented for the
 * API's cleanup logic.
 *
 * The AbortMultipartUpload call to S3 is also idempotent (re-aborting an
 * already-aborted upload is a no-op on S3/LocalStack).
 */

/**
 * Abort a single abandoned multipart upload.
 * Extracted so it can be tested independently.
 */
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

/**
 * Run one cleanup cycle.
 *
 * @param {object} deps - injectable dependencies for testing.
 */
export async function runCleanup({
  filesRepository = new FilesRepository(),
  s3Client = null, // injected by caller; null means use real client lazily
  logger = console,
} = {}) {
  const retentionHours = config.cleanup.retentionHours;
  const stuckCompletingHours = config.cleanup.stuckCompletingHours;
  const bucket = config.s3.bucket;

  // Lazily import the real S3 client to avoid loading it in unit tests.
  if (!s3Client) {
    const { default: defaultS3Client } = await import('../clients/s3Client.js');
    s3Client = defaultS3Client;
  }

  // ── 1. Abort abandoned multipart uploads ────────────────────────────────────
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

    // Mark abandoned upload as FAILED so it's no longer invisible.
    try {
      await filesRepository.updateFileStatus({
        userId: upload.userId,
        fileId: upload.fileId,
        fromStatuses: ['UPLOADING'],
        toStatus: 'FAILED',
        extraAttributes: { failureReason: 'Upload abandoned — marked FAILED by cleanup worker after retention threshold' },
      });
    } catch (err) {
      // ConditionalCheckFailedException = another worker already handled it.
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

  // ── 2. Mark stuck COMPLETING uploads as FAILED ──────────────────────────────
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
