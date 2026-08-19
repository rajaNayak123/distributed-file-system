import AuthService from '../services/auth.service.js';
import { assertEmail, assertString } from '../utils/validators.js';
import { ValidationError } from '../utils/errors.js';

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

export async function login(req, res, next) {
  try {
    const email = assertEmail(req.body.email);
    const password = assertString(req.body.password, 'password', { minLength: 1, maxLength: 128 });
    const result = await authService.login({ email, password });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function refresh(req, res, next) {
  try {
    if (!req.body.refreshToken) {
      throw new ValidationError('refreshToken is required');
    }
    const result = await authService.refresh({ refreshToken: req.body.refreshToken });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}