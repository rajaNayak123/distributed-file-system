import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand
} from '@aws-sdk/client-s3';
import defaultS3Client from '../clients/s3Client.js';
import config from '../config/index.js';
import { UpstreamServiceError } from '../utils/errors.js';

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

  async getObject({Key}){
    try {
      const result = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      ) 
      return result
    } catch (error) {
      if (error.name === 'NoSuchKey') {
        throw new NotFoundError('Object not found in storage');
      }
      throw new UpstreamServiceError('Failed to get object from S3', { cause: error.message });
    }
  }

  // Verifies an object exists and returns its size/etag without downloading it.Used by uploads.service.js to confirm a client's PUT actually landed before we ever mark an upload COMPLETED we never trust the client's say so.
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
}