import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import defaultSqsClient from './clients/sqsClient.js';
import config from './config/index.js';
import { processFileUploaded } from './processors/checksum.processor.js';
import { processMetadataValidation } from './processors/metadata.processor.js';
import { processReconciliation } from './processors/reconciliation.processor.js';

export async function dispatch(message) {
  const { eventType } = message;

  switch (eventType) {
    case 'FILE_UPLOADED':
      await processFileUploaded(message);
      await processMetadataValidation(message);
      return;

    case 'RECONCILE':
      await processReconciliation(message);
      return;

    default:
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'unknown_event_type',
        eventType,
        message,
      }));
      return;
  }
}

export async function pollOnce({
  sqsClient = defaultSqsClient,
  queueUrl = config.sqs.queueUrl,
  dispatchFn = dispatch,
} = {}) {
  const receiveResult = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: config.sqs.maxMessages,
      WaitTimeSeconds: config.sqs.waitTimeSeconds,
      AttributeNames: ['ApproximateReceiveCount'],
      MessageAttributeNames: ['All'],
    })
  );

  const messages = receiveResult.Messages || [];
  if (messages.length === 0) return 0;

  let processed = 0;

  for (const sqsMessage of messages) {
    let parsed;
    try {
      parsed = JSON.parse(sqsMessage.Body);
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'message_parse_failed',
        messageId: sqsMessage.MessageId,
        error: err.message,
      }));
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: sqsMessage.ReceiptHandle,
        })
      );
      continue;
    }

    const receiveCount = parseInt(
      sqsMessage.Attributes?.ApproximateReceiveCount || '1',
      10
    );

    console.log(JSON.stringify({
      level: 'info',
      event: 'message_received',
      messageId: sqsMessage.MessageId,
      eventType: parsed.eventType,
      receiveCount,
    }));

    try {
      await dispatchFn(parsed);

      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: sqsMessage.ReceiptHandle,
        })
      );

      console.log(JSON.stringify({
        level: 'info',
        event: 'message_processed',
        messageId: sqsMessage.MessageId,
        eventType: parsed.eventType,
      }));
      processed += 1;
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'message_processing_failed',
        messageId: sqsMessage.MessageId,
        eventType: parsed.eventType,
        receiveCount,
        error: err.message,
        stack: err.stack,
        note: 'Message NOT deleted; will be re-delivered after visibility timeout',
      }));
    }
  }

  return processed;
}

export async function startConsumer({ sqsClient, queueUrl, dispatchFn } = {}) {
  console.log(JSON.stringify({
    level: 'info',
    event: 'consumer_started',
    queueUrl: queueUrl || config.sqs.queueUrl,
    waitTimeSeconds: config.sqs.waitTimeSeconds,
    maxMessages: config.sqs.maxMessages,
  }));

  for (;;) {
    try {
      await pollOnce({ sqsClient, queueUrl, dispatchFn });
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'consumer_poll_error',
        error: err.message,
        note: 'Sleeping 5s before retry',
      }));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
