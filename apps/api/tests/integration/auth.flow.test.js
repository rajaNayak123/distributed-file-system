import request from 'supertest';
import { buildApp, resetFakes } from '../helpers/testApp.js';

describe('Auth flow', () => {
  let app;

  beforeEach(() => {
    resetFakes();
    app = buildApp();
  });

  it('registers a new user and returns tokens', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'alice@example.com', password: 'super-secret-1' });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user.email).toBe('alice@example.com');
  });

  it('rejects registering the same email twice', async () => {
    await request(app).post('/auth/register').send({ email: 'bob@example.com', password: 'super-secret-1' });
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'bob@example.com', password: 'another-secret-1' });
    expect(res.status).toBe(400);
  });

  it('logs in with correct credentials', async () => {
    await request(app).post('/auth/register').send({ email: 'carol@example.com', password: 'super-secret-1' });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'carol@example.com', password: 'super-secret-1' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it('rejects login with wrong password', async () => {
    await request(app).post('/auth/register').send({ email: 'dave@example.com', password: 'super-secret-1' });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'dave@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('refreshes an access token given a valid refresh token', async () => {
    const registerRes = await request(app)
      .post('/auth/register')
      .send({ email: 'erin@example.com', password: 'super-secret-1' });
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: registerRes.body.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it('rejects protected routes without a bearer token', async () => {
    const res = await request(app).get('/files');
    expect(res.status).toBe(401);
  });

  it('rejects protected routes with a malformed token', async () => {
    const res = await request(app).get('/files').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});
