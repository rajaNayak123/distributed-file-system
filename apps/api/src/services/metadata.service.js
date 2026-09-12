import { PutCommand, GetCommand, UpdateCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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

  async getItem({tableName, key}){
    try {
      const result = await this.docClient.send(
        new GetCommand({ TableName: tableName, Key: key })
      )
      return result.Item || null
    } catch (error) {
      throw new UpstreamServiceError('Failed to read item from DynamoDB', { cause: error.message });
    }
  }

  async updateItem({
    tableName,
    key,
    updateExpression,
    conditionExpression,
    expressionAttributeNames,
    expressionAttributeValues,
    returnValues = 'ALL_NEW'
  }) {
      try {
        const result = await this.docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: key,
            UpdateExpression: updateExpression,
            ConditionExpression: conditionExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: returnValues,
          })
        )
        return result.Attributes
      } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') {
          throw error;
        }
        throw new UpstreamServiceError('Failed to update item in DynamoDB', { cause: error.message });
      }
  }

  async deleteItem({ tableName, key, conditionExpression, expressionAttributeNames }) {
    try {
      await this.docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: key,
          ConditionExpression: conditionExpression,
          ExpressionAttributeNames: expressionAttributeNames,
        })
      );
      return true;
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw new UpstreamServiceError('Failed to delete item in DynamoDB', { cause: error.message });
    }
  }

  async query({
    tableName,
    keyConditionExpression,
    expressionAttributeNames,
    expressionAttributeValues,
    indexName,
    limit,
  }) {
    try {
      const result = await this.docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: indexName,
          KeyConditionExpression: keyConditionExpression,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          Limit: limit,
        })
      );
      return result.Items || [];
    } catch (err) {
      throw new UpstreamServiceError('Failed to query DynamoDB', { cause: err.message });
    }
  }
}