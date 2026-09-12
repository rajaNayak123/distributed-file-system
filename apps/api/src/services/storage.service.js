import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import defaultS3Client from '../clients/s3Client.js';
import config from '../config/index.js';
import { UpstreamServiceError, NotFoundError } from '../utils/errors.js';

export default class StorageService{
  constructor(s3Client = defaultS3Client, bucket = config.s3.bucket){
    this.s3Client = s3Client
    this.bucket =  bucket
  }

  async uploadObject({key, body, contentType}){
    try {
      const result = await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: contentType
        })
      )
      return { etag: result.ETag };
    } catch (error) {
      throw new UpstreamServiceError('Failed to upload object to S3', { cause: error.message });
    }
  }

  async getObject({ key }) {
    try {
      const result = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return result;
    } catch (error) {
      if (error.name === 'NoSuchKey') {
        throw new NotFoundError('Object not found in storage');
      }
      throw new UpstreamServiceError('Failed to get object from S3', { cause: error.message });
    }
  }

  async headObject({key}){
    try {
      const result = await this.s3Client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      )
      return{
        exists: true,
        size: result.ContentLength,
        etag: result.ETag,
        contentType: result.ContentType,
      }
    } catch (error) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return { exists: false };
      }
      throw new UpstreamServiceError('Failed to head object in S3', { cause: error.message });
    }
  }

  async deleteObject({ key }) {
    try {
      await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return { deleted: true };
    } catch (err) {
      throw new UpstreamServiceError('Failed to delete object from S3', { cause: err.message });
    }
  }

  async getPresignedPutUrl({ key, contentType, expiresInSeconds }) {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      });
      const url = await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
      return url;
    } catch (err) {
      throw new UpstreamServiceError('Failed to generate presigned PUT URL', {
        cause: err.message,
      });
    }
  }

  async getPresignedGetUrl({ key, expiresInSeconds }) {
    try {
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
      const url = await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
      return url;
    } catch (err) {
      throw new UpstreamServiceError('Failed to generate presigned GET URL', {
        cause: err.message,
      });
    }
  }

  async createMultipartUpload({ key, contentType }) {
    try {
      const result = await this.s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: contentType,
        })
      );
      return { uploadId: result.UploadId };
    } catch (err) {
      throw new UpstreamServiceError('Failed to create multipart upload', { cause: err.message });
    }
  }

  async getPresignedUploadPartUrl({ key, uploadId, partNumber, expiresInSeconds }) {
    try {
      const command = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
      return url;
    } catch (err) {
      throw new UpstreamServiceError('Failed to generate presigned upload part URL', {
        cause: err.message,
      });
    }
  }

  async completeMultipartUpload({ key, uploadId, parts }) {
    try {
      const sortedParts = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
      const result = await this.s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sortedParts,
          },
        })
      );
      return result;
    } catch (err) {
      throw new UpstreamServiceError('Failed to complete multipart upload', { cause: err.message });
    }
  }

  async abortMultipartUpload({ key, uploadId }) {
    try {
      await this.s3Client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        })
      );
      return { aborted: true };
    } catch (err) {
      throw new UpstreamServiceError('Failed to abort multipart upload', { cause: err.message });
    }
  }
}