import MetadataService from "../services/metadata.service.js"
import config from '../config/index.js';
import { ConflictError } from '../utils/errors.js';

export default class UsersRepository{
    constructor(metadataService = new MetadataService(), tableName = config.dynamo.usersTable){
        this.metadataService = metadataService
        this.tableName = tableName
    }

    static pk(userId) {
        return `USER#${userId}`;
    }

    async createUser({ userId, email, passwordHash, createdAt }) {
        const item = {
            PK: UsersRepository.pk(userId),
            SK: 'PROFILE',
            userId,
            email,
            passwordHash,
            createdAt
        }

        try {
            await this.metadataService.putItem({
                tableName: this.tableName,
                item,
                conditionExpression: 'attribute_not_exists(PK)',
            })
            return item;
        } catch (err) {
            if (err.name === 'ConditionalCheckFailedException') {
                throw new ConflictError('A user with this email already exists');
            }
            throw err;
        }
    }

    async getUserById(userId){
        return this.metadataService.getItem({
            tableName: this.tableName,
            key: { PK: UsersRepository.pk(userId), SK: 'PROFILE' },
        })
    }

    async getUserByEmail(email) {
        const items = await this.metadataService.query({
          tableName: this.tableName,
          indexName: 'EmailIndex',
          keyConditionExpression: 'email = :email',
          expressionAttributeValues: { ':email': email },
        });
        return items[0] || null;
    }
}