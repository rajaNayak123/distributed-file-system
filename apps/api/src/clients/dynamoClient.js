import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import config from '../config/index.js';

const requestHandler = new NodeHttpHandler({
  connectionTimeout: config.timeouts.sdkConnectMs,
  socketTimeout: config.timeouts.sdkSocketMs,
});

const clientConfig = {
  region: config.aws.region,
  maxAttempts: config.retries.maxAttempts,
  requestHandler,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
};
if (config.aws.dynamoEndpoint) {
  clientConfig.endpoint = config.aws.dynamoEndpoint;
}
const baseClient = new DynamoDBClient(clientConfig);

const documentClient = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export default documentClient;
