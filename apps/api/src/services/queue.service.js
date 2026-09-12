import { SendMessageCommand } from '@aws-sdk/client-sqs';
import defaultSqsClient from '../clients/sqsClient.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

export default class QueueService {
  constructor(sqsClient = defaultSqsClient, queueUrl = config.sqs.queueUrl) {
    this.sqsClient = sqsClient;
    this.queueUrl = queueUrl;
  }

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
      logger.error('file_uploaded_event_publish_failed', {
        fileId,
        userId,
        operation: 'publishFileUploaded',
        error: err.message,
      });
    }
  }
}
