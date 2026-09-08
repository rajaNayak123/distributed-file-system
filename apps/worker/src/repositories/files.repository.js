import {
  GetCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import defaultDocClient from '../clients/dynamoClient.js';
import config from '../config/index.js';

/**
 * Worker-side FilesRepository.
 *
 * Intentionally minimal — only the operations the worker needs:
 *   - getFile              (read a file item to get userId/s3Key/status)
 *   - updateChecksum       (write computed SHA-256 back to the item)
 *   - updateFileStatus     (used by cleanup to mark FAILED)
 *   - findAbandonedUploads (cleanup: UPLOADING past retention threshold)
 *   - findStuckCompleting  (cleanup: COMPLETING past stuck threshold)
 *
 * The key schema (PK = USER#<userId>, SK = FILE#<fileId>) must stay in sync
 * with apps/api/src/repositories/files.repository.js. If you change the key
 * shape there, change it here too.
 */
export default class FilesRepository {
  constructor(
    docClient = defaultDocClient,
    tableName = config.dynamo.filesTable
  ) {
    this.docClient = docClient;
    this.tableName = tableName;
  }

  static pk(userId) {
    return `USER#${userId}`;
  }

  static sk(fileId) {
    return `FILE#${fileId}`;
  }

  async getFile({ userId, fileId }) {
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: FilesRepository.pk(userId),
          SK: FilesRepository.sk(fileId),
        },
      })
    );
    return result.Item || null;
  }

  /**
   * Writes the computed checksum back to the file item.
   * Uses a conditional expression so a concurrent write (e.g. a second worker
   * that somehow got the same message) to an already-checksummed item is a
   * no-op rather than an overwrite.
   */
  async updateChecksum({ userId, fileId, checksum }) {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: FilesRepository.pk(userId),
          SK: FilesRepository.sk(fileId),
        },
        UpdateExpression: 'SET #checksum = :checksum, #updatedAt = :updatedAt',
        // Only update if the item exists. We never create items in the worker.
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: {
          '#checksum': 'checksum',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':checksum': checksum,
          ':updatedAt': new Date().toISOString(),
        },
      })
    );
  }

  /**
   * Transitions a file from one of `fromStatuses` to `toStatus`.
   * Throws if the current status is not one of `fromStatuses` (optimistic
   * concurrency — prevents double-marking as FAILED by two cleanup workers).
   */
  async updateFileStatus({ userId, fileId, fromStatuses, toStatus, extraAttributes = {} }) {
    const now = new Date().toISOString();
    const attributeNames = { '#status': 'status', '#updatedAt': 'updatedAt' };
    const attributeValues = { ':toStatus': toStatus, ':updatedAt': now };

    const fromStatusTokens = fromStatuses.map((_, i) => `:fromStatus${i}`);
    fromStatuses.forEach((status, i) => {
      attributeValues[`:fromStatus${i}`] = status;
    });

    let updateExpression = 'SET #status = :toStatus, #updatedAt = :updatedAt';
    Object.entries(extraAttributes).forEach(([key, value], idx) => {
      const nameToken = `#extra${idx}`;
      const valueToken = `:extra${idx}`;
      attributeNames[nameToken] = key;
      attributeValues[valueToken] = value;
      updateExpression += `, ${nameToken} = ${valueToken}`;
    });

    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: FilesRepository.pk(userId),
          SK: FilesRepository.sk(fileId),
        },
        UpdateExpression: updateExpression,
        ConditionExpression: `attribute_exists(PK) AND #status IN (${fromStatusTokens.join(', ')})`,
        ExpressionAttributeNames: attributeNames,
        ExpressionAttributeValues: attributeValues,
      })
    );
  }

  async findAbandonedUploads(cutoffTimeISO) {
    const result = await this.docClient.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: '#status = :status AND #updatedAt < :cutoff',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':status': 'UPLOADING',
          ':cutoff': cutoffTimeISO,
        },
      })
    );
    return result.Items || [];
  }

  async findStuckCompleting(cutoffTimeISO) {
    const result = await this.docClient.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: '#status = :status AND #updatedAt < :cutoff',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':status': 'COMPLETING',
          ':cutoff': cutoffTimeISO,
        },
      })
    );
    return result.Items || [];
  }
}
