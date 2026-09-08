import MetadataService from '../services/metadata.service.js';
import config from '../config/index.js';

export default class IdempotencyRepository {
  constructor(
    metadataService = new MetadataService(),
    tableName = config.idempotency.tableName,
    ttlSeconds = config.idempotency.ttlSeconds
  ) {
    this.metadataService = metadataService;
    this.tableName = tableName;
    this.ttlSeconds = ttlSeconds;
  }

  async createInProgress({ userId, idempotencyKey, requestHash }) {
    const now = new Date();
    const item = {
      PK: userId,
      SK: idempotencyKey,
      requestHash,
      status: 'IN_PROGRESS',
      result: null,
      statusCode: null,
      createdAt: now.toISOString(),
      expiresAt: Math.floor(now.getTime() / 1000) + this.ttlSeconds,
    };

    try {
      await this.metadataService.putItem({
        tableName: this.tableName,
        item,
        conditionExpression: 'attribute_not_exists(PK)',
      });
      return item;
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        return null; 
      }
      throw err;
    }
  }

  async get({ userId, idempotencyKey }) {
    return this.metadataService.getItem({
      tableName: this.tableName,
      key: { PK: userId, SK: idempotencyKey },
    });
  }

  async markCompleted({ userId, idempotencyKey, statusCode, result }) {
    return this.metadataService.updateItem({
      tableName: this.tableName,
      key: { PK: userId, SK: idempotencyKey },
      updateExpression: 'SET #status = :status, #result = :result, #code = :code',
      expressionAttributeNames: {
        '#status': 'status',
        '#result': 'result',
        '#code': 'statusCode',
      },
      expressionAttributeValues: {
        ':status': 'COMPLETED',
        ':result': JSON.stringify(result),
        ':code': statusCode,
      },
      returnValues: 'ALL_NEW',
    });
  }

  async delete({ userId, idempotencyKey }) {
    return this.metadataService.deleteItem({
      tableName: this.tableName,
      key: { PK: userId, SK: idempotencyKey },
    });
  }
}
