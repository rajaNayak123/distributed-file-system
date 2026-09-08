#!/bin/sh
# Runs automatically inside the LocalStack container once it's ready
# (mounted at /etc/localstack/init/ready.d - see docker-compose.yml).
#
# Creates:
#   - S3 bucket:               file-storage-dev
#   - SQS DLQ:                 file-processing-dlq
#   - SQS main queue:          file-processing-queue
#     with RedrivePolicy pointing to DLQ (maxReceiveCount=5)
#
# Visibility timeout on the main queue is 300s (5 minutes).
# Rationale: checksum of a 5 GB file takes at most ~2-3 min on
# constrained hardware; 5 min gives 2x headroom. See docs/decisions.md.
set -e

# ── S3 ────────────────────────────────────────────────────────────────────────
awslocal s3 mb s3://file-storage-dev || true
awslocal s3api put-bucket-versioning \
  --bucket file-storage-dev \
  --versioning-configuration Status=Suspended || true
echo "LocalStack init: S3 bucket file-storage-dev ready"

# ── SQS DLQ ──────────────────────────────────────────────────────────────────
DLQ_URL=$(awslocal sqs create-queue \
  --queue-name file-processing-dlq \
  --attributes '{"MessageRetentionPeriod":"1209600"}' \
  --query QueueUrl --output text)
echo "LocalStack init: SQS DLQ ready at $DLQ_URL"

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

# ── SQS Main Queue ────────────────────────────────────────────────────────────
# VisibilityTimeout=300 (5 min) – see header comment.
# RedrivePolicy: after 5 failed receives the message moves to the DLQ.
REDRIVE=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$DLQ_ARN")

QUEUE_URL=$(awslocal sqs create-queue \
  --queue-name file-processing-queue \
  --attributes "{\"VisibilityTimeout\":\"300\",\"MessageRetentionPeriod\":\"86400\",\"RedrivePolicy\":\"$(echo "$REDRIVE" | sed 's/"/\\"/g')\"}" \
  --query QueueUrl --output text)
echo "LocalStack init: SQS main queue ready at $QUEUE_URL"

echo "LocalStack init: all resources provisioned"
