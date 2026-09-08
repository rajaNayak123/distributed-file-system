/**
 * Integration test: DLQ routing after repeated failures
 *
 * Verifies that after maxReceiveCount (5) failed receive+process cycles, SQS
 * automatically routes the message to the dead-letter queue.
 *
 * Technique:
 *   We receive the message, do NOT delete it, and set VisibilityTimeout=0 to
 *   immediately make it visible again. We repeat this maxReceiveCount times
 *   (simulating 5 consecutive failing workers). After the 5th failure, SQS
 *   (LocalStack) should move the message to the DLQ.
 *
 * NOTE: LocalStack DLQ redrive behaviour is tested here. LocalStack 3.x
 * honours maxReceiveCount and moves messages to the DLQ after the configured
 * number of failed receive cycles. If this test fails on your version of
 * LocalStack, check that SQS service is enabled and the RedrivePolicy was
 * applied during init (01-create-resources.sh).
 *
 * Requires LocalStack running with the queues already created.
 */

import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const REGION = 'us-east-1';
const SQS_ENDPOINT = process.env.SQS_ENDPOINT || 'http://localhost:4566';
const QUEUE_URL = process.env.SQS_QUEUE_URL;
const DLQ_URL = process.env.SQS_DLQ_URL;
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };

const sqsClient = new SQSClient({ region: REGION, endpoint: SQS_ENDPOINT, credentials: CREDS });

const MAX_RECEIVE_COUNT = 5;

/**
 * Receives one message and immediately makes it visible again (simulates a
 * failing worker that never deletes the message).
 * Returns the message, or null if no messages are available.
 */
async function receiveAndFail(queueUrl, waitTime = 5) {
  const result = await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: waitTime,
    VisibilityTimeout: 5, // 5s before it's visible again for the next attempt
    AttributeNames: ['ApproximateReceiveCount'],
  }));

  const msgs = result.Messages || [];
  if (msgs.length === 0) return null;

  const msg = msgs[0];

  // Immediately make the message visible again (0s) to simulate fast retry.
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
    if (!DLQ_URL) {
      console.warn('SQS_DLQ_URL not set — skipping DLQ routing test');
      return;
    }

    // 1. Publish a test message to the main queue.
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

    // 2. Simulate MAX_RECEIVE_COUNT consecutive failing workers.
    for (let attempt = 1; attempt <= MAX_RECEIVE_COUNT; attempt++) {
      // Small delay to let LocalStack process the visibility change.
      await new Promise((r) => setTimeout(r, 500));

      const msg = await receiveAndFail(QUEUE_URL);
      if (msg) {
        console.log(`  Attempt ${attempt}: received message, receive count = ${msg.receiveCount}, did NOT delete`);
      } else {
        console.log(`  Attempt ${attempt}: no message visible yet, retrying...`);
        // Try again — LocalStack may need a moment.
        await new Promise((r) => setTimeout(r, 1000));
        const retry = await receiveAndFail(QUEUE_URL, 2);
        if (retry) {
          console.log(`  Attempt ${attempt} (retry): received message, receive count = ${retry.receiveCount}`);
        }
      }
    }

    // 3. Give LocalStack time to move the message to the DLQ.
    await new Promise((r) => setTimeout(r, 2000));

    // 4. Assert message appears in the DLQ.
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
  }, 60000); // Allow 60s for this test — DLQ moves can take time in LocalStack.
});
