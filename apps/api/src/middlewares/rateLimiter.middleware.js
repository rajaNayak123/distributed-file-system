import RateLimiterService from '../services/rateLimiter.service.js';
import config from '../config/index.js';

const defaultRateLimiterService = new RateLimiterService();

export function createRateLimiter({
  rateLimiterService = defaultRateLimiterService,
  windowMs = config.rateLimit.windowMs,
  max = config.rateLimit.maxRequests,
  keyGenerator = (req) => (req.user && req.user.userId ? `user:${req.user.userId}` : `ip:${req.ip}`),
} = {}) {
  return async (req, res, next) => {
    try {
      const key = keyGenerator(req);
      const result = await rateLimiterService.consume({ key, windowMs, max });

      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter);
        return res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded, please try again later.',
          retryAfter: result.retryAfter,
        });
      }

      next();
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'rate_limiter_middleware_error',
        error: err.message,
      }));
      next();
    }
  };
}

const rateLimiterMiddleware = createRateLimiter();
export default rateLimiterMiddleware;
