import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import MetadataService from '../../src/services/metadata.service.js';
import UsersRepository from '../../src/repositories/users.repository.js';
import { ConflictError } from '../../src/utils/errors.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('UsersRepository (real class, mocked DynamoDB client)', () => {
  let usersRepository;

  beforeEach(() => {
    ddbMock.reset();
    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
    usersRepository = new UsersRepository(new MetadataService(docClient), 'Users-test');
  });

  it('createUser writes an item keyed by PK=USER#<userId>, SK=PROFILE', async () => {
    ddbMock.on(PutCommand).callsFake((input) => {
      expect(input.TableName).toBe('Users-test');
      expect(input.Item.PK).toBe('USER#u1');
      expect(input.Item.SK).toBe('PROFILE');
      expect(input.Item.email).toBe('a@example.com');
      expect(input.ConditionExpression).toBe('attribute_not_exists(PK)');
      return {};
    });

    await usersRepository.createUser({
      userId: 'u1',
      email: 'a@example.com',
      passwordHash: 'hash',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('createUser translates a ConditionalCheckFailedException into ConflictError', async () => {
    ddbMock.on(PutCommand).rejects(
      Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' })
    );
    await expect(
      usersRepository.createUser({ userId: 'u1', email: 'a@example.com', passwordHash: 'hash', createdAt: 'now' })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('getUserById returns null when absent', async () => {
    ddbMock.on(GetCommand).resolves({});
    const result = await usersRepository.getUserById('missing');
    expect(result).toBeNull();
  });

  it('getUserByEmail queries the EmailIndex GSI and returns the first match', async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      expect(input.IndexName).toBe('EmailIndex');
      expect(input.KeyConditionExpression).toBe('email = :email');
      expect(input.ExpressionAttributeValues[':email']).toBe('a@example.com');
      return { Items: [{ userId: 'u1', email: 'a@example.com' }] };
    });
    const result = await usersRepository.getUserByEmail('a@example.com');
    expect(result).toEqual({ userId: 'u1', email: 'a@example.com' });
  });

  it('getUserByEmail returns null when no user matches', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = await usersRepository.getUserByEmail('nobody@example.com');
    expect(result).toBeNull();
  });
});
