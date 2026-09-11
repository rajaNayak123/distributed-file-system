import { NotFoundError } from '../../src/utils/errors.js';

// Shared, module-level "bucket" simulating S3 object existence, keyed by S3 key.
let objects = new Map();
let putUrlCounter = 0;

export default class FakeStorageService {
  async uploadObject({ key, contentType }) {
    objects.set(key, { size: 0, etag: '"fake-etag"', contentType });
    return { etag: '"fake-etag"' };
  }

  async getObject({ key }) {
    const obj = objects.get(key);
    if (!obj) {
      throw new NotFoundError('Object not found in storage');
    }
    return obj;
  }

  async headObject({ key }) {
    const obj = objects.get(key);
    if (!obj) return { exists: false };
    return { exists: true, size: obj.size, etag: obj.etag, contentType: obj.contentType };
  }

  async deleteObject({ key }) {
    objects.delete(key);
    return { deleted: true };
  }

  async getPresignedPutUrl({ key }) {
    putUrlCounter += 1;
    return `https://fake-s3.local/${key}?put-token=${putUrlCounter}`;
  }

  async getPresignedGetUrl({ key }) {
    return `https://fake-s3.local/${key}?get-token=${Date.now()}`;
  }

  async createMultipartUpload({ key, contentType }) {
    return { uploadId: `fake-upload-id-${Date.now()}` };
  }

  async getPresignedUploadPartUrl({ key, uploadId, partNumber }) {
    return `https://fake-s3.local/${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }

  async completeMultipartUpload({ key, uploadId, parts }) {
    return { etag: '"fake-multipart-etag"' };
  }

  async abortMultipartUpload({ key, uploadId }) {
    return { aborted: true };
  }

  /**
   * Test helper standing in for "the client actually PUT bytes to the
   * presigned URL". Not part of the real StorageService interface.
   */
  static __simulateClientPut(key, { size = 1024, contentType = 'application/octet-stream' } = {}) {
    objects.set(key, { size, etag: `"etag-${key}"`, contentType });
  }

  static __objectExists(key) {
    return objects.has(key);
  }

  static __reset() {
    objects = new Map();
    putUrlCounter = 0;
  }
}
