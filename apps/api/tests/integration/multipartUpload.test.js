import request from 'supertest';
import { buildApp, resetFakes, registerAndLogin, FakeStorageService } from '../helpers/testApp.js';

describe('Multipart upload flow (Phase 3)', () => {
  let app;
  let accessToken;

  beforeEach(async () => {
    resetFakes();
    app = buildApp();
    ({ accessToken } = await registerAndLogin(app, request));
  });

  it('initiates a multipart upload, gets part URLs, and completes successfully', async () => {
    const initiateRes = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'large-video.mp4', contentType: 'video/mp4', size: 60 * 1024 * 1024 });

    expect(initiateRes.status).toBe(201);
    expect(initiateRes.body.multipartRequired).toBe(true);
    const { fileId } = initiateRes.body;

    const multipartInitRes = await request(app)
      .post(`/uploads/${fileId}/multipart/initiate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();
    
    expect(multipartInitRes.status).toBe(200);
    expect(multipartInitRes.body.s3UploadId).toBeDefined();

    const partsRes = await request(app)
      .post(`/uploads/${fileId}/multipart/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumbers: [1, 2] });
    
    expect(partsRes.status).toBe(200);
    expect(partsRes.body.presignedUrls.length).toBe(2);
    expect(partsRes.body.presignedUrls[0].url).toMatch(/partNumber=1/);

    const partsRes2 = await request(app)
      .post(`/uploads/${fileId}/multipart/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumbers: [2] });
    expect(partsRes2.status).toBe(200);
    expect(partsRes2.body.presignedUrls.length).toBe(1);

    const listRes = await request(app)
      .get('/files?includeIncomplete=true')
      .set('Authorization', `Bearer ${accessToken}`);
    const file = listRes.body.files.find((f) => f.fileId === fileId);
    FakeStorageService.__simulateClientPut(file.s3Key, { size: 60 * 1024 * 1024, contentType: 'video/mp4' });

    const completeRes = await request(app)
      .post(`/uploads/${fileId}/multipart/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, eTag: '"etag-1"' }, { partNumber: 2, eTag: '"etag-2"' }] });
    
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe('COMPLETED');
  });

  it('abort correctly frees the upload and updates status', async () => {
    const initiateRes = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'large-video.mp4', contentType: 'video/mp4', size: 60 * 1024 * 1024 });
    const { fileId } = initiateRes.body;

    await request(app)
      .post(`/uploads/${fileId}/multipart/initiate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();

    const abortRes = await request(app)
      .post(`/uploads/${fileId}/multipart/abort`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();
    
    expect(abortRes.status).toBe(200);
    expect(abortRes.body.status).toBe('FAILED');
    expect(abortRes.body.failureReason).toBe('Aborted by user');
  });

  it('complete called with a missing/mismatched part fails gracefully', async () => {
    const initiateRes = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'large-video.mp4', contentType: 'video/mp4', size: 60 * 1024 * 1024 });
    const { fileId } = initiateRes.body;

    await request(app)
      .post(`/uploads/${fileId}/multipart/initiate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();

    await request(app)
      .post(`/uploads/${fileId}/multipart/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumbers: [1, 2] });

    const completeRes = await request(app)
      .post(`/uploads/${fileId}/multipart/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, eTag: '"etag-1"' }] });
    
    expect(completeRes.status).toBe(422);
    expect(completeRes.body.status).toBe('FAILED');
    expect(completeRes.body.failureReason).toMatch(/not found/i);
  });

  it('allows retrying a FAILED multipart upload, restarting multipart upload without duplicate records', async () => {
    const initiateRes = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'large-video.mp4', contentType: 'video/mp4', size: 60 * 1024 * 1024 });
    const { fileId } = initiateRes.body;

    await request(app)
      .post(`/uploads/${fileId}/multipart/initiate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();

    const abortRes = await request(app)
      .post(`/uploads/${fileId}/multipart/abort`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();
    expect(abortRes.body.status).toBe('FAILED');

    const retryRes = await request(app)
      .post(`/files/${fileId}/retry`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.fileId).toBe(fileId);
    expect(retryRes.body.uploadType).toBe('multipart');
    expect(retryRes.body.s3UploadId).toBeDefined();

    const partsRes = await request(app)
      .post(`/uploads/${fileId}/multipart/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumbers: [1] });
    expect(partsRes.status).toBe(200);

    const listRes = await request(app)
      .get('/files?includeIncomplete=true')
      .set('Authorization', `Bearer ${accessToken}`);
    const file = listRes.body.files.find((f) => f.fileId === fileId);
    FakeStorageService.__simulateClientPut(file.s3Key, { size: 60 * 1024 * 1024, contentType: 'video/mp4' });

    const completeRes = await request(app)
      .post(`/uploads/${fileId}/multipart/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, eTag: '"etag-1"' }] });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe('COMPLETED');

    const finalFiles = await request(app)
      .get('/files')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(finalFiles.body.files.filter((f) => f.fileId === fileId)).toHaveLength(1);
  });
});
