import config from '../config/index.js';
import logger from '../utils/logger.js';

export default function requestTimeoutMiddleware(req, res, next) {
  const timeoutMs = config.timeouts.requestMs;

  res.setTimeout(timeoutMs, () => {
    if (!res.headersSent) {
      logger.warn('request_timeout', {
        requestId: req.requestId,
        userId: req.user ? req.user.userId : undefined,
        operation: `${req.method} ${req.path}`,
        timeoutMs,
      });
      res.status(503).json({
        error: {
          message: 'Request timed out',
          category: 'REQUEST_TIMEOUT',
        },
      });
    }
  });

  next();
}
