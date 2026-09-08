import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import MetadataService from '../../src/services/metadata.service.js';
import FilesRepository from '../../src/repositories/files.repository.js';
import { ConflictError, NotFoundError } from '../../src/utils/errors.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('FilesRepository (real class, mocked DynamoDB client)', () => {
  let filesRepository;

  beforeEach(() => {
    ddbMock.reset();
    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
    filesRepository = new FilesRepository(new MetadataService(docClient), 'Files-test');
  });

  it('createFile writes an item keyed by PK=USER#<userId>, SK=FILE#<fileId>', async () => {
    ddbMock.on(PutCommand).callsFake((input) => {
      expect(input.TableName).toBe('Files-test');
      expect(input.Item.PK).toBe('USER#u1');
      expect(input.Item.SK).toBe('FILE#f1');
      expect(input.ConditionExpression).toBe('attribute_not_exists(PK)');
      return {};
    });

    const result = await filesRepository.createFile({
      fileId: 'f1',
      userId: 'u1',
      fileName: 'a.txt',
      size: 10,
      contentType: 'text/plain',
      s3Key: 'users/u1/files/f1',
      status: 'INITIATED',
    });

    expect(result.PK).toBe('USER#u1');
    expect(result.SK).toBe('FILE#f1');
  });

  it('createFile translates a ConditionalCheckFailedException into ConflictError', async () => {
    ddbMock.on(PutCommand).rejects(
      Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' })
    );
    await expect(
      filesRepository.createFile({ fileId: 'f1', userId: 'u1', status: 'INITIATED' })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('getFile returns null when the item is absent', async () => {
    ddbMock.on(GetCommand).resolves({});
    const result = await filesRepository.getFile({ userId: 'u1', fileId: 'missing' });
    expect(result).toBeNull();
  });

  it('listFilesForUser queries by PK and begins_with(SK, FILE#), and filters to COMPLETED by default', async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      expect(input.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :skPrefix)');
      expect(input.ExpressionAttributeValues[':pk']).toBe('USER#u1');
      expect(input.ExpressionAttributeValues[':skPrefix']).toBe('FILE#');
      return {
        Items: [
          { fileId: 'f1', status: 'COMPLETED' },
          { fileId: 'f2', status: 'UPLOADING' },
        ],
      };
    });

    const completedOnly = await filesRepository.listFilesForUser({ userId: 'u1' });
    expect(completedOnly).toEqual([{ fileId: 'f1', status: 'COMPLETED' }]);

    const all = await filesRepository.listFilesForUser({ userId: 'u1', includeIncomplete: true });
    expect(all).toHaveLength(2);
  });

  it('updateFileStatus only transitions when current status is in fromStatuses (conditional update)', async () => {
    ddbMock.on(UpdateCommand).callsFake((input) => {
      // The repository builds: attribute_exists(PK) AND #status IN (:fromStatus0)
      // — one token per fromStatus entry, not a DynamoDB contains() call.
      expect(input.ConditionExpression).toContain('attribute_exists(PK)');
      expect(input.ConditionExpression).toContain('#status IN (:fromStatus0)');
      expect(input.ExpressionAttributeValues[':fromStatus0']).toBe('UPLOADING');
      expect(input.ExpressionAttributeValues[':toStatus']).toBe('COMPLETING');
      return { Attributes: { status: 'COMPLETING' } };
    });

    const result = await filesRepository.updateFileStatus({
      userId: 'u1',
      fileId: 'f1',
      fromStatuses: ['UPLOADING'],
      toStatus: 'COMPLETING',
    });
    expect(result.status).toBe('COMPLETING');
  });

  it('updateFileStatus translates a failed condition (wrong current status) into ConflictError', async () => {
    ddbMock.on(UpdateCommand).rejects(
      Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' })
    );
    await expect(
      filesRepository.updateFileStatus({
        userId: 'u1',
        fileId: 'f1',
        fromStatuses: ['UPLOADING'],
        toStatus: 'COMPLETED', // illegal jump, should never even reach here in practice - the state
        // machine guard runs first, but the repository itself is defense-in-depth
        // against races between two concurrent requests.
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('updateFileStatus merges extraAttributes into the update expression', async () => {
    ddbMock.on(UpdateCommand).callsFake((input) => {
      expect(input.UpdateExpression).toContain('#extra0 = :extra0');
      expect(input.ExpressionAttributeNames['#extra0']).toBe('etag');
      expect(input.ExpressionAttributeValues[':extra0']).toBe('"abc"');
      return { Attributes: { status: 'COMPLETED', etag: '"abc"' } };
    });

    await filesRepository.updateFileStatus({
      userId: 'u1',
      fileId: 'f1',
      fromStatuses: ['COMPLETING'],
      toStatus: 'COMPLETED',
      extraAttributes: { etag: '"abc"' },
    });
  });

  it('requireOwnedFile throws NotFoundError when getFile returns null', async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(filesRepository.requireOwnedFile({ userId: 'u1', fileId: 'missing' })).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it('requireOwnedFile returns the item when it exists under the given userId', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'USER#u1', SK: 'FILE#f1', fileId: 'f1' } });
    const result = await filesRepository.requireOwnedFile({ userId: 'u1', fileId: 'f1' });
    expect(result.fileId).toBe('f1');
  });

  it("a lookup under a different (attacker) userId never returns the victim's item, even with the correct fileId", async () => {
    // Simulate the real DynamoDB behavior: GetItem with PK=USER#attacker,
    // SK=FILE#f1 simply finds nothing, because the victim's item lives under
    // PK=USER#victim. We assert the key WE construct is scoped to the caller.
    ddbMock.on(GetCommand).callsFake((input) => {
      expect(input.Key.PK).toBe('USER#attacker');
      return {}; // DynamoDB correctly finds nothing under this PK
    });
    await expect(
      filesRepository.requireOwnedFile({ userId: 'attacker', fileId: 'f1' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
