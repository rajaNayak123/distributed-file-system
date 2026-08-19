import AuthService from '../services/auth.service.js';
import { assertEmail, assertString } from '../utils/validators.js';

const authService = new AuthService();

export async function register(req, res, next) {
  try {
    const email = assertEmail(req.body.email);
    const password = assertString(req.body.password, 'password', { minLength: 8, maxLength: 128 });
    const result = await authService.register({ email, password });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}