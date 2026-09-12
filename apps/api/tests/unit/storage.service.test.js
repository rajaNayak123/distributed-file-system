import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import StorageService from '../../src/services/storage.service.js';
import { UpstreamServiceError, NotFoundError } from '../../src/utils/errors.js';

const s3Mock = mockClient(S3Client);

describe('StorageService', () => {
  let storageService;

  beforeEach(() => {
    s3Mock.reset();
    storageService = new StorageService(new S3Client({ region: 'us-east-1' }), 'test-bucket');
  });

  it('uploadObject returns an etag on success', async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });
    const result = await storageService.uploadObject({
      key: 'users/u1/files/f1',
      body: Buffer.from('hello'),
      contentType: 'text/plain',
    });
    expect(result.etag).toBe('"abc123"');
  });

  it('uploadObject wraps S3 failures as UpstreamServiceError', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('network blip'));
    await expect(
      storageService.uploadObject({ key: 'k', body: Buffer.from('x'), contentType: 'text/plain' })
    ).rejects.toBeInstanceOf(UpstreamServiceError);
  });

  it('headObject reports exists=true with size/etag when object is present', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 42, ETag: '"e"', ContentType: 'text/plain' });
    const result = await storageService.headObject({ key: 'users/u1/files/f1' });
    expect(result).toEqual({ exists: true, size: 42, etag: '"e"', contentType: 'text/plain' });
  });

  it('headObject reports exists=false when S3 returns NotFound (never throws for a missing object)', async () => {
    const notFoundErr = Object.assign(new Error('not found'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    s3Mock.on(HeadObjectCommand).rejects(notFoundErr);
    const result = await storageService.headObject({ key: 'users/u1/files/missing' });
    expect(result).toEqual({ exists: false });
  });

  it('headObject wraps unexpected errors as UpstreamServiceError', async () => {
    s3Mock.on(HeadObjectCommand).rejects(new Error('throttled'));
    await expect(storageService.headObject({ key: 'k' })).rejects.toBeInstanceOf(UpstreamServiceError);
  });

  it('deleteObject succeeds (S3 delete is naturally idempotent)', async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    const result = await storageService.deleteObject({ key: 'users/u1/files/f1' });
    expect(result).toEqual({ deleted: true });
  });

  it('getObject throws NotFoundError when S3 reports NoSuchKey', async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error('no key'), { name: 'NoSuchKey' }));
    await expect(storageService.getObject({ key: 'missing' })).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('presigned URLs (real AWS SDK v3 signer, no mocking)', () => {
    let realStorageService;

    beforeEach(() => {
      const realS3Client = new S3Client({
        region: 'us-east-1',
        credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
      });
      realStorageService = new StorageService(realS3Client, 'test-bucket');
    });

    it('getPresignedPutUrl returns a signed https URL scoped to the bucket and key', async () => {
      const url = await realStorageService.getPresignedPutUrl({
        key: 'users/u1/files/f1',
        contentType: 'application/pdf',
        expiresInSeconds: 900,
      });
      expect(url).toMatch(/^https:\/\//);
      expect(url).toContain('test-bucket');
      expect(url).toContain('users/u1/files/f1');
      expect(url).toContain('X-Amz-Expires=900');
      expect(url).toContain('X-Amz-Signature=');
      expect(url).not.toContain('response-content-disposition');
    });

    it('getPresignedGetUrl returns a signed https URL scoped to the bucket and key', async () => {
      const url = await realStorageService.getPresignedGetUrl({
        key: 'users/u1/files/f1',
        expiresInSeconds: 300,
      });
      expect(url).toMatch(/^https:\/\//);
      expect(url).toContain('test-bucket');
      expect(url).toContain('users/u1/files/f1');
      expect(url).toContain('X-Amz-Expires=300');
      expect(url).toContain('X-Amz-Signature=');
    });

    it('different expiresInSeconds values produce different X-Amz-Expires values', async () => {
      const shortUrl = await realStorageService.getPresignedGetUrl({ key: 'k', expiresInSeconds: 60 });
      const longUrl = await realStorageService.getPresignedGetUrl({ key: 'k', expiresInSeconds: 3600 });
      expect(shortUrl).toContain('X-Amz-Expires=60');
      expect(longUrl).toContain('X-Amz-Expires=3600');
    });

    it('presigned PUT URLs for two different keys are different (each scoped to its own object)', async () => {
      const urlA = await realStorageService.getPresignedPutUrl({
        key: 'users/u1/files/fA',
        contentType: 'text/plain',
        expiresInSeconds: 900,
      });
      const urlB = await realStorageService.getPresignedPutUrl({
        key: 'users/u1/files/fB',
        contentType: 'text/plain',
        expiresInSeconds: 900,
      });
      expect(urlA).not.toBe(urlB);
    });
  });
});
