import {
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import defaultS3Client from '../clients/s3Client.js';
import FilesRepository from '../repositories/files.repository.js';
import config from '../config/index.js';
import { processFileUploaded } from './checksum.processor.js';

/**
 * Checks if an S3 error indicates that the object was not found.
 */
export function isNotFoundError(err) {
  return (
    err.name === 'NotFound' ||
    err.name === 'NoSuchKey' ||
    err.$metadata?.httpStatusCode === 404 ||
    (err.message && (err.message.includes('NotFound') || err.message.includes('NoSuchKey') || err.message.includes('404')))
  );
}

/**
 * Parses an S3 key formatted as users/<userId>/files/<fileId>.
 */
export function parseS3Key(key) {
  const match = key && key.match(/^users\/([^/]+)\/files\/([^/]+)$/);
  if (!match) return null;
  return { userId: match[1], fileId: match[2] };
}

/**
 * Runs a full reconciliation cycle.
 *
 * Reconciles consistency gaps between S3 and DynamoDB:
 *
 * Case A (DynamoDB says exists, S3 object missing):
 *   Scans DynamoDB for suspicious records (stuck in UPLOADING/COMPLETING or COMPLETED
 *   without checksum past configured cutoff). Calls S3 HeadObject for each.
 *   If the S3 object is missing, marks the DynamoDB record as FAILED with
 *   failureReason: "reconciliation: object missing".
 *   If the S3 object exists for an unverified COMPLETED record, triggers checksum calculation.
 *
 * Case B (S3 object exists, DynamoDB record missing or FAILED):
 *   Sweeps S3 bucket via ListObjectsV2. For objects older than the orphan grace period,
 *   checks if corresponding DynamoDB record exists and is active. If missing or FAILED,
 *   and not referenced as a canonical dedup object, deletes the orphaned S3 object.
 */
export async function runReconciliation({
  filesRepository = new FilesRepository(),
  s3Client = null,
  logger = console,
} = {}) {
  const bucket = config.s3.bucket;
  if (!s3Client) {
    s3Client = defaultS3Client;
  }

  const stuckCutoffMinutes = config.reconciliation.stuckThresholdMinutes;
  const unverifiedCutoffMinutes = config.reconciliation.unverifiedThresholdMinutes;
  const orphanGraceMinutes = config.reconciliation.orphanGracePeriodMinutes;

  const now = Date.now();
  const stuckCutoffISO = new Date(now - stuckCutoffMinutes * 60 * 1000).toISOString();
  const unverifiedCutoffISO = new Date(now - unverifiedCutoffMinutes * 60 * 1000).toISOString();
  const orphanCutoffDate = new Date(now - orphanGraceMinutes * 60 * 1000);

  let caseAProcessed = 0;
  let caseAFailed = 0;
  let caseARepaired = 0;
  let caseBScanned = 0;
  let caseBOrphansDeleted = 0;

  // ── CASE A: DynamoDB records -> S3 verification ───────────────────────────
  logger.info(JSON.stringify({
    level: 'info',
    event: 'reconciliation_case_a_start',
    stuckCutoffISO,
    unverifiedCutoffISO,
  }));

  const suspiciousRecords = await filesRepository.findSuspiciousUploads({
    stuckCutoffISO,
    unverifiedCutoffISO,
  });

  caseAProcessed = suspiciousRecords.length;

  for (const item of suspiciousRecords) {
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: item.s3Key,
        })
      );

      // Object exists in S3
      if (item.status === 'COMPLETED' && (!item.checksum || item.checksum === null)) {
        try {
          await processFileUploaded(
            { fileId: item.fileId, userId: item.userId, s3Key: item.s3Key },
            { s3Client, filesRepository }
          );
          caseARepaired += 1;
          logger.info(JSON.stringify({
            level: 'info',
            event: 'reconciliation_case_a_checksum_repaired',
            userId: item.userId,
            fileId: item.fileId,
            s3Key: item.s3Key,
          }));
        } catch (repairErr) {
          logger.error(JSON.stringify({
            level: 'error',
            event: 'reconciliation_case_a_repair_error',
            userId: item.userId,
            fileId: item.fileId,
            error: repairErr.message,
          }));
        }
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        // Case A hit: DynamoDB says object exists or is uploading/completing, but S3 object is missing!
        try {
          await filesRepository.updateFileStatus({
            userId: item.userId,
            fileId: item.fileId,
            fromStatuses: [item.status],
            toStatus: 'FAILED',
            extraAttributes: {
              failureReason: 'reconciliation: object missing',
              reconciledAt: new Date().toISOString(),
            },
          });
          caseAFailed += 1;
          logger.warn(JSON.stringify({
            level: 'warn',
            event: 'reconciliation_case_a_object_missing',
            userId: item.userId,
            fileId: item.fileId,
            s3Key: item.s3Key,
            previousStatus: item.status,
          }));
        } catch (updateErr) {
          if (updateErr.name !== 'ConditionalCheckFailedException') {
            logger.error(JSON.stringify({
              level: 'error',
              event: 'reconciliation_case_a_update_failed',
              userId: item.userId,
              fileId: item.fileId,
              error: updateErr.message,
            }));
          }
        }
      } else {
        logger.error(JSON.stringify({
          level: 'error',
          event: 'reconciliation_case_a_head_object_error',
          userId: item.userId,
          fileId: item.fileId,
          error: err.message,
        }));
      }
    }
  }

  // ── CASE B: S3 bucket sweep -> DynamoDB orphan detection ──────────────────
  logger.info(JSON.stringify({
    level: 'info',
    event: 'reconciliation_case_b_start',
    orphanCutoff: orphanCutoffDate.toISOString(),
  }));

  try {
    let continuationToken = undefined;
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      });
      const listResponse = await s3Client.send(listCommand);
      const contents = listResponse.Contents || [];
      caseBScanned += contents.length;

      for (const s3Obj of contents) {
        // Skip if younger than grace period
        if (s3Obj.LastModified && new Date(s3Obj.LastModified) > orphanCutoffDate) {
          continue;
        }

        const parsed = parseS3Key(s3Obj.Key);
        let isOrphan = false;
        let orphanReason = '';

        if (!parsed) {
          // Unrecognized key format older than grace period
          const hasActiveRefs = typeof filesRepository.hasActiveReferencesToS3Key === 'function'
            ? await filesRepository.hasActiveReferencesToS3Key(s3Obj.Key)
            : false;
          if (hasActiveRefs) {
            isOrphan = false;
          } else {
            isOrphan = true;
            orphanReason = 'invalid_key_pattern';
          }
        } else {
          const fileRecord = await filesRepository.getFile({
            userId: parsed.userId,
            fileId: parsed.fileId,
          });

          if (!fileRecord || fileRecord.status === 'FAILED') {
            // The primary file record is missing or failed.
            // Before treating this S3 object as an orphan, check if any other active
            // (COMPLETED) records in DynamoDB reference this s3Key (e.g. via deduplication).
            const hasActiveRefs = typeof filesRepository.hasActiveReferencesToS3Key === 'function'
              ? await filesRepository.hasActiveReferencesToS3Key(s3Obj.Key)
              : false;

            if (hasActiveRefs) {
              isOrphan = false;
              logger.info(JSON.stringify({
                level: 'info',
                event: 'reconciliation_case_b_dedup_reference_retained',
                s3Key: s3Obj.Key,
                originalStatus: fileRecord ? fileRecord.status : 'MISSING',
              }));
            } else {
              isOrphan = true;
              orphanReason = !fileRecord ? 'dynamodb_record_missing' : 'dynamodb_record_failed';
            }
          }
        }

        if (isOrphan) {
          try {
            await s3Client.send(
              new DeleteObjectCommand({
                Bucket: bucket,
                Key: s3Obj.Key,
              })
            );
            caseBOrphansDeleted += 1;
            logger.warn(JSON.stringify({
              level: 'warn',
              event: 'reconciliation_case_b_orphan_deleted',
              s3Key: s3Obj.Key,
              reason: orphanReason,
            }));
          } catch (delErr) {
            logger.error(JSON.stringify({
              level: 'error',
              event: 'reconciliation_case_b_orphan_delete_failed',
              s3Key: s3Obj.Key,
              error: delErr.message,
            }));
          }
        }
      }

      continuationToken = listResponse.NextContinuationToken;
    } while (continuationToken);
  } catch (listErr) {
    logger.error(JSON.stringify({
      level: 'error',
      event: 'reconciliation_case_b_list_error',
      error: listErr.message,
    }));
  }

  const result = {
    caseAProcessed,
    caseAFailed,
    caseARepaired,
    caseBScanned,
    caseBOrphansDeleted,
  };

  logger.info(JSON.stringify({
    level: 'info',
    event: 'reconciliation_job_complete',
    ...result,
  }));

  return result;
}

/**
 * Handles on-demand single item RECONCILE message from SQS.
 */
export async function processReconciliation(
  message,
  { filesRepository = new FilesRepository(), s3Client = defaultS3Client } = {}
) {
  const { fileId, userId } = message;
  const file = await filesRepository.getFile({ userId, fileId });
  if (!file) {
    return { skipped: true, reason: 'file_not_found' };
  }

  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: config.s3.bucket,
        Key: file.s3Key,
      })
    );

    // If S3 object exists and checksum is missing on COMPLETED file, calculate it
    if (file.status === 'COMPLETED' && (!file.checksum || file.checksum === null)) {
      return await processFileUploaded(
        { fileId, userId, s3Key: file.s3Key },
        { s3Client, filesRepository }
      );
    }
    return { status: file.status, reconciled: true };
  } catch (err) {
    if (isNotFoundError(err)) {
      await filesRepository.updateFileStatus({
        userId,
        fileId,
        fromStatuses: [file.status],
        toStatus: 'FAILED',
        extraAttributes: {
          failureReason: 'reconciliation: object missing',
          reconciledAt: new Date().toISOString(),
        },
      });
      return { status: 'FAILED', reconciled: true, reason: 'reconciliation: object missing' };
    }
    throw err;
  }
}
