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
    s3Endpoint: process.env.S3_ENDPOINT || 'http://localhost:4566',
    dynamoEndpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:4566',
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
};

export default config;
