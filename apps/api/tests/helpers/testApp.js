import createApp from '../../src/app.js';
import FakeFilesRepository from '../fakes/fakeFilesRepository.js';
import FakeUsersRepository from '../fakes/fakeUsersRepository.js';
import FakeStorageService from '../fakes/fakeStorageService.js';

export function buildApp() {
  return createApp();
}

export function resetFakes() {
  FakeFilesRepository.__reset();
  FakeUsersRepository.__reset();
  FakeStorageService.__reset();
}

export async function registerAndLogin(app, request, { email, password = 'correct-horse-battery' } = {}) {
  const uniqueEmail = email || `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await request(app).post('/auth/register').send({ email: uniqueEmail, password });
  return { accessToken: res.body.accessToken, userId: res.body.user.userId, email: uniqueEmail };
}

export { FakeStorageService };
