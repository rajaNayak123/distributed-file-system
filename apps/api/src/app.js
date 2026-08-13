import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

export default function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  return app;
}
