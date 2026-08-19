import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { AuthenticationError } from '../utils/errors.js';

export default function authGuard(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new AuthenticationError('Missing or malformed Authorization header'));
  }

  try {
    const payload = jwt.verify(token, config.jwt.accessSecret);
    if (payload.type !== 'access') {
      return next(new AuthenticationError('Invalid token type'));
    }
    req.user = { userId: payload.userId, email: payload.email };
    return next();
  } catch (err) {
    return next(new AuthenticationError('Invalid or expired access token'));
  }
}
