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

  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    s3Endpoint: process.env.S3_ENDPOINT || undefined,
    dynamoEndpoint: process.env.DYNAMODB_ENDPOINT || undefined,
    sqsEndpoint: process.env.SQS_ENDPOINT || undefined,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  },

  s3: {
    bucket: process.env.S3_BUCKET || 'file-storage-dev',
  },

  dynamo: {
    filesTable: process.env.DYNAMODB_FILES_TABLE || 'Files',
  },

  sqs: {
    queueUrl: requireEnv('SQS_QUEUE_URL', ''),
    dlqUrl: process.env.SQS_DLQ_URL || '',
    // Long-poll wait time in seconds (max 20). Reduces empty-receive API calls.
    waitTimeSeconds: parseInt(process.env.SQS_WAIT_TIME_SECONDS || '20', 10),
    // Max messages per ReceiveMessage call (1–10).
    maxMessages: parseInt(process.env.SQS_MAX_MESSAGES || '10', 10),
    // Visibility timeout seconds — must match the queue's configured value (300s).
    visibilityTimeout: parseInt(process.env.SQS_VISIBILITY_TIMEOUT || '300', 10),
  },

  timeouts: {
    sdkConnectMs: parseInt(process.env.SDK_CONNECT_TIMEOUT_MS || '3000', 10),
    sdkSocketMs: parseInt(process.env.SDK_SOCKET_TIMEOUT_MS || '30000', 10),
  },

  retries: {
    maxAttempts: parseInt(process.env.SDK_MAX_ATTEMPTS || '3', 10),
  },

  cleanup: {
    // Cron expression for the abandoned-upload cleanup job (default: every hour).
    cronSchedule: process.env.CLEANUP_CRON_SCHEDULE || '0 * * * *',
    // Uploads UPLOADING for longer than this are considered abandoned.
    retentionHours: parseInt(process.env.CLEANUP_RETENTION_HOURS || '24', 10),
    // Uploads stuck in COMPLETING for longer than this are marked FAILED.
    stuckCompletingHours: parseInt(process.env.CLEANUP_STUCK_COMPLETING_HOURS || '1', 10),
  },
};

export default config;
