import express from 'express';
import authGuard from '../middlewares/auth.middleware.js';
import * as filesController from '../controllers/files.controller.js';
import * as uploadsController from '../controllers/uploads.controller.js';

const router = express.Router();

router.use(authGuard);
router.get('/', filesController.listFiles);
router.get('/:id', filesController.getFile);
router.get('/:id/download', filesController.getDownloadUrl);
router.delete('/:id', filesController.deleteFile);

router.post('/:id/retry', uploadsController.retryUpload);

export default router;
