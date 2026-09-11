import { createHash } from 'crypto';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import defaultS3Client from '../clients/s3Client.js';
import FilesRepository from '../repositories/files.repository.js';
import config from '../config/index.js';

/**
 * Checksum and Deduplication processor — handles FILE_UPLOADED events.
 *
 * Steps:
 *  1. Fetch the file item from DynamoDB to verify it's still COMPLETED and
 *     hasn't already been checksummed (idempotency guard).
 *  2. Stream the S3 object body through a SHA-256 hasher.
 *  3. Query ContentHashIndex to check if an identical file already exists.
 *     - If found:
 *       a. Point new file's s3Key to the canonical object's s3Key.
 *       b. Increment canonical object's refCount.
 *       c. Delete the redundant newly uploaded S3 object.
 *       d. Mark new file as isDedup: true with canonical pointers.
 *     - If not found:
 *       a. Mark new file as isDedup: false, refCount: 1, contentHash: hash.
 *
 * Throwing from this function intentionally does NOT delete the SQS message,
 * so SQS will re-deliver it after the visibility timeout.
 */
export async function processFileUploaded(
  { fileId, userId, s3Key },
  { s3Client = defaultS3Client, filesRepository = new FilesRepository() } = {}
) {
  // 1. Fetch current item — guard against re-processing an already-checksummed file.
  const file = await filesRepository.getFile({ userId, fileId });
  if (!file) {
    // Item was deleted between publish and consume (e.g. user deleted file).
    // Nothing to do — ack the message by returning normally.
    return { skipped: true, reason: 'file_not_found' };
  }

  if (file.status !== 'COMPLETED') {
    // Status changed out from under us (e.g. admin reset). Skip.
    return { skipped: true, reason: `unexpected_status_${file.status}` };
  }

  if (file.checksum && file.checksum !== null) {
    // Already checksummed by a previous (or concurrent) worker — idempotent skip.
    return { skipped: true, reason: 'already_checksummed' };
  }

  // 2. Stream the object through SHA-256.
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
    })
  );

  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    response.Body.on('data', (chunk) => hash.update(chunk));
    response.Body.on('end', resolve);
    response.Body.on('error', reject);
  });

  const checksum = hash.digest('hex');

  // 3. Deduplication check via ContentHashIndex
  let matches = [];
  if (typeof filesRepository.findByContentHash === 'function') {
    try {
      matches = await filesRepository.findByContentHash(checksum);
    } catch (err) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'dedup_lookup_failed',
        error: err.message,
      }));
    }
  }

  const otherMatches = (matches || []).filter(
    (m) => !(m.userId === userId && m.fileId === fileId) && m.status === 'COMPLETED'
  );

  if (otherMatches.length > 0) {
    // Pick canonical item (prefer non-dedup primary)
    const canonical = otherMatches.find((m) => !m.isDedup) || otherMatches[0];

    // Increment canonical refCount
    if (typeof filesRepository.incrementRefCount === 'function') {
      try {
        await filesRepository.incrementRefCount({
          userId: canonical.userId,
          fileId: canonical.fileId,
        });
      } catch (err) {
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'dedup_increment_refcount_failed',
          error: err.message,
        }));
      }
    }

    // Delete redundant S3 object
    try {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: config.s3.bucket,
          Key: s3Key,
        })
      );
      console.log(JSON.stringify({
        level: 'info',
        event: 'dedup_redundant_s3_deleted',
        userId,
        fileId,
        redundantKey: s3Key,
        canonicalKey: canonical.s3Key,
        contentHash: checksum,
      }));
    } catch (err) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'dedup_redundant_s3_delete_error',
        error: err.message,
      }));
    }

    // Update new record pointing to canonical s3Key
    if (typeof filesRepository.updateDedupRecord === 'function') {
      await filesRepository.updateDedupRecord({
        userId,
        fileId,
        contentHash: checksum,
        s3Key: canonical.s3Key,
        isDedup: true,
        canonicalFileId: canonical.fileId,
        canonicalUserId: canonical.userId,
      });
    } else {
      await filesRepository.updateChecksum({ userId, fileId, checksum });
    }

    return {
      checksum,
      isDedup: true,
      canonicalFileId: canonical.fileId,
      canonicalUserId: canonical.userId,
      canonicalS3Key: canonical.s3Key,
    };
  }

  // Not a duplicate: primary canonical record
  if (typeof filesRepository.updateDedupRecord === 'function') {
    await filesRepository.updateDedupRecord({
      userId,
      fileId,
      contentHash: checksum,
      s3Key,
      isDedup: false,
    });
  } else {
    await filesRepository.updateChecksum({ userId, fileId, checksum });
  }

  return { checksum, isDedup: false, refCount: 1 };
}
