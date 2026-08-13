import { S3Client } from '@aws-sdk/client-s3';
import config from '../config/index.js';

const s3Client = new S3Client({
  region: config.aws.region,
  endpoint: config.aws.s3Endpoint,
  forcePathStyle: config.aws.forcePathStyle,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

export default s3Client;
