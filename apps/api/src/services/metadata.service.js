import {PutCommand} from "@aws-sdk/lib-dynamodb"
import defaultDocClient from '../clients/dynamoClient.js';
import { UpstreamServiceError } from '../utils/errors.js';

export default class MetadataService{
  constructor(docClient = defaultDocClient){
    this.docClient = docClient
  }

  async putItem({ tableName, item, conditionExpression, expressionAttributeNames }){
    try {
      await this.docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: conditionExpression,
          ExpressionAttributeNames: expressionAttributeNames,
        })
      )
      return item
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        throw error;
      }
      throw new UpstreamServiceError('Failed to write item to DynamoDB', { cause: error.message });
    }
  }
  
}