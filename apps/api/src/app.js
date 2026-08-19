import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import authRoutes from './routes/auth.routes.js';
import filesRoutes from './routes/files.routes.js';
import uploadsRoutes from './routes/uploads.routes.js';
import healthRoutes from './routes/health.routes.js';

import requestIdMiddleware from './middlewares/requestId.middleware.js';
import requestLoggerMiddleware from './middlewares/requestLogger.middleware.js';
import errorHandlerMiddleware from './middlewares/errorHandler.middleware.js';
import notFoundMiddleware from './middlewares/notFound.middleware.js';

export default function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(requestIdMiddleware);
  app.use(requestLoggerMiddleware);

  app.use('/', healthRoutes);
  app.use('/auth', authRoutes);
  app.use('/uploads', uploadsRoutes);
  app.use('/files', filesRoutes);

  app.use(notFoundMiddleware);
  app.use(errorHandlerMiddleware);

  return app;
}
