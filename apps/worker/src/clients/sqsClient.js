import { SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import config from '../config/index.js';

const requestHandler = new NodeHttpHandler({
  connectionTimeout: config.timeouts.sdkConnectMs,
  socketTimeout: config.timeouts.sdkSocketMs,
});

const sqsClient = new SQSClient({
  region: config.aws.region,
  endpoint: config.aws.sqsEndpoint,
  maxAttempts: config.retries.maxAttempts,
  requestHandler,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

export default sqsClient;
