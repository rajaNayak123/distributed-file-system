import logger from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

export default function errorHandlerMiddleware(err, req, res, _next) {
  if (err instanceof AppError) {
    logger.warn('handled_error', {
      requestId: req.requestId,
      userId: req.user ? req.user.userId : undefined,
      operation: `${req.method} ${req.path}`,
      status: err.statusCode,
      errorCategory: err.errorCategory,
      error: err.message,
    });
    return res.status(err.statusCode).json({
      error: {
        message: err.message,
        category: err.errorCategory,
        details: err.details,
      },
    });
  }

  logger.error('unhandled_error', {
    requestId: req.requestId,
    userId: req.user ? req.user.userId : undefined,
    operation: `${req.method} ${req.path}`,
    status: 500,
    errorCategory: 'INTERNAL_ERROR',
    error: err.message,
    stack: err.stack,
  });

  return res.status(500).json({
    error: {
      message: 'Internal server error',
      category: 'INTERNAL_ERROR',
    },
  });
}
