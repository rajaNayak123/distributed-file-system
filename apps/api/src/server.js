import createApp from './app.js';
import config from './config/index.js';
import logger from './utils/logger.js';

const app = createApp();

app.listen(config.port, () => {
  logger.info('server_started', { operation: 'startup', status: 'OK', port: config.port, env: config.env });
});
