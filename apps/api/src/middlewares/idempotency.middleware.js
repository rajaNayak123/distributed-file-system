import IdempotencyRepository from '../repositories/idempotency.repository.js';
import { hashRequestBody } from '../utils/hash.js';
import {
  IdempotencyConflictError,
  IdempotencyPayloadMismatchError,
} from '../utils/errors.js';
import logger from '../utils/logger.js';

const idempotencyRepo = new IdempotencyRepository();

export default function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey) return next();

  if (idempotencyKey.length > 128) {
    return res.status(400).json({
      error: { message: 'Idempotency-Key must be at most 128 characters', category: 'VALIDATION_ERROR' },
    });
  }

  const userId = req.user.userId; 
  const requestHash = hashRequestBody(req.body);

  (async () => {
    const created = await idempotencyRepo.createInProgress({ userId, idempotencyKey, requestHash });

    if (created) {
      const originalJson = res.json.bind(res);

      res.json = function idempotentJson(body) {
        const statusCode = res.statusCode || 200;
        
        res.json = originalJson;

        if (statusCode >= 200 && statusCode < 400) {
          idempotencyRepo.markCompleted({ userId, idempotencyKey, statusCode, result: body }).catch((err) => {
            logger.warn('idempotency_mark_completed_failed', { userId, idempotencyKey, error: err.message });
          });
        } else {
          idempotencyRepo.delete({ userId, idempotencyKey }).catch((cleanupErr) => {
            logger.warn('idempotency_cleanup_failed', { userId, idempotencyKey, error: cleanupErr.message });
          });
        }
        
        return originalJson(body);
      };

      return next();
    }

    const existing = await idempotencyRepo.get({ userId, idempotencyKey });

    if (!existing) return next(); 

    if (existing.requestHash !== requestHash) {
      return next(new IdempotencyPayloadMismatchError(
        `Idempotency-Key "${idempotencyKey}" was previously used with a different request body`
      ));
    }

    if (existing.status === 'IN_PROGRESS') {
      return next(new IdempotencyConflictError());
    }

    if (existing.status === 'COMPLETED') {
      logger.info('idempotency_replay', { userId, idempotencyKey });
      const body = existing.result ? JSON.parse(existing.result) : {};
      return res.status(existing.statusCode || 200).json(body);
    }

    return next(); 
  })().catch(next);
}
