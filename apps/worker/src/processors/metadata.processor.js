import { HeadObjectCommand } from '@aws-sdk/client-s3';
import defaultS3Client from '../clients/s3Client.js';
import FilesRepository from '../repositories/files.repository.js';
import config from '../config/index.js';

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
      return { skipped: true, reason: 's3_object_missing' };
    }
    throw err;
  }

  const s3ContentType = headResult.ContentType || '';
  const declaredContentType = file.contentType || '';

  const normalise = (ct) => ct.split(';')[0].trim().toLowerCase();

  if (normalise(s3ContentType) !== normalise(declaredContentType)) {
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
