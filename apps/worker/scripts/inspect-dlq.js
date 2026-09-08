#!/usr/bin/env node
/**
 * DLQ Inspector — apps/worker/scripts/inspect-dlq.js
 *
 * Usage:
 *   node scripts/inspect-dlq.js [--max-messages N]
 *
 * Reads up to N messages (default 10) from the dead-letter queue and prints
 * them as pretty JSON. Messages are NOT deleted — this is a read-only
 * inspection tool.
 *
 * To run against LocalStack:
 *   SQS_DLQ_URL=http://localhost:4566/000000000000/file-processing-dlq \
 *   SQS_ENDPOINT=http://localhost:4566 \
 *   node scripts/inspect-dlq.js
 *
 * To re-drive messages back to the main queue, use the AWS Console, CLI
 * (aws sqs start-message-move-task), or delete them from the DLQ after
 * investigating the root cause.
 */

import { SQSClient, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import dotenv from 'dotenv';

dotenv.config();

const dlqUrl = process.env.SQS_DLQ_URL;
if (!dlqUrl) {
  console.error('Error: SQS_DLQ_URL environment variable is not set.');
  process.exit(1);
}

const maxMessages = (() => {
  const idx = process.argv.indexOf('--max-messages');
  if (idx !== -1 && process.argv[idx + 1]) {
    return Math.min(10, parseInt(process.argv[idx + 1], 10) || 10);
  }
  return 10;
})();

const client = new SQSClient({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT || undefined,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
});

console.log(`\n🔍 Inspecting DLQ: ${dlqUrl}`);
console.log(`   Reading up to ${maxMessages} messages (NOT deleting them)\n`);

const result = await client.send(
  new ReceiveMessageCommand({
    QueueUrl: dlqUrl,
    MaxNumberOfMessages: maxMessages,
    WaitTimeSeconds: 5,
    AttributeNames: ['All'],
    MessageAttributeNames: ['All'],
    // Use a short visibility timeout so messages are quickly visible again
    // to other consumers (or the next inspect-dlq run).
    VisibilityTimeout: 30,
  })
);

const messages = result.Messages || [];

if (messages.length === 0) {
  console.log('✅ DLQ is empty — no messages to inspect.');
  process.exit(0);
}

console.log(`Found ${messages.length} message(s):\n`);

messages.forEach((msg, i) => {
  let body;
  try {
    body = JSON.parse(msg.Body);
  } catch {
    body = msg.Body;
  }

  console.log(`── Message ${i + 1} ──────────────────────────────────────────`);
  console.log(`  MessageId:     ${msg.MessageId}`);
  console.log(`  ReceiptHandle: ${msg.ReceiptHandle.slice(0, 60)}...`);
  console.log(`  ApproximateReceiveCount: ${msg.Attributes?.ApproximateReceiveCount}`);
  console.log(`  SentTimestamp: ${new Date(parseInt(msg.Attributes?.SentTimestamp || '0', 10)).toISOString()}`);
  console.log(`  Body:`);
  console.log(JSON.stringify(body, null, 4).split('\n').map((l) => `    ${l}`).join('\n'));
  console.log();
});

console.log('ℹ️  Messages are NOT deleted. To re-drive, use:');
console.log('   aws sqs start-message-move-task --source-arn <dlq-arn> --destination-arn <queue-arn>');
console.log('   Or delete individual messages via the AWS console / CLI.\n');
