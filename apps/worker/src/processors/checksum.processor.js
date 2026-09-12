import { createHash } from 'crypto';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import defaultS3Client from '../clients/s3Client.js';
import FilesRepository from '../repositories/files.repository.js';
import config from '../config/index.js';

export async function processFileUploaded(
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

  if (file.checksum && file.checksum !== null) {
    return { skipped: true, reason: 'already_checksummed' };
  }

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
    const canonical = otherMatches.find((m) => !m.isDedup) || otherMatches[0];

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
