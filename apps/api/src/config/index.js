import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name, fallback) {
  const value = process.env[name] !== undefined ? process.env[name] : fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  jwt: {
    accessSecret: requireEnv('JWT_ACCESS_SECRET', 'dev-access-secret-change-me'),
    refreshSecret: requireEnv('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    s3Endpoint: process.env.S3_ENDPOINT ? process.env.S3_ENDPOINT : undefined,
    dynamoEndpoint: process.env.DYNAMODB_ENDPOINT ? process.env.DYNAMODB_ENDPOINT : undefined,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  },

  s3: {
    bucket: process.env.S3_BUCKET || 'file-storage-dev',
  },

  dynamo: {
    filesTable: process.env.DYNAMODB_FILES_TABLE || 'Files',
    usersTable: process.env.DYNAMODB_USERS_TABLE || 'Users',
  },

  uploads: {
    presignedPutExpirySeconds: parseInt(process.env.PRESIGNED_PUT_EXPIRY_SECONDS || '900', 10), // 15 min
    presignedGetExpirySeconds: parseInt(process.env.PRESIGNED_GET_EXPIRY_SECONDS || '300', 10), // 5 min
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || `${5 * 1024 * 1024 * 1024}`, 10),
    allowedContentTypes: (process.env.ALLOWED_CONTENT_TYPES || '').trim(), // empty = allow all, comma-separated allowlist otherwise
  },

  timeouts: {
    sdkConnectMs: parseInt(process.env.SDK_CONNECT_TIMEOUT_MS || '3000', 10),
    sdkSocketMs: parseInt(process.env.SDK_SOCKET_TIMEOUT_MS || '10000', 10),
    requestMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10), 
  },

  retries: {
    maxAttempts: parseInt(process.env.SDK_MAX_ATTEMPTS || '3', 10),
  },

  idempotency: {
    ttlSeconds: parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || String(24 * 60 * 60), 10), 
    tableName: process.env.DYNAMODB_IDEMPOTENCY_TABLE || 'IdempotencyKeys',
  },
};

export default config;
