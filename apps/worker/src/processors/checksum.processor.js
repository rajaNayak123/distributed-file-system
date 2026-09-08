import { createHash } from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import defaultS3Client from '../clients/s3Client.js';
import FilesRepository from '../repositories/files.repository.js';
import config from '../config/index.js';

/**
 * Checksum processor — handles FILE_UPLOADED events.
 *
 * Steps:
 *  1. Fetch the file item from DynamoDB to verify it's still COMPLETED and
 *     hasn't already been checksummed (idempotency guard).
 *  2. Stream the S3 object body through a SHA-256 hasher.
 *  3. Write the hex digest back to DynamoDB via updateChecksum.
 *
 * Throwing from this function intentionally does NOT delete the SQS message,
 * so SQS will re-deliver it after the visibility timeout. After maxReceiveCount
 * (5) failed deliveries SQS moves the message to the DLQ automatically.
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

  // 3. Write checksum back to DynamoDB.
  await filesRepository.updateChecksum({ userId, fileId, checksum });

  return { checksum };
}
