/**
 * tests/failure/idempotency.concurrent.test.js
 *
 * Idempotency scenarios:
 *   1. Same Idempotency-Key sent twice → only ONE upload session created,
 *      second response replays the first (same fileId, status 201).
 *   2. Same key with different payload → 422.
 *   3. Key marked IN_PROGRESS → 409.
 */
import request from 'supertest';
import FakeIdempotencyRepository from '../fakes/fakeIdempotencyRepository.js';
import { buildApp, registerAndLogin, resetFakes } from '../helpers/testApp.js';

beforeEach(() => {
  resetFakes();
  FakeIdempotencyRepository.__reset();
});


describe('Idempotency key enforcement', () => {
  test('same key twice returns same fileId and does not create two uploads', async () => {
    const app = buildApp();
    const { accessToken } = await registerAndLogin(app, request);

    const payload = { fileName: 'report.pdf', contentType: 'application/pdf', size: 1024 };
    const key = 'idem-key-1';

    const res1 = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send(payload);

    if (res1.status !== 201) console.log('DEBUG 404:', res1.status, res1.body);
    expect(res1.status).toBe(201);
    const fileId1 = res1.body.fileId;
    expect(fileId1).toBeDefined();


    const res2 = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send(payload);

    // Second request must return 201 with the same fileId — not create a new one.
    expect(res2.status).toBe(201);
    expect(res2.body.fileId).toBe(fileId1);
  });

  test('same key with different payload returns 422', async () => {
    const app = buildApp();
    const { accessToken } = await registerAndLogin(app, request);
    const key = 'idem-key-2';

    await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send({ fileName: 'a.pdf', contentType: 'application/pdf', size: 100 });

    const res2 = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send({ fileName: 'DIFFERENT.pdf', contentType: 'application/pdf', size: 999 });

    expect(res2.status).toBe(422);
    expect(res2.body.error.category).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  test('in-progress key returns 409', async () => {
    const app = buildApp();
    const { accessToken, userId } = await registerAndLogin(app, request);
    const key = 'idem-key-3';

    // Manually plant an IN_PROGRESS record in the shared fake store.
    const { hashRequestBody } = require('../../src/utils/hash.js');
    const reqBody = { fileName: 'x.pdf', contentType: 'application/pdf', size: 1 };
    
    const repo = new FakeIdempotencyRepository();
    await repo.createInProgress({
      userId,
      idempotencyKey: key,
      requestHash: hashRequestBody(reqBody),
    });

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send(reqBody);


    expect(res.status).toBe(409);
    expect(res.body.error.category).toBe('IDEMPOTENCY_IN_PROGRESS');
  });
});
