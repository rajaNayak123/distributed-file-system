import { ConflictError, NotFoundError } from '../../src/utils/errors.js';

let store = new Map();

function key(userId, fileId) {
  return `${userId}#${fileId}`;
}

export default class FakeFilesRepository {
  async createFile(fileItem) {
    const k = key(fileItem.userId, fileItem.fileId);
    if (store.has(k)) {
      throw new ConflictError('A file with this id already exists');
    }
    const item = { ...fileItem };
    store.set(k, item);
    return item;
  }

  async getFile({ userId, fileId }) {
    return store.get(key(userId, fileId)) || null;
  }

  async listFilesForUser({ userId, includeIncomplete = false }) {
    const items = [...store.values()].filter((i) => i.userId === userId);
    if (includeIncomplete) return items;
    return items.filter((i) => i.status === 'COMPLETED');
  }

  async updateFileStatus({ userId, fileId, fromStatuses, toStatus, extraAttributes = {} }) {
    const k = key(userId, fileId);
    const existing = store.get(k);
    if (!existing || !fromStatuses.includes(existing.status)) {
      throw new ConflictError(
        `Cannot transition file ${fileId} to ${toStatus}: current status is not one of [${fromStatuses.join(', ')}], or file does not exist`
      );
    }
    const updated = {
      ...existing,
      ...extraAttributes,
      status: toStatus,
      updatedAt: new Date().toISOString(),
    };
    store.set(k, updated);
    return updated;
  }

  async deleteFile({ userId, fileId }) {
    store.delete(key(userId, fileId));
    return true;
  }

  async requireOwnedFile({ userId, fileId }) {
    const file = await this.getFile({ userId, fileId });
    if (!file) {
      throw new NotFoundError('File not found');
    }
    return file;
  }

  async findByContentHash(contentHash) {
    return [...store.values()].filter(
      (item) => item.contentHash === contentHash || item.checksum === contentHash
    );
  }

  async incrementRefCount({ userId, fileId }) {
    const k = key(userId, fileId);
    const item = store.get(k);
    if (!item) {
      throw new NotFoundError('File not found');
    }
    item.refCount = (item.refCount || 0) + 1;
    item.updatedAt = new Date().toISOString();
    store.set(k, item);
    return item;
  }

  async decrementRefCount({ userId, fileId }) {
    const k = key(userId, fileId);
    const item = store.get(k);
    if (!item) {
      throw new NotFoundError('File not found');
    }
    item.refCount = Math.max(0, (item.refCount || 1) - 1);
    item.updatedAt = new Date().toISOString();
    store.set(k, item);
    return item;
  }

  static __reset() {
    store = new Map();
  }

  static __dump() {
    return [...store.values()];
  }
}
