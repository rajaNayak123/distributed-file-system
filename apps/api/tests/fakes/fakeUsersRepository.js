import { ConflictError } from '../../src/utils/errors.js';

let byId = new Map();
let byEmail = new Map();

export default class FakeUsersRepository {
  async createUser({ userId, email, passwordHash, createdAt }) {
    if (byEmail.has(email)) {
      throw new ConflictError('A user with this email already exists');
    }
    const item = { userId, email, passwordHash, createdAt };
    byId.set(userId, item);
    byEmail.set(email, item);
    return item;
  }

  async getUserById(userId) {
    return byId.get(userId) || null;
  }

  async getUserByEmail(email) {
    return byEmail.get(email) || null;
  }

  static __reset() {
    byId = new Map();
    byEmail = new Map();
  }
}
