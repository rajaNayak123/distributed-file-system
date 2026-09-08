/**
 * Integration test: worker crash mid-processing
 *
 * Verifies that if a processor throws (simulating a worker crash before it
 * can delete the message), the message is NOT deleted from SQS and becomes
 * visible again after the visibility timeout, allowing a healthy worker (or
 * retry) to process it successfully.
 *
 * How we simulate "visibility timeout expires" quickly without waiting 300s:
 *   Use ChangeMessageVisibility to set the timeout to 0, making the message
 *   immediately visible again. This is the standard integration testing
 *   technique for SQS at-least-once delivery.
 *
 * Requires LocalStack + DynamoDB Local (same as fileUploaded.pipeline.test.js).
 */

import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
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
  const userId = `user-crash-${Date.now()}`;
  const fileId = `file-crash-${Date.now()}`;
  const s3Key = `users/${userId}/files/${fileId}`;
  const fileContent = Buffer.from('crash test file content');

  beforeAll(async () => {
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
    const messageBody = JSON.stringify({
      eventType: 'FILE_UPLOADED',
      fileId,
      userId,
      s3Key,
      publishedAt: new Date().toISOString(),
    });

    // 1. Publish the message.
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: messageBody,
    }));

    // 2. First poll: use a crashing dispatcher (simulates worker crash).
    const crashingDispatch = jest.fn().mockRejectedValue(new Error('Simulated worker crash'));

    await pollOnce({
      sqsClient,
      queueUrl: QUEUE_URL,
      dispatchFn: crashingDispatch,
    });

    // Verify the crashing dispatcher was called.
    expect(crashingDispatch).toHaveBeenCalledTimes(1);

    // 3. The message was NOT deleted (crash happened before DeleteMessage).
    //    Use ChangeMessageVisibility to make it immediately visible again
    //    (shortcut — normally we'd wait for the 300s visibility timeout).
    const receiveResult = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
      // Use a very short visibility timeout for this receive so we can
      // immediately re-receive it.
      VisibilityTimeout: 1,
    }));

    // The message should still be in the queue (not deleted by the crashing worker).
    // In LocalStack, it may appear immediately because the visibility timeout expired.
    // We accept either "message still present" or "message re-delivered" as success.
    const msgs = receiveResult.Messages || [];
    if (msgs.length > 0) {
      // Message is visible — make it immediately re-receivable.
      await sqsClient.send(new ChangeMessageVisibilityCommand({
        QueueUrl: QUEUE_URL,
        ReceiptHandle: msgs[0].ReceiptHandle,
        VisibilityTimeout: 0,
      }));
    }

    // 4. Second poll: use the real dispatcher — should succeed.
    await pollOnce({
      sqsClient,
      queueUrl: QUEUE_URL,
      // Use default real dispatcher (no override = uses consumer.js dispatch).
    });

    // 5. Assert checksum was written by the second (successful) worker.
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
