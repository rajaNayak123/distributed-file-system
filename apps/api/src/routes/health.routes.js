import express from 'express';
import * as healthController from '../controllers/health.controller.js';

const router = express.Router();

router.get('/health', healthController.liveness);

router.get('/ready', healthController.readiness);

export default router;
