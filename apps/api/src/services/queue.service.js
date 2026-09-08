import { SendMessageCommand } from '@aws-sdk/client-sqs';
import defaultSqsClient from '../clients/sqsClient.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

export default class QueueService {
  constructor(sqsClient = defaultSqsClient, queueUrl = config.sqs.queueUrl) {
    this.sqsClient = sqsClient;
    this.queueUrl = queueUrl;
  }

  /**
   * Publishes a FILE_UPLOADED event to SQS after an upload is marked COMPLETED.
   *
   * This is fire-and-forget from the caller's perspective: the upload is already
   * durably COMPLETED in DynamoDB before this is called. If the publish fails,
   * we log and swallow the error — the client must not see a 500 for a side-effect
   * that doesn't affect the resource they just created. The checksum job is
   * best-effort on first publish; the cleanup/reconciliation worker in Phase 7
   * will catch any items whose checksum is still null after a threshold.
   *
   * NOTE: In production, S3 Event Notifications on s3:ObjectCreated:* could publish
   * directly to SQS without this explicit call. For local dev (LocalStack), explicit
   * publishing keeps the pipeline deterministic and testable without bucket-
   * notification config. See docs/decisions.md §Phase 6.
   */
  async publishFileUploaded({ fileId, userId, s3Key }) {
    const message = {
      eventType: 'FILE_UPLOADED',
      fileId,
      userId,
      s3Key,
      publishedAt: new Date().toISOString(),
    };

    try {
      await this.sqsClient.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(message),
          MessageAttributes: {
            eventType: {
              DataType: 'String',
              StringValue: 'FILE_UPLOADED',
            },
          },
        })
      );
      logger.info('file_uploaded_event_published', { fileId, userId, operation: 'publishFileUploaded' });
    } catch (err) {
      // Non-fatal: the upload is already COMPLETED. Log prominently so it's
      // visible in ops tooling, but do not propagate to the caller.
      logger.error('file_uploaded_event_publish_failed', {
        fileId,
        userId,
        operation: 'publishFileUploaded',
        error: err.message,
      });
    }
  }
}
