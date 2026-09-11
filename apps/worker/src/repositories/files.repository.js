import {
  GetCommand,
  UpdateCommand,
  ScanCommand,
  QueryCommand,
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

  /**
   * Finds uploads in suspicious states:
   * 1. Stuck in UPLOADING or COMPLETING older than stuckCutoffISO.
   * 2. In COMPLETED status without a checksum older than unverifiedCutoffISO.
   */
  async findSuspiciousUploads({ stuckCutoffISO, unverifiedCutoffISO }) {
    const result = await this.docClient.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression:
          '(#status IN (:uploading, :completing) AND #updatedAt < :stuckCutoff) OR ' +
          '(#status = :completed AND (attribute_not_exists(#checksum) OR #checksum = :nullVal) AND #updatedAt < :unverifiedCutoff)',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updatedAt': 'updatedAt',
          '#checksum': 'checksum',
        },
        ExpressionAttributeValues: {
          ':uploading': 'UPLOADING',
          ':completing': 'COMPLETING',
          ':completed': 'COMPLETED',
          ':stuckCutoff': stuckCutoffISO,
          ':unverifiedCutoff': unverifiedCutoffISO,
          ':nullVal': null,
        },
      })
    );
    return result.Items || [];
  }

  /**
   * Queries files by SHA-256 contentHash using the ContentHashIndex GSI.
   */
  async findByContentHash(contentHash) {
    const result = await this.docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'ContentHashIndex',
        KeyConditionExpression: '#contentHash = :hash',
        ExpressionAttributeNames: {
          '#contentHash': 'contentHash',
        },
        ExpressionAttributeValues: {
          ':hash': contentHash,
        },
      })
    );
    return result.Items || [];
  }

  /**
   * Atomically increments refCount on a canonical file.
   */
  async incrementRefCount({ userId, fileId }) {
    const result = await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: FilesRepository.pk(userId),
          SK: FilesRepository.sk(fileId),
        },
        UpdateExpression:
          'SET #refCount = if_not_exists(#refCount, :zero) + :one, #updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: {
          '#refCount': 'refCount',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':now': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    return result.Attributes;
  }

  /**
   * Atomically decrements refCount on a canonical file.
   */
  async decrementRefCount({ userId, fileId }) {
    const result = await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: FilesRepository.pk(userId),
          SK: FilesRepository.sk(fileId),
        },
        UpdateExpression: 'SET #refCount = #refCount - :one, #updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK) AND #refCount > :zero',
        ExpressionAttributeNames: {
          '#refCount': 'refCount',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':now': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    return result.Attributes;
  }

  /**
   * Updates file attributes for deduplication.
   */
  async updateDedupRecord({
    userId,
    fileId,
    contentHash,
    s3Key,
    isDedup,
    canonicalFileId = null,
    canonicalUserId = null,
  }) {
    const now = new Date().toISOString();
    let updateExpression =
      'SET #checksum = :hash, #contentHash = :hash, #s3Key = :s3Key, #isDedup = :isDedup, #updatedAt = :now';
    const attributeNames = {
      '#checksum': 'checksum',
      '#contentHash': 'contentHash',
      '#s3Key': 's3Key',
      '#isDedup': 'isDedup',
      '#updatedAt': 'updatedAt',
    };
    const attributeValues = {
      ':hash': contentHash,
      ':s3Key': s3Key,
      ':isDedup': isDedup,
      ':now': now,
    };

    if (isDedup) {
      updateExpression += ', #canonicalFileId = :canFileId, #canonicalUserId = :canUserId';
      attributeNames['#canonicalFileId'] = 'canonicalFileId';
      attributeNames['#canonicalUserId'] = 'canonicalUserId';
      attributeValues[':canFileId'] = canonicalFileId;
      attributeValues[':canUserId'] = canonicalUserId;
    } else {
      updateExpression += ', #refCount = if_not_exists(#refCount, :one)';
      attributeNames['#refCount'] = 'refCount';
      attributeValues[':one'] = 1;
    }

    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: FilesRepository.pk(userId),
          SK: FilesRepository.sk(fileId),
        },
        UpdateExpression: updateExpression,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: attributeNames,
        ExpressionAttributeValues: attributeValues,
      })
    );
  }

  /**
   * Checks if any active (COMPLETED) file record in DynamoDB references the given s3Key.
   * This is critical for deduplication: if the canonical uploader deletes their file,
   * other deduplicated files may still point to the canonical S3 object.
   *
   * @param {string} s3Key
   * @returns {Promise<boolean>} true if at least one active file references this S3 object
   */
  async hasActiveReferencesToS3Key(s3Key) {
    let exclusiveStartKey = undefined;
    do {
      const result = await this.docClient.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: '#s3Key = :s3Key AND #status = :completed',
          ExpressionAttributeNames: {
            '#s3Key': 's3Key',
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':s3Key': s3Key,
            ':completed': 'COMPLETED',
          },
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      if (result.Items && result.Items.length > 0) {
        return true;
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return false;
  }
}

