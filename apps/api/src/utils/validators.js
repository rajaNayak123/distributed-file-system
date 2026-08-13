import { ValidationError } from './errors.js';

export function assertString(value, fieldName, { minLength = 1, maxLength = 1024 } = {}) {
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    throw new ValidationError(`${fieldName} must be a string between ${minLength} and ${maxLength} characters`);
  }
  return value;
}

export function assertEmail(value, fieldName = 'email') {
  const email = assertString(value, fieldName, { minLength: 3, maxLength: 254 });
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL_RE.test(email)) {
    throw new ValidationError(`${fieldName} must be a valid email address`);
  }
  return email.toLowerCase();
}

export function assertPositiveInt(value, fieldName, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new ValidationError(`${fieldName} must be a positive integer no greater than ${max}`);
  }
  return n;
}

export function assertContentType(value) {
  const contentType = assertString(value, 'contentType', { minLength: 3, maxLength: 255 });
  const CT_RE = /^[a-zA-Z0-9!#$&\-^_.+]+\/[a-zA-Z0-9!#$&\-^_.+]+$/;
  if (!CT_RE.test(contentType)) {
    throw new ValidationError('contentType must be a valid MIME type, e.g. image/png');
  }
  return contentType;
}

export function assertFileName(value) {
  const fileName = assertString(value, 'fileName', { minLength: 1, maxLength: 255 });
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new ValidationError('fileName must not contain path separators');
  }
  return fileName;
}
