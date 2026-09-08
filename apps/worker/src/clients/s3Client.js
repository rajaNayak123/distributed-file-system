import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import config from '../config/index.js';

const requestHandler = new NodeHttpHandler({
  connectionTimeout: config.timeouts.sdkConnectMs,
  // S3 streaming (GetObject for checksum) needs a generous socket timeout.
  socketTimeout: Math.max(config.timeouts.sdkSocketMs, 300_000), // 5 min min
});

const s3Client = new S3Client({
  region: config.aws.region,
  endpoint: config.aws.s3Endpoint,
  forcePathStyle: config.aws.forcePathStyle,
  maxAttempts: config.retries.maxAttempts,
  requestHandler,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

export default s3Client;
