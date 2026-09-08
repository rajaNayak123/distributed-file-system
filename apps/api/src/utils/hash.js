import { createHash } from 'crypto';

export function hashRequestBody(body) {
  const canonical = JSON.stringify(body, Object.keys(body || {}).sort());
  return createHash('sha256').update(canonical).digest('hex');
}
