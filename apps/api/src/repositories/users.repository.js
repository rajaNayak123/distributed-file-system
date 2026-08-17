import MetadataService from "../server/metadata.service.js"
import config from '../config/index.js';
import { ConflictError } from '../utils/errors.js';

/*
 Users table key schema:
    PK: USER#<userId> "Partition Key", The PK is used to identify which partition/group an item belongs to.
    SK: PROFILE "Sort Key", The SK gives another level of identification inside the same PK.
 */

export default class UsersRepository{
    constructor(metadataService = new MetadataService(), tableName = config.dynamo.usersTable){
        this.metadataService = metadataService
        this.tableName = tableName
    }

    static pk(userId) {
        return `USER#${userId}`;
    }

    async createUser({userId, email, passwordHash, createdAt}){
        item = {
            pk: UsersRepository.pk(userId),
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
        } catch (error) {
            if (err.name === 'ConditionalCheckFailedException') {
                throw new ConflictError('A user with this email already exists');
            }
            throw err;
        }
    }
}