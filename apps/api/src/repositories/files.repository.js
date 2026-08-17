import MetadataService from "../services/metadata.service.js"
import config from '../config/index.js';
import { ConflictError } from '../utils/errors.js';

export default class FilesRepository{
  constructor(metadataService = new MetadataService(), tableName = config.dynamo.filesTable){
    this.metadataService = metadataService
    this.tableName = tableName
  }

  static pk(userId) {
    return `USER#${userId}`;
  }

  static sk(fileId) {
    return `FILE#${fileId}`;
  }

  async createFile(fileItem) {
    const item = {
      PK: FilesRepository.pk(fileItem.userId),
      SK: FilesRepository.sk(fileItem.fileId),
      ...fileItem,
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
        throw new ConflictError('A file with this id already exists');
      }
      throw err;
    }
  }

  async getFile({ userId, fileId }) {
    const item = await this.metadataService.getItem({
      tableName: this.tableName,
      key: { PK: FilesRepository.pk(userId), SK: FilesRepository.sk(fileId) },
    });
    return item;
  }

  async listFilesForUser({ userId, includeIncomplete = false }) {
    const items = await this.metadataService.query({
      tableName: this.tableName,
      keyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      expressionAttributeValues: {
        ':pk': FilesRepository.pk(userId),
        ':skPrefix': 'FILE#',
      },
    });
    if (includeIncomplete) return items;
    return items.filter((item) => item.status === 'COMPLETED');
  }

  async updateFileStatus({ userId, fileId, fromStatuses, toStatus, extraAttributes = {} }) {
    const now = new Date().toISOString();
    const attributeNames = { '#status': 'status', '#updatedAt': 'updatedAt' };
    const attributeValues = {
      ':toStatus': toStatus,
      ':updatedAt': now,
      ':fromStatuses': fromStatuses,
    };

    let updateExpression = 'SET #status = :toStatus, #updatedAt = :updatedAt';
    Object.entries(extraAttributes).forEach(([key, value], idx) => {
      const nameToken = `#extra${idx}`;
      const valueToken = `:extra${idx}`;
      attributeNames[nameToken] = key;
      attributeValues[valueToken] = value;
      updateExpression += `, ${nameToken} = ${valueToken}`;
    });

    try {
      const updated = await this.metadataService.updateItem({
        tableName: this.tableName,
        key: { PK: FilesRepository.pk(userId), SK: FilesRepository.sk(fileId) },
        updateExpression,
        conditionExpression: 'attribute_exists(PK) AND contains(:fromStatuses, #status)',
        expressionAttributeNames: attributeNames,
        expressionAttributeValues: attributeValues,
      });
      return updated;
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        throw new ConflictError(
          `Cannot transition file ${fileId} to ${toStatus}: current status is not one of [${fromStatuses.join(', ')}], or file does not exist`
        );
      }
      throw err;
    }
  }

  async deleteFile({ userId, fileId }) {
    await this.metadataService.deleteItem({
      tableName: this.tableName,
      key: { PK: FilesRepository.pk(userId), SK: FilesRepository.sk(fileId) },
    });
    return true;
  }

  async requireOwnedFile({ userId, fileId }) {
    const file = await this.getFile({ userId, fileId });
    if (!file) {
      throw new NotFoundError('File not found');
    }
    return file;
  }
}