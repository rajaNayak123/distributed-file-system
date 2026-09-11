import Redis from 'ioredis';
import config from '../config/index.js';

/**
 * In-memory shared store for testing and fallback.
 * Allows simulating multiple API instances connected to the same shared store.
 */
export class SharedMemoryStore {
  constructor() {
    this.counters = new Map();
    this.expiries = new Map();
  }

  async incr({ key, ttlSeconds }) {
    const now = Date.now();
    const expiry = this.expiries.get(key);
    if (expiry && now > expiry) {
      this.counters.delete(key);
      this.expiries.delete(key);
    }

    const current = (this.counters.get(key) || 0) + 1;
    this.counters.set(key, current);
    if (!this.expiries.has(key)) {
      this.expiries.set(key, now + ttlSeconds * 1000);
    }
    return current;
  }

  reset() {
    this.counters.clear();
    this.expiries.clear();
  }
}

/**
 * Shared memory store singleton for in-process sharing across instances.
 */
export const defaultSharedMemoryStore = new SharedMemoryStore();

/**
 * Redis-backed store for production horizontal scaling across stateless API containers.
 */
export class RedisStore {
  constructor(redisClient) {
    this.client = redisClient;
  }

  async incr({ key, ttlSeconds }) {
    const results = await this.client
      .pipeline()
      .incr(key)
      .expire(key, ttlSeconds)
      .exec();

    // results[0] = [err, count]
    const [err, count] = results[0];
    if (err) throw err;
    return count;
  }
}

/**
 * RateLimiterService
 *
 * Implements atomic fixed-window rate limiting.
 * Scoped by identifier (e.g. userId or IP).
 */
export default class RateLimiterService {
  constructor({
    store = null,
    redisUrl = config.rateLimit.redisUrl,
    keyPrefix = 'rl',
  } = {}) {
    this.keyPrefix = keyPrefix;

    if (store) {
      this.store = store;
    } else if (redisUrl) {
      try {
        const client = new Redis(redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
        this.store = new RedisStore(client);
      } catch (e) {
        this.store = defaultSharedMemoryStore;
      }
    } else {
      this.store = defaultSharedMemoryStore;
    }
  }

  /**
   * Consumes 1 request token for the given key in the current window.
   *
   * @param {object} options
   * @param {string} options.key - identifier (e.g. userId or IP)
   * @param {number} [options.windowMs] - window duration in ms (default: 60s)
   * @param {number} [options.max] - max allowed requests in window (default: 30)
   * @returns {Promise<{ allowed: boolean, limit: number, remaining: number, resetTime: number, retryAfter: number, count: number }>}
   */
  async consume({
    key,
    windowMs = config.rateLimit.windowMs,
    max = config.rateLimit.maxRequests,
  }) {
    const now = Date.now();
    const windowIndex = Math.floor(now / windowMs);
    const resetTime = (windowIndex + 1) * windowMs;
    const ttlSeconds = Math.max(1, Math.ceil((resetTime - now) / 1000) + 2);

    const storeKey = `${this.keyPrefix}:${key}:${windowIndex}`;
    const count = await this.store.incr({ key: storeKey, ttlSeconds });

    const allowed = count <= max;
    const remaining = Math.max(0, max - count);
    const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((resetTime - now) / 1000));

    return {
      allowed,
      limit: max,
      remaining,
      resetTime,
      retryAfter,
      count,
    };
  }
}
