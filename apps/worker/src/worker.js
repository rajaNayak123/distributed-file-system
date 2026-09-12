import cron from 'node-cron';
import { startConsumer } from './consumer.js';
import { runCleanup } from './processors/cleanup.processor.js';
import { runReconciliation } from './processors/reconciliation.processor.js';
import config from './config/index.js';

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

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', event: 'worker_shutdown', signal }));
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startConsumer().catch((err) => {
  console.error(JSON.stringify({
    level: 'fatal',
    event: 'consumer_fatal_error',
    error: err.message,
    stack: err.stack,
  }));
  process.exit(1);
});
