import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { checkServicesAvailable } from '../helpers/serviceCheck.js';

const REGION = 'us-east-1';
const SQS_ENDPOINT = process.env.SQS_ENDPOINT || 'http://localhost:4566';
const QUEUE_URL = process.env.SQS_QUEUE_URL;
const DLQ_URL = process.env.SQS_DLQ_URL;
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };

const sqsClient = new SQSClient({ region: REGION, endpoint: SQS_ENDPOINT, credentials: CREDS });

const MAX_RECEIVE_COUNT = 5;

async function receiveAndFail(queueUrl) {
  const result = await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 2,
    VisibilityTimeout: 5,
    AttributeNames: ['ApproximateReceiveCount'],
  }));

  const msgs = result.Messages || [];
  if (msgs.length === 0) return null;

  const msg = msgs[0];

  await sqsClient.send(new ChangeMessageVisibilityCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: msg.ReceiptHandle,
    VisibilityTimeout: 0,
  }));

  return {
    messageId: msg.MessageId,
    body: JSON.parse(msg.Body),
    receiveCount: parseInt(msg.Attributes?.ApproximateReceiveCount || '1', 10),
  };
}

describe('DLQ routing after repeated failures — integration', () => {
  const testEventType = 'FILE_UPLOADED';
  const testFileId = `dlq-test-${Date.now()}`;

  it(`routes message to DLQ after ${MAX_RECEIVE_COUNT} failed receives`, async () => {
    const servicesAvailable = await checkServicesAvailable();
    if (!servicesAvailable) {
      console.warn('⚠️  Skipping DLQ integration test: LocalStack / SQS are not running.');
      return;
    }

    if (!DLQ_URL) {
      console.warn('SQS_DLQ_URL not set — skipping DLQ routing test');
      return;
    }

    const sentMsg = await sqsClient.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({
        eventType: testEventType,
        fileId: testFileId,
        userId: 'dlq-test-user',
        s3Key: `users/dlq-test-user/files/${testFileId}`,
        publishedAt: new Date().toISOString(),
      }),
    }));

    console.log(`Published message ${sentMsg.MessageId}, will receive+fail ${MAX_RECEIVE_COUNT} times`);

    for (let attempt = 1; attempt <= MAX_RECEIVE_COUNT; attempt++) {
      await new Promise((r) => setTimeout(r, 500));

      const msg = await receiveAndFail(QUEUE_URL);
      if (msg) {
        console.log(`  Attempt ${attempt}: received message, receive count = ${msg.receiveCount}, did NOT delete`);
      } else {
        console.log(`  Attempt ${attempt}: no message visible yet, retrying...`);
        await new Promise((r) => setTimeout(r, 1000));
        const retry = await receiveAndFail(QUEUE_URL, 2);
        if (retry) {
          console.log(`  Attempt ${attempt} (retry): received message, receive count = ${retry.receiveCount}`);
        }
      }
    }

    await new Promise((r) => setTimeout(r, 2000));

    const dlqResult = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: DLQ_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 10,
      AttributeNames: ['All'],
    }));

    const dlqMessages = dlqResult.Messages || [];
    console.log(`DLQ contains ${dlqMessages.length} message(s)`);

    const ourMessage = dlqMessages.find((m) => {
      try {
        const body = JSON.parse(m.Body);
        return body.fileId === testFileId;
      } catch {
        return false;
      }
    });

    expect(ourMessage).toBeDefined();
    const body = JSON.parse(ourMessage.Body);
    expect(body.fileId).toBe(testFileId);
    expect(body.eventType).toBe(testEventType);

    console.log(`✅ Message correctly landed in DLQ after ${MAX_RECEIVE_COUNT} failed attempts`);
  }, 60000);
});
