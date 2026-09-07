import { checkReadiness } from '../services/health.service.js';
import os from 'os';

export function liveness(req, res) {
  res.status(200).json({ status: 'ok', instance: os.hostname() });
}

export async function readiness(req, res) {
  const result = await checkReadiness();
  const status = result.ready ? 200 : 503;
  res.status(status).json({
    status: result.ready ? 'ready' : 'unavailable',
    instance: os.hostname(),
    checks: {
      dynamo: result.dynamo ? 'ok' : 'fail',
      s3: result.s3 ? 'ok' : 'fail',
    },
  });
}
