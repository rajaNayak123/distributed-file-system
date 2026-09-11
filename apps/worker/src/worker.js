import cron from 'node-cron';
import { startConsumer } from './consumer.js';
import { runCleanup } from './processors/cleanup.processor.js';
import { runReconciliation } from './processors/reconciliation.processor.js';
import config from './config/index.js';

/**
 * Worker entrypoint.
 *
 * Starts concurrent workloads:
 *   1. SQS consumer — long-polls for messages, dispatches to
 *      checksum + metadata + reconciliation processors.
 *   2. Cleanup cron — runs on a schedule (default: hourly) to abort abandoned
 *      multipart uploads and mark stuck COMPLETING records as FAILED.
 *   3. Reconciliation cron — runs on a schedule (default: every 15 mins) to
 *      detect and resolve S3/DynamoDB consistency gaps and orphaned S3 objects.
 *
 * Graceful shutdown:
 *   SIGTERM/SIGINT → stop accepting new work, let in-flight processing finish,
 *   then exit. SQS visibility timeout ensures any message being processed at
 *   shutdown time is re-delivered to another worker.
 */

// ── Cleanup cron ─────────────────────────────────────────────────────────────
console.log(JSON.stringify({
  level: 'info',
  event: 'worker_started',
  hostname: process.env.HOSTNAME || 'unknown',
  cleanupSchedule: config.cleanup.cronSchedule,
  reconciliationSchedule: config.reconciliation.cronSchedule,
}));

cron.schedule(config.cleanup.cronSchedule, async () => {
  console.log(JSON.stringify({ level: 'info', event: 'cleanup_job_start' }));
  try {
    const result = await runCleanup();
    console.log(JSON.stringify({
      level: 'info',
      event: 'cleanup_job_complete',
      ...result,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'cleanup_job_error',
      error: err.message,
    }));
  }
});

// ── Reconciliation cron ──────────────────────────────────────────────────────
cron.schedule(config.reconciliation.cronSchedule, async () => {
  console.log(JSON.stringify({ level: 'info', event: 'reconciliation_job_start' }));
  try {
    const result = await runReconciliation();
    console.log(JSON.stringify({
      level: 'info',
      event: 'reconciliation_job_complete',
      ...result,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'reconciliation_job_error',
      error: err.message,
    }));
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// The consumer loop runs in the same process. On SIGTERM (e.g. docker stop),
// we let the current pollOnce() call finish naturally (it long-polls for up to
// 20s, then returns). Any message being processed when we receive SIGTERM will
// not be deleted (the SQS DeleteMessage hasn't been called yet); SQS will
// re-deliver it after the visibility timeout to another worker.
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', event: 'worker_shutdown', signal }));
  // Give the current poll 2s to drain, then exit.
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Start the SQS consumer loop ───────────────────────────────────────────────
// startConsumer() never resolves (infinite loop); worker.js stays alive via it.
startConsumer().catch((err) => {
  console.error(JSON.stringify({
    level: 'fatal',
    event: 'consumer_fatal_error',
    error: err.message,
    stack: err.stack,
  }));
  process.exit(1);
});
