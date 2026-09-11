import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import MetadataService from '../../src/services/metadata.service.js';
import { UpstreamServiceError } from '../../src/utils/errors.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('MetadataService', () => {
  let metadataService;

  beforeEach(() => {
    ddbMock.reset();
    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
    metadataService = new MetadataService(docClient);
  });

  it('putItem writes and returns the item', async () => {
    ddbMock.on(PutCommand).resolves({});
    const item = { PK: 'USER#1', SK: 'FILE#1', fileId: '1' };
    const result = await metadataService.putItem({ tableName: 'Files', item });
    expect(result).toEqual(item);
  });

  it('putItem rethrows ConditionalCheckFailedException untouched for callers to translate', async () => {
    ddbMock.on(PutCommand).rejects(Object.assign(new Error('cond fail'), { name: 'ConditionalCheckFailedException' }));
    await expect(
      metadataService.putItem({ tableName: 'Files', item: { PK: 'a', SK: 'b' } })
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('putItem wraps other DynamoDB errors as UpstreamServiceError', async () => {
    ddbMock.on(PutCommand).rejects(new Error('throttled'));
    await expect(
      metadataService.putItem({ tableName: 'Files', item: { PK: 'a', SK: 'b' } })
    ).rejects.toBeInstanceOf(UpstreamServiceError);
  });

  it('getItem returns null when item does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});
    const result = await metadataService.getItem({ tableName: 'Files', key: { PK: 'a', SK: 'b' } });
    expect(result).toBeNull();
  });

  it('getItem returns the item when present', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'a', SK: 'b', fileId: '1' } });
    const result = await metadataService.getItem({ tableName: 'Files', key: { PK: 'a', SK: 'b' } });
    expect(result).toEqual({ PK: 'a', SK: 'b', fileId: '1' });
  });

  it('updateItem returns updated attributes', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { status: 'COMPLETED' } });
    const result = await metadataService.updateItem({
      tableName: 'Files',
      key: { PK: 'a', SK: 'b' },
      updateExpression: 'SET #s = :s',
      expressionAttributeNames: { '#s': 'status' },
      expressionAttributeValues: { ':s': 'COMPLETED' },
    });
    expect(result).toEqual({ status: 'COMPLETED' });
  });

  it('deleteItem returns false (not an error) when the condition fails, supporting idempotent deletes', async () => {
    ddbMock.on(DeleteCommand).rejects(Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' }));
    const result = await metadataService.deleteItem({ tableName: 'Files', key: { PK: 'a', SK: 'b' } });
    expect(result).toBe(false);
  });

  it('query returns an empty array when there are no items', async () => {
    ddbMock.on(QueryCommand).resolves({});
    const result = await metadataService.query({
      tableName: 'Files',
      keyConditionExpression: 'PK = :pk',
      expressionAttributeValues: { ':pk': 'USER#1' },
    });
    expect(result).toEqual([]);
  });
});
