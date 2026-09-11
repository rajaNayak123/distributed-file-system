import request from 'supertest';
import { buildApp, resetFakes, registerAndLogin, FakeStorageService } from '../helpers/testApp.js';

async function createCompletedFile(app, accessToken) {
  const initiateRes = await request(app)
    .post('/uploads')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ fileName: 'secret.txt', contentType: 'text/plain', size: 128 });
  const { fileId } = initiateRes.body;

  const listRes = await request(app)
    .get('/files?includeIncomplete=true')
    .set('Authorization', `Bearer ${accessToken}`);
  const file = listRes.body.files.find((f) => f.fileId === fileId);
  FakeStorageService.__simulateClientPut(file.s3Key, { size: 128 });

  await request(app)
    .post(`/uploads/${fileId}/complete`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send();

  return fileId;
}

describe('Cross-user ownership enforcement', () => {
  let app;
  let ownerToken;
  let attackerToken;
  let fileId;

  beforeEach(async () => {
    resetFakes();
    app = buildApp();
    const owner = await registerAndLogin(app, request, { email: 'owner@example.com' });
    const attacker = await registerAndLogin(app, request, { email: 'attacker@example.com' });
    ownerToken = owner.accessToken;
    attackerToken = attacker.accessToken;
    fileId = await createCompletedFile(app, ownerToken);
  });

  it('owner can read their own file', async () => {
    const res = await request(app).get(`/files/${fileId}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
  });

  it('another user cannot get the file metadata (404, not 403 - existence is not leaked)', async () => {
    const res = await request(app).get(`/files/${fileId}`).set('Authorization', `Bearer ${attackerToken}`);
    expect(res.status).toBe(404);
  });

  it('another user cannot download the file', async () => {
    const res = await request(app)
      .get(`/files/${fileId}/download`)
      .set('Authorization', `Bearer ${attackerToken}`);
    expect(res.status).toBe(404);
  });

  it("another user's delete call is a no-op against the owner's file (idempotent-delete semantics mean it looks identical to deleting something that never existed for them)", async () => {
    const res = await request(app).delete(`/files/${fileId}`).set('Authorization', `Bearer ${attackerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.alreadyDeleted).toBe(true);

    // Confirm the owner's file is untouched.
    const stillThere = await request(app)
      .get(`/files/${fileId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(stillThere.status).toBe(200);
  });

  it("another user's file list never includes the owner's files", async () => {
    const res = await request(app).get('/files').set('Authorization', `Bearer ${attackerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
  });

  it('a client-supplied S3 key or fileId cannot be used to access another file (ownership is re-derived server-side)', async () => {
    const res = await request(app)
      .get(`/files/${fileId}`)
      .set('Authorization', `Bearer ${attackerToken}`)
      .query({ id: fileId }); 
    expect(res.status).toBe(404);
  });

  it('GET /files only returns COMPLETED files by default', async () => {
    await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ fileName: 'still-uploading.bin', contentType: 'application/octet-stream', size: 100 });

    const res = await request(app).get('/files').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.files.every((f) => f.status === 'COMPLETED')).toBe(true);

    const resAll = await request(app)
      .get('/files?includeIncomplete=true')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(resAll.body.files.some((f) => f.status === 'UPLOADING')).toBe(true);
  });
});
