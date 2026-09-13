import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.DYNAMODB_ENDPOINT || 'http://dynamodb-local:8000',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
});

const filesTable = process.env.DYNAMODB_FILES_TABLE || 'Files';
const usersTable = process.env.DYNAMODB_USERS_TABLE || 'Users';

async function tableExists(tableName) {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function waitForDynamo(retries = 20, delayMs = 1500) {
  for (let i = 0; i < retries; i += 1) {
    try {
      await client.send(new DescribeTableCommand({ TableName: '__healthcheck__' }));
      return;
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') return;
      console.log(`Waiting for DynamoDB Local... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('DynamoDB Local did not become available in time');
}

async function createFilesTable() {
  if (await tableExists(filesTable)) {
    console.log(`Table ${filesTable} already exists, skipping.`);
    return;
  }
  await client.send(
    new CreateTableCommand({
      TableName: filesTable,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'contentHash', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'ContentHashIndex',
          KeySchema: [{ AttributeName: 'contentHash', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    })
  );
  console.log(`Created table ${filesTable}`);
}

async function createUsersTable() {
  if (await tableExists(usersTable)) {
    console.log(`Table ${usersTable} already exists, skipping.`);
    return;
  }
  await client.send(
    new CreateTableCommand({
      TableName: usersTable,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'email', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'EmailIndex',
          KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    })
  );
  console.log(`Created table ${usersTable}`);
}

async function createIdempotencyKeysTable() {
  const tableName = process.env.DYNAMODB_IDEMPOTENCY_TABLE || 'IdempotencyKeys';
  if (await tableExists(tableName)) {
    console.log(`Table ${tableName} already exists, skipping.`);
    return;
  }
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    })
  );
  console.log(`Created table ${tableName}`);
}

(async () => {
  await waitForDynamo();
  await createFilesTable();
  await createUsersTable();
  await createIdempotencyKeysTable();
  console.log('DynamoDB Local table setup complete.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed to initialize DynamoDB Local tables:', err);
  process.exit(1);
});
