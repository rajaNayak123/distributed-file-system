let store = new Map();

function storeKey(userId, idempotencyKey) {
  return `${userId}::${idempotencyKey}`;
}

export default class FakeIdempotencyRepository {
  async createInProgress({ userId, idempotencyKey, requestHash }) {
    const key = storeKey(userId, idempotencyKey);
    if (store.has(key)) return null;
    const record = {
      PK: userId,
      SK: idempotencyKey,
      requestHash,
      status: 'IN_PROGRESS',
      result: null,
      statusCode: null,
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
    };
    store.set(key, record);
    return record;
  }

  async get({ userId, idempotencyKey }) {
    return store.get(storeKey(userId, idempotencyKey)) || null;
  }

  async markCompleted({ userId, idempotencyKey, statusCode, result }) {
    const key = storeKey(userId, idempotencyKey);
    const existing = store.get(key);
    if (!existing) return null;
    const updated = { ...existing, status: 'COMPLETED', statusCode, result: JSON.stringify(result) };
    store.set(key, updated);
    return updated;
  }

  async delete({ userId, idempotencyKey }) {
    store.delete(storeKey(userId, idempotencyKey));
    return true;
  }

  static __reset() {
    store = new Map();
  }

  static __getStore() {
    return store;
  }
}
