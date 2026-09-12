import request from 'supertest';
import { buildApp, resetFakes, registerAndLogin, FakeStorageService } from '../helpers/testApp.js';

describe('Presigned upload flow (Phase 2)', () => {
  let app;
  let accessToken;

  beforeEach(async () => {
    resetFakes();
    app = buildApp();
    ({ accessToken } = await registerAndLogin(app, request));
  });

  it('initiates an upload and returns a presigned URL, uploadId, fileId and expiry', async () => {
    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'report.pdf', contentType: 'application/pdf', size: 2048 });

    expect(res.status).toBe(201);
    expect(res.body.uploadId).toBeDefined();
    expect(res.body.fileId).toBe(res.body.uploadId);
    expect(res.body.presignedUrl).toMatch(/^https:\/\/fake-s3\.local\//);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('marks the upload COMPLETED once the object is verified present in S3, then supports download and idempotent delete', async () => {
    const initiateRes = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'archive.zip', contentType: 'application/zip', size: 8192 });
    const { fileId } = initiateRes.body;

    const listRes = await request(app)
      .get('/files?includeIncomplete=true')
      .set('Authorization', `Bearer ${accessToken}`);
    const file = listRes.body.files.find((f) => f.fileId === fileId);
    expect(file.status).toBe('UPLOADING');

    FakeStorageService.__simulateClientPut(file.s3Key, { size: 8192, contentType: 'application/zip' });

    const completeRes = await request(app)
      .post(`/uploads/${fileId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe('COMPLETED');
    expect(completeRes.body.size).toBe(8192);

    const getRes = await request(app)
      .get(`/files/${fileId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.file.status).toBe('COMPLETED');

    const downloadRes = await request(app)
      .get(`/files/${fileId}/download`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.body.downloadUrl).toMatch(/^https:\/\/fake-s3\.local\//);

    const del1 = await request(app)
      .delete(`/files/${fileId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(del1.status).toBe(200);
    expect(del1.body.deleted).toBe(true);

    const del2 = await request(app)
      .delete(`/files/${fileId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(del2.status).toBe(200);
    expect(del2.body.deleted).toBe(true);
    expect(del2.body.alreadyDeleted).toBe(true);
  });

  it('completing an upload whose S3 object does not exist transitions to FAILED, not COMPLETED', async () => {
    const initiateRes = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'never-uploaded.bin', contentType: 'application/octet-stream', size: 1024 });
    const { fileId } = initiateRes.body;

    const completeRes = await request(app)
      .post(`/uploads/${fileId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();

    expect(completeRes.status).toBe(422);
    expect(completeRes.body.status).toBe('FAILED');
    expect(completeRes.body.failureReason).toMatch(/not found/i);
  });

  it('rejects an invalid contentType or missing fields with 400', async () => {
    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'x.txt', contentType: 'not-a-mime-type', size: 10 });
    expect(res.status).toBe(400);
  });

  it('refuses to generate a download URL for a file that is not yet COMPLETED', async () => {
    const initiateRes = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'still-going.bin', contentType: 'application/octet-stream', size: 500 });
    const { fileId } = initiateRes.body;

    const downloadRes = await request(app)
      .get(`/files/${fileId}/download`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(downloadRes.status).toBe(409);
    expect(downloadRes.body.error.category).toBe('CONFLICT');
  });

  it('refuses to generate a download URL for a FAILED upload', async () => {
    const initiateRes = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'broken.bin', contentType: 'application/octet-stream', size: 500 });
    const { fileId } = initiateRes.body;

    await request(app)
      .post(`/uploads/${fileId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();

    const downloadRes = await request(app)
      .get(`/files/${fileId}/download`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(downloadRes.status).toBe(409);
  });
});
