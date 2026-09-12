import {
  GetCommand,
  UpdateCommand,
  ScanCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import defaultDocClient from '../clients/dynamoClient.js';
import config from '../config/index.js';

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

  async updateChecksum({ userId, fileId, checksum }) {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: FilesRepository.pk(userId),
          SK: FilesRepository.sk(fileId),
        },
        UpdateExpression: 'SET #checksum = :checksum, #updatedAt = :updatedAt',
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
