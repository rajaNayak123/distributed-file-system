// Worker test environment setup.
// Sets required env vars so config/index.js does not throw on import.

process.env.SQS_QUEUE_URL = process.env.SQS_QUEUE_URL || 'http://localhost:4566/000000000000/file-processing-queue';
process.env.SQS_DLQ_URL = process.env.SQS_DLQ_URL || 'http://localhost:4566/000000000000/file-processing-dlq';
process.env.SQS_ENDPOINT = process.env.SQS_ENDPOINT || 'http://localhost:4566';
process.env.DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:4566';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.S3_BUCKET = 'file-storage-dev';
process.env.DYNAMODB_FILES_TABLE = 'Files';
process.env.NODE_ENV = 'test';
