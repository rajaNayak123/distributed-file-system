import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  CreateTableCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import { pollOnce } from '../../src/consumer.js';
import { checkServicesAvailable } from '../helpers/serviceCheck.js';

const REGION = 'us-east-1';
const SQS_ENDPOINT = process.env.SQS_ENDPOINT || 'http://localhost:4566';
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:4566';
const DYNAMO_ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
const QUEUE_URL = process.env.SQS_QUEUE_URL;
const BUCKET = process.env.S3_BUCKET || 'file-storage-dev';
const FILES_TABLE = process.env.DYNAMODB_FILES_TABLE || 'Files';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };

const sqsClient = new SQSClient({ region: REGION, endpoint: SQS_ENDPOINT, credentials: CREDS });
const s3Client = new S3Client({ region: REGION, endpoint: S3_ENDPOINT, forcePathStyle: true, credentials: CREDS });
const dynamoRaw = new DynamoDBClient({ region: REGION, endpoint: DYNAMO_ENDPOINT, credentials: CREDS });
const dynamo = DynamoDBDocumentClient.from(dynamoRaw, { marshallOptions: { removeUndefinedValues: true } });

async function ensureTable() {
  try {
    await dynamoRaw.send(new CreateTableCommand({
      TableName: FILES_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    }));
  } catch (err) {
    if (!err.message?.includes('already')) throw err;
  }
}

async function ensureBucket() {
  try {
    await s3Client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    if (!err.message?.includes('already') && err.name !== 'BucketAlreadyOwnedByYou') throw err;
  }
}

describe('worker crash mid-processing — integration', () => {
  let servicesAvailable = false;
  const userId = `user-crash-${Date.now()}`;
  const fileId = `file-crash-${Date.now()}`;
  const s3Key = `users/${userId}/files/${fileId}`;
  const fileContent = Buffer.from('crash test file content');

  beforeAll(async () => {
    servicesAvailable = await checkServicesAvailable();
    if (!servicesAvailable) {
      console.warn('⚠️  Skipping integration test: LocalStack / DynamoDB Local are not running.');
      return;
    }

    await ensureTable();
    await ensureBucket();

    await dynamo.send(new PutCommand({
      TableName: FILES_TABLE,
      Item: {
        PK: `USER#${userId}`,
        SK: `FILE#${fileId}`,
        userId,
        fileId,
        s3Key,
        fileName: 'crash-test.bin',
        contentType: 'application/octet-stream',
        status: 'COMPLETED',
        checksum: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }));

    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      Body: fileContent,
      ContentType: 'application/octet-stream',
    }));
  });

  it('message is re-delivered and processed after simulated worker crash', async () => {
    if (!servicesAvailable) return;
    const messageBody = JSON.stringify({
      eventType: 'FILE_UPLOADED',
      fileId,
      userId,
      s3Key,
      publishedAt: new Date().toISOString(),
    });

    await sqsClient.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: messageBody,
    }));

    const crashingDispatch = jest.fn().mockRejectedValue(new Error('Simulated worker crash'));

    await pollOnce({
      sqsClient,
      queueUrl: QUEUE_URL,
      dispatchFn: crashingDispatch,
    });

    expect(crashingDispatch).toHaveBeenCalledTimes(1);

    const receiveResult = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
      VisibilityTimeout: 1,
    }));

    const msgs = receiveResult.Messages || [];
    if (msgs.length > 0) {
      await sqsClient.send(new ChangeMessageVisibilityCommand({
        QueueUrl: QUEUE_URL,
        ReceiptHandle: msgs[0].ReceiptHandle,
        VisibilityTimeout: 0,
      }));
    }

    await pollOnce({
      sqsClient,
      queueUrl: QUEUE_URL,
    });

    const result = await dynamo.send(new GetCommand({
      TableName: FILES_TABLE,
      Key: { PK: `USER#${userId}`, SK: `FILE#${fileId}` },
    }));

    const item = result.Item;
    expect(item).toBeDefined();
    expect(item.checksum).toBeDefined();
    expect(item.checksum).toHaveLength(64);

    const expected = createHash('sha256').update(fileContent).digest('hex');
    expect(item.checksum).toBe(expected);
  });
});
