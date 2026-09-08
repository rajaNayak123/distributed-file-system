import { HeadObjectCommand } from '@aws-sdk/client-s3';
import defaultS3Client from '../clients/s3Client.js';
import FilesRepository from '../repositories/files.repository.js';
import config from '../config/index.js';

/**
 * Metadata processor — handles FILE_UPLOADED events.
 *
 * Validates that the Content-Type reported by S3 (HeadObject) matches what the
 * client declared when initiating the upload. A mismatch is logged as a warning
 * but is non-fatal — we do not transition the file to FAILED, because:
 *   - Some clients (e.g. browsers) misreport content-type.
 *   - The file is already COMPLETED and accessible.
 *   - Failing the upload retroactively would be surprising and hard to recover from.
 *
 * This is intentionally separate from checksum.processor.js so each concern
 * is independently retryable and observable.
 */
export async function processMetadataValidation(
  { fileId, userId, s3Key },
  { s3Client = defaultS3Client, filesRepository = new FilesRepository() } = {}
) {
  const file = await filesRepository.getFile({ userId, fileId });
  if (!file) {
    return { skipped: true, reason: 'file_not_found' };
  }
  if (file.status !== 'COMPLETED') {
    return { skipped: true, reason: `unexpected_status_${file.status}` };
  }

  let headResult;
  try {
    headResult = await s3Client.send(
      new HeadObjectCommand({
        Bucket: config.s3.bucket,
        Key: s3Key,
      })
    );
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') {
      // Object missing — this is unusual since completeUpload already verified it,
      // but possible if it was deleted concurrently. Log and move on.
      return { skipped: true, reason: 's3_object_missing' };
    }
    throw err; // Unexpected error — let SQS retry.
  }

  const s3ContentType = headResult.ContentType || '';
  const declaredContentType = file.contentType || '';

  // Normalise: strip charset / boundary params before comparing.
  const normalise = (ct) => ct.split(';')[0].trim().toLowerCase();

  if (normalise(s3ContentType) !== normalise(declaredContentType)) {
    // Non-fatal mismatch — log prominently for observability.
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'metadata_content_type_mismatch',
      fileId,
      userId,
      declaredContentType,
      s3ContentType,
    }));
    return { mismatch: true, declaredContentType, s3ContentType };
  }

  return { validated: true, contentType: s3ContentType };
}
