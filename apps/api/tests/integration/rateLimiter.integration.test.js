import request from 'supertest';
import express from 'express';
import { buildApp, resetFakes, registerAndLogin } from '../helpers/testApp.js';
import RateLimiterService, {
  SharedMemoryStore,
  defaultSharedMemoryStore,
} from '../../src/services/rateLimiter.service.js';
import { createRateLimiter } from '../../src/middlewares/rateLimiter.middleware.js';

describe('Rate limiting integration & cross-instance enforcement', () => {
  let app;
  let user;

  beforeEach(async () => {
    resetFakes();
    defaultSharedMemoryStore.reset();
    app = buildApp();
    user = await registerAndLogin(app, request, { email: 'rate-limit-user@example.com' });
  });

  it('returns rate limit headers (Limit, Remaining, Reset) on upload endpoints', async () => {
    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ fileName: 'doc.txt', contentType: 'text/plain', size: 100 });

    expect(res.status).toBe(201);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('enforces rate limit across multiple requests and returns 429 with Retry-After', async () => {
    const testStore = new SharedMemoryStore();
    const testLimiter = new RateLimiterService({ store: testStore, keyPrefix: 'test-tight' });
    const tightMiddleware = createRateLimiter({
      rateLimiterService: testLimiter,
      windowMs: 60000,
      max: 2,
    });

    const tightApp = express();
    tightApp.use(express.json());
    tightApp.post('/test-route', tightMiddleware, (req, res) => res.json({ ok: true }));

    const res1 = await request(tightApp).post('/test-route').send();
    expect(res1.status).toBe(200);
    expect(res1.headers['x-ratelimit-remaining']).toBe('1');

    const res2 = await request(tightApp).post('/test-route').send();
    expect(res2.status).toBe(200);
    expect(res2.headers['x-ratelimit-remaining']).toBe('0');

    const res3 = await request(tightApp).post('/test-route').send();
    expect(res3.status).toBe(429);
    expect(res3.headers['retry-after']).toBeDefined();
    expect(parseInt(res3.headers['retry-after'], 10)).toBeGreaterThan(0);
    expect(res3.body).toEqual(
      expect.objectContaining({
        error: 'Too Many Requests',
      })
    );
  });

  it('enforces rate limits consistently across multiple stateless API instances sharing the same store', async () => {
    const sharedClusterStore = new SharedMemoryStore();
    const limitMax = 3;
    const windowMs = 60000;

    const limiterForInstance1 = new RateLimiterService({
      store: sharedClusterStore,
      keyPrefix: 'cluster-limit',
    });
    const limiterForInstance2 = new RateLimiterService({
      store: sharedClusterStore,
      keyPrefix: 'cluster-limit',
    });

    const sharedKeyGen = (req) => req.headers['x-user-id'] || 'anon';

    const api1App = express();
    api1App.use(
      createRateLimiter({
        rateLimiterService: limiterForInstance1,
        windowMs,
        max: limitMax,
        keyGenerator: sharedKeyGen,
      })
    );
    api1App.post('/action', (req, res) => res.json({ instance: 'api-1', ok: true }));

    const api2App = express();
    api2App.use(
      createRateLimiter({
        rateLimiterService: limiterForInstance2,
        windowMs,
        max: limitMax,
        keyGenerator: sharedKeyGen,
      })
    );
    api2App.post('/action', (req, res) => res.json({ instance: 'api-2', ok: true }));

    const userHeader = { 'x-user-id': 'client-42' };

    const r1 = await request(api1App).post('/action').set(userHeader);
    expect(r1.status).toBe(200);
    expect(r1.headers['x-ratelimit-remaining']).toBe('2');

    const r2 = await request(api2App).post('/action').set(userHeader);
    expect(r2.status).toBe(200);
    expect(r2.headers['x-ratelimit-remaining']).toBe('1');

    const r3 = await request(api1App).post('/action').set(userHeader);
    expect(r3.status).toBe(200);
    expect(r3.headers['x-ratelimit-remaining']).toBe('0');

    const r4 = await request(api2App).post('/action').set(userHeader);
    expect(r4.status).toBe(429);
    expect(r4.headers['retry-after']).toBeDefined();
    expect(r4.body.error).toBe('Too Many Requests');

    const r5 = await request(api1App).post('/action').set(userHeader);
    expect(r5.status).toBe(429);
  });
});
