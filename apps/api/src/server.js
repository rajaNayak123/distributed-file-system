import createApp from './app.js';
import config from './config/index.js';
import logger from './utils/logger.js';

// NOTE: The abandoned-upload cleanup job that previously ran here was moved to
// apps/worker/src/processors/cleanup.processor.js in Phase 6. The API server
// no longer starts any background work; all non-critical-path processing runs
// in the worker app, which reads from the SQS file-processing-queue and
// runs its own node-cron schedule. See docs/architecture.md §Phase 6.

const app = createApp();

app.listen(config.port, () => {
  logger.info('server_started', { operation: 'startup', status: 'OK', port: config.port, env: config.env });
});
