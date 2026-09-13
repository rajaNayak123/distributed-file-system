#!/bin/sh
set -e

awslocal s3 mb s3://file-storage-dev || true
awslocal s3api put-bucket-versioning \
  --bucket file-storage-dev \
  --versioning-configuration Status=Suspended || true
awslocal s3api put-bucket-cors \
  --bucket file-storage-dev \
  --cors-configuration '{"CORSRules":[{"AllowedHeaders":["*"],"AllowedMethods":["GET","PUT","POST","HEAD","DELETE"],"AllowedOrigins":["*"],"ExposeHeaders":["ETag","x-amz-request-id","x-amz-id-2"]}]}' || true
echo "LocalStack init: S3 bucket file-storage-dev ready with CORS"

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name file-processing-dlq \
  --attributes '{"MessageRetentionPeriod":"1209600"}' \
  --query QueueUrl --output text)
echo "LocalStack init: SQS DLQ ready at $DLQ_URL"

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

REDRIVE=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$DLQ_ARN")

QUEUE_URL=$(awslocal sqs create-queue \
  --queue-name file-processing-queue \
  --attributes "{\"VisibilityTimeout\":\"300\",\"MessageRetentionPeriod\":\"86400\",\"RedrivePolicy\":\"$(echo "$REDRIVE" | sed 's/"/\\"/g')\"}" \
  --query QueueUrl --output text)
echo "LocalStack init: SQS main queue ready at $QUEUE_URL"

echo "LocalStack init: all resources provisioned"
