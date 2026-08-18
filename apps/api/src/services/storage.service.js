import {
  PutObjectCommand,
  GetObjectCommand
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
}