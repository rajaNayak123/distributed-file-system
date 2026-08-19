import logger from '../utils/logger.js';

export default function requestLoggerMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const latencyMs = Number(end - start) / 1e6;
    logger.info('http_request', {
      requestId: req.requestId,
      userId: req.user ? req.user.userId : undefined,
      operation: `${req.method} ${req.route ? req.baseUrl + req.route.path : req.path}`,
      status: res.statusCode,
      latencyMs: Math.round(latencyMs * 100) / 100,
    });
  });
  next();
}
