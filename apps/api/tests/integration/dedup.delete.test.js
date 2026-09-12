import request from 'supertest';
import { buildApp, resetFakes, registerAndLogin, FakeStorageService } from '../helpers/testApp.js';
import FakeFilesRepository from '../fakes/fakeFilesRepository.js';

describe('Deduplication-aware file deletion integration', () => {
  let app;
  let user1;
  let user2;
  const sharedS3Key = 'users/user-1/files/file-canonical';
  const sharedHash = '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae';

  beforeEach(async () => {
    resetFakes();
    app = buildApp();
    user1 = await registerAndLogin(app, request, { email: 'user1@example.com' });
    user2 = await registerAndLogin(app, request, { email: 'user2@example.com' });

    FakeStorageService.__simulateClientPut(sharedS3Key, { size: 1024 });

    const filesRepo = new FakeFilesRepository();
    await filesRepo.createFile({
      userId: user1.userId,
      fileId: 'file-canonical',
      fileName: 'original.pdf',
      contentType: 'application/pdf',
      size: 1024,
      s3Key: sharedS3Key,
      status: 'COMPLETED',
      contentHash: sharedHash,
      checksum: sharedHash,
      isDedup: false,
      refCount: 2,
    });

    await filesRepo.createFile({
      userId: user2.userId,
      fileId: 'file-dedup-alias',
      fileName: 'copy.pdf',
      contentType: 'application/pdf',
      size: 1024,
      s3Key: sharedS3Key,
      status: 'COMPLETED',
      contentHash: sharedHash,
      checksum: sharedHash,
      isDedup: true,
      canonicalUserId: user1.userId,
      canonicalFileId: 'file-canonical',
      refCount: 1,
    });
  });

  it('preserves S3 object when deduplicated alias is deleted, and decrements canonical refCount', async () => {
    const res = await request(app)
      .delete('/files/file-dedup-alias')
      .set('Authorization', `Bearer ${user2.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    expect(FakeStorageService.__objectExists(sharedS3Key)).toBe(true);

    const filesRepo = new FakeFilesRepository();
    const canonical = await filesRepo.getFile({ userId: user1.userId, fileId: 'file-canonical' });
    expect(canonical).not.toBeNull();
    expect(canonical.refCount).toBe(1);

    const res2 = await request(app)
      .delete('/files/file-canonical')
      .set('Authorization', `Bearer ${user1.accessToken}`);

    expect(res2.status).toBe(200);
    expect(res2.body.deleted).toBe(true);

    expect(FakeStorageService.__objectExists(sharedS3Key)).toBe(false);
  });

  it('preserves S3 object when canonical file is deleted first while alias still exists', async () => {
    const res = await request(app)
      .delete('/files/file-canonical')
      .set('Authorization', `Bearer ${user1.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    expect(FakeStorageService.__objectExists(sharedS3Key)).toBe(true);

    const getRes = await request(app)
      .get('/files/file-dedup-alias/download')
      .set('Authorization', `Bearer ${user2.accessToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.downloadUrl).toBeDefined();

    const res2 = await request(app)
      .delete('/files/file-dedup-alias')
      .set('Authorization', `Bearer ${user2.accessToken}`);
    expect(res2.status).toBe(200);
    expect(res2.body.deleted).toBe(true);

    expect(FakeStorageService.__objectExists(sharedS3Key)).toBe(false);
  });
});
