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

    // Seed S3 object in fake storage
    FakeStorageService.__simulateClientPut(sharedS3Key, { size: 1024 });

    // Seed canonical file for user 1
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

    // Seed deduplicated alias file for user 2 pointing to user 1's canonical S3 object
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
    // Delete user 2's file (alias)
    const res = await request(app)
      .delete('/files/file-dedup-alias')
      .set('Authorization', `Bearer ${user2.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    // S3 object must STILL exist!
    expect(FakeStorageService.__objectExists(sharedS3Key)).toBe(true);

    // Canonical file must still exist in DB with decremented refCount
    const filesRepo = new FakeFilesRepository();
    const canonical = await filesRepo.getFile({ userId: user1.userId, fileId: 'file-canonical' });
    expect(canonical).not.toBeNull();
    expect(canonical.refCount).toBe(1);

    // Now delete canonical file (last reference)
    const res2 = await request(app)
      .delete('/files/file-canonical')
      .set('Authorization', `Bearer ${user1.accessToken}`);

    expect(res2.status).toBe(200);
    expect(res2.body.deleted).toBe(true);

    // NOW S3 object must be deleted!
    expect(FakeStorageService.__objectExists(sharedS3Key)).toBe(false);
  });

  it('preserves S3 object when canonical file is deleted first while alias still exists', async () => {
    // Delete user 1's canonical file first
    const res = await request(app)
      .delete('/files/file-canonical')
      .set('Authorization', `Bearer ${user1.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    // S3 object must STILL exist because user 2's alias relies on it!
    expect(FakeStorageService.__objectExists(sharedS3Key)).toBe(true);

    // User 2's alias is still downloadable
    const getRes = await request(app)
      .get('/files/file-dedup-alias/download')
      .set('Authorization', `Bearer ${user2.accessToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.downloadUrl).toBeDefined();

    // Now delete user 2's alias (final reference)
    const res2 = await request(app)
      .delete('/files/file-dedup-alias')
      .set('Authorization', `Bearer ${user2.accessToken}`);
    expect(res2.status).toBe(200);
    expect(res2.body.deleted).toBe(true);

    // S3 object must NOW be deleted since this was the last remaining reference
    expect(FakeStorageService.__objectExists(sharedS3Key)).toBe(false);
  });
});
