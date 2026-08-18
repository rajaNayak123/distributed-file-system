import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import config from '../config/index.js';
import UsersRepository from '../repositories/users.repository.js';
import { AuthenticationError, ValidationError } from '../utils/errors.js';

const SALT_ROUNDS = 12;

export default class AuthService {
  constructor(usersRepository = new UsersRepository()) {
    this.usersRepository = usersRepository;
  }

  async register({ email, password }) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new ValidationError('password must be at least 8 characters');
    }
    const existing = await this.usersRepository.getUserByEmail(email);
    if (existing) {
      throw new ValidationError('An account with this email already exists');
    }
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId = randomUUID();
    const user = await this.usersRepository.createUser({
      userId,
      email,
      passwordHash,
      createdAt: new Date().toISOString(),
    });
    return this._issueTokens(user);
  }

  async login({ email, password }) {
    const user = await this.usersRepository.getUserByEmail(email);
    if (!user) {
      throw new AuthenticationError('Invalid email or password');
    }
    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new AuthenticationError('Invalid email or password');
    }
    return this._issueTokens(user);
  }

  async refresh({ refreshToken }) {
    let payload;
    try {
      payload = jwt.verify(refreshToken, config.jwt.refreshSecret);
    } catch (err) {
      throw new AuthenticationError('Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new AuthenticationError('Invalid token type');
    }
    const user = await this.usersRepository.getUserById(payload.userId);
    if (!user) {
      throw new AuthenticationError('User no longer exists');
    }
    return this._issueTokens(user);
  }

  _issueTokens(user) {
    const accessToken = jwt.sign(
      { userId: user.userId, email: user.email, type: 'access' },
      config.jwt.accessSecret,
      { expiresIn: config.jwt.accessExpiresIn }
    );
    const refreshToken = jwt.sign(
      { userId: user.userId, type: 'refresh' },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpiresIn }
    );
    return {
      accessToken,
      refreshToken,
      user: { userId: user.userId, email: user.email },
    };
  }
}
