import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import defaultSqsClient from './clients/sqsClient.js';
import config from './config/index.js';
import { processFileUploaded } from './processors/checksum.processor.js';
import { processMetadataValidation } from './processors/metadata.processor.js';
import { processReconciliation } from './processors/reconciliation.processor.js';

/**
 * Dispatch a parsed message body to the correct processor.
 *
 * CONTRACT (critical for SQS at-least-once delivery):
 *   - This function throws if ANY processor throws.
 *   - The caller (pollOnce / startConsumer) MUST NOT call DeleteMessage if this
 *     throws — the message stays in-flight and re-appears after the visibility
 *     timeout, allowing another worker (or the same worker after restart) to
 *     retry it.
 *   - After maxReceiveCount (5) failed receives, SQS automatically moves the
 *     message to the DLQ. No application-level counter is needed.
 */
export async function dispatch(message) {
  const { eventType } = message;

  switch (eventType) {
    case 'FILE_UPLOADED':
      // Run checksum and metadata validation for every completed upload.
      // They are separate processors so each is independently retryable and
      // observable; run sequentially to keep per-message concurrency simple.
      await processFileUploaded(message);
      await processMetadataValidation(message);
      return;

    case 'RECONCILE':
      await processReconciliation(message);
      return;

    default:
      // Unknown event type — log and ack (delete) so it doesn't block the queue.
      // This prevents unknown message types from filling the DLQ with guaranteed-
      // unprocessable messages. Log prominently for operator awareness.
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'unknown_event_type',
        eventType,
        message,
      }));
      return;
  }
}

/**
 * Receive and process one batch of SQS messages.
 *
 * @param {object} opts - Injectable dependencies for testing.
 * @returns {number} Count of messages successfully processed (deleted).
 */
export async function pollOnce({
  sqsClient = defaultSqsClient,
  queueUrl = config.sqs.queueUrl,
  dispatchFn = dispatch,
} = {}) {
  const receiveResult = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: config.sqs.maxMessages,
      WaitTimeSeconds: config.sqs.waitTimeSeconds, // long-poll
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
      // Unparseable body — ack so it doesn't loop forever.
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
      // ── CRITICAL: dispatch BEFORE DeleteMessage ────────────────────────────
      // If dispatch() throws, we do NOT reach DeleteMessage. SQS keeps the
      // message in-flight until the visibility timeout expires, then
      // re-delivers it for retry. After maxReceiveCount failures, SQS
      // moves the message to the DLQ automatically.
      await dispatchFn(parsed);

      // ── Only delete after successful processing ────────────────────────────
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
      // ── Do NOT delete — let SQS re-deliver ───────────────────────────────
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
      // Do not rethrow — continue processing other messages in the batch.
    }
  }

  return processed;
}

/**
 * Start the long-poll consumer loop.
 *
 * Runs continuously until the process is killed (SIGTERM/SIGINT).
 * Errors in the poll loop itself (e.g. SQS unreachable) are caught and
 * logged; the loop sleeps 5s and retries rather than crashing the worker.
 */
export async function startConsumer({ sqsClient, queueUrl, dispatchFn } = {}) {
  console.log(JSON.stringify({
    level: 'info',
    event: 'consumer_started',
    queueUrl: queueUrl || config.sqs.queueUrl,
    waitTimeSeconds: config.sqs.waitTimeSeconds,
    maxMessages: config.sqs.maxMessages,
  }));

  // eslint-disable-next-line no-constant-condition
  while (true) {
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
