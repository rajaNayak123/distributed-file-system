import express from 'express';
import authGuard from '../middlewares/auth.middleware.js';
import * as uploadsController from '../controllers/uploads.controller.js';

const router = express.Router();

router.use(authGuard);
router.post('/', uploadsController.initiateUpload);
router.post('/:id/complete', uploadsController.completeUpload);

router.post('/:id/multipart/initiate', uploadsController.initiateMultipartUpload);
router.post('/:id/multipart/parts', uploadsController.getMultipartParts);
router.post('/:id/multipart/complete', uploadsController.completeMultipartUpload);
router.post('/:id/multipart/abort', uploadsController.abortMultipartUpload);

export default router;
