import Redis from 'ioredis';
import config from '../config/index.js';

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

export const defaultSharedMemoryStore = new SharedMemoryStore();

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

    const [err, count] = results[0];
    if (err) throw err;
    return count;
  }
}

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
