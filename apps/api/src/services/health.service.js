import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import defaultS3Client from '../clients/s3Client.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const dynamoControlClient = new DynamoDBClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
  ...(config.aws.dynamoEndpoint ? { endpoint: config.aws.dynamoEndpoint } : {}),
});

export async function checkReadiness() {
  const [dynamoOk, s3Ok] = await Promise.all([checkDynamo(), checkS3()]);
  return {
    dynamo: dynamoOk,
    s3: s3Ok,
    ready: dynamoOk && s3Ok,
  };
}

async function checkDynamo() {
  try {
    await dynamoControlClient.send(
      new DescribeTableCommand({ TableName: config.dynamo.usersTable })
    );
    return true;
  } catch (err) {
    logger.warn('readiness_check_dynamo_failed', { error: err.message });
    return false;
  }
}

async function checkS3() {
  try {
    await defaultS3Client.send(
      new HeadBucketCommand({ Bucket: config.s3.bucket })
    );
    return true;
  } catch (err) {
    logger.warn('readiness_check_s3_failed', { error: err.message });
    return false;
  }
}
