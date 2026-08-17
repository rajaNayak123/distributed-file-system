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
}