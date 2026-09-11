import RateLimiterService, { SharedMemoryStore } from '../../src/services/rateLimiter.service.js';

describe('RateLimiterService — unit', () => {
  let store;
  let limiter;

  beforeEach(() => {
    store = new SharedMemoryStore();
    limiter = new RateLimiterService({ store, keyPrefix: 'test-rl' });
  });

  it('allows requests within limit and decrements remaining', async () => {
    const key = 'user-1';
    const max = 3;
    const windowMs = 60000;

    const res1 = await limiter.consume({ key, windowMs, max });
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(2);
    expect(res1.limit).toBe(3);

    const res2 = await limiter.consume({ key, windowMs, max });
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(1);

    const res3 = await limiter.consume({ key, windowMs, max });
    expect(res3.allowed).toBe(true);
    expect(res3.remaining).toBe(0);

    // 4th request exceeds limit
    const res4 = await limiter.consume({ key, windowMs, max });
    expect(res4.allowed).toBe(false);
    expect(res4.remaining).toBe(0);
    expect(res4.retryAfter).toBeGreaterThan(0);
  });

  it('isolates quotas across distinct keys (users)', async () => {
    const max = 2;
    const windowMs = 60000;

    await limiter.consume({ key: 'user-a', windowMs, max });
    await limiter.consume({ key: 'user-a', windowMs, max });

    const resA = await limiter.consume({ key: 'user-a', windowMs, max });
    expect(resA.allowed).toBe(false);

    // User B should still have full quota
    const resB = await limiter.consume({ key: 'user-b', windowMs, max });
    expect(resB.allowed).toBe(true);
    expect(resB.remaining).toBe(1);
  });

  it('shares counter across multiple service instances using the same shared store', async () => {
    const sharedStore = new SharedMemoryStore();
    const instanceA = new RateLimiterService({ store: sharedStore, keyPrefix: 'shared-rl' });
    const instanceB = new RateLimiterService({ store: sharedStore, keyPrefix: 'shared-rl' });

    const key = 'shared-user';
    const max = 3;
    const windowMs = 60000;

    // Request 1 on Instance A
    const res1 = await instanceA.consume({ key, windowMs, max });
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(2);

    // Request 2 on Instance B
    const res2 = await instanceB.consume({ key, windowMs, max });
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(1);

    // Request 3 on Instance A
    const res3 = await instanceA.consume({ key, windowMs, max });
    expect(res3.allowed).toBe(true);
    expect(res3.remaining).toBe(0);

    // Request 4 on Instance B -> exceeded!
    const res4 = await instanceB.consume({ key, windowMs, max });
    expect(res4.allowed).toBe(false);
    expect(res4.remaining).toBe(0);
  });
});
