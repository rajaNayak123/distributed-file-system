import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import config from '../config/index.js';

const clientConfig = {
  region: config.aws.region,
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
