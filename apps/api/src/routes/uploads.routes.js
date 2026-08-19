import express from 'express';
import authGuard from '../middlewares/auth.middleware.js';
import * as uploadsController from '../controllers/uploads.controller.js';

const router = express.Router();

router.use(authGuard);
router.post('/', uploadsController.initiateUpload);
router.post('/:id/complete', uploadsController.completeUpload);

export default router;
