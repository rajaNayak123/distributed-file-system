import {
  runReconciliation,
  processReconciliation,
} from '../../src/processors/reconciliation.processor.js';
import { Readable } from 'stream';

describe('reconciliation.processor — unit', () => {
  const silentLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('runReconciliation — Case A: Missing S3 Objects', () => {
    it('marks suspicious DynamoDB items as FAILED when S3 object is missing', async () => {
      const suspiciousItems = [
        {
          userId: 'user-1',
          fileId: 'file-1',
          s3Key: 'users/user-1/files/file-1',
          status: 'COMPLETING',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          userId: 'user-2',
          fileId: 'file-2',
          s3Key: 'users/user-2/files/file-2',
          status: 'COMPLETED',
          checksum: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ];

      const filesRepository = {
        findSuspiciousUploads: jest.fn().mockResolvedValue(suspiciousItems),
        updateFileStatus: jest.fn().mockResolvedValue({}),
      };

      const s3Client = {
        send: jest.fn().mockImplementation((command) => {
          const name = command.constructor?.name || '';
          if (name.includes('HeadObject') || command.input?.Key) {
            const notFoundErr = new Error('NotFound');
            notFoundErr.name = 'NotFound';
            notFoundErr.$metadata = { httpStatusCode: 404 };
            return Promise.reject(notFoundErr);
          }
          if (name.includes('ListObjectsV2')) {
            return Promise.resolve({ Contents: [] });
          }
          return Promise.resolve({});
        }),
      };

      const result = await runReconciliation({
        filesRepository,
        s3Client,
        logger: silentLogger,
      });

      expect(result.caseAProcessed).toBe(2);
      expect(result.caseAFailed).toBe(2);

      expect(filesRepository.updateFileStatus).toHaveBeenCalledWith({
        userId: 'user-1',
        fileId: 'file-1',
        fromStatuses: ['COMPLETING'],
        toStatus: 'FAILED',
        extraAttributes: expect.objectContaining({
          failureReason: 'reconciliation: object missing',
        }),
      });

      expect(filesRepository.updateFileStatus).toHaveBeenCalledWith({
        userId: 'user-2',
        fileId: 'file-2',
        fromStatuses: ['COMPLETED'],
        toStatus: 'FAILED',
        extraAttributes: expect.objectContaining({
          failureReason: 'reconciliation: object missing',
        }),
      });
    });

    it('does NOT mark FAILED when S3 object exists, and repairs missing checksum', async () => {
      const suspiciousItems = [
        {
          userId: 'user-1',
          fileId: 'file-1',
          s3Key: 'users/user-1/files/file-1',
          status: 'COMPLETED',
          checksum: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ];

      const filesRepository = {
        findSuspiciousUploads: jest.fn().mockResolvedValue(suspiciousItems),
        updateFileStatus: jest.fn(),
        getFile: jest.fn().mockResolvedValue(suspiciousItems[0]),
        updateChecksum: jest.fn().mockResolvedValue({}),
      };

      const s3Client = {
        send: jest.fn().mockImplementation((command) => {
          const name = command.constructor?.name || '';
          if (name.includes('HeadObject')) {
            return Promise.resolve({ ContentLength: 1024 });
          }
          if (name.includes('GetObject')) {
            return Promise.resolve({
              Body: Readable.from([Buffer.from('reconciled content')]),
            });
          }
          if (name.includes('ListObjectsV2')) {
            return Promise.resolve({ Contents: [] });
          }
          return Promise.resolve({});
        }),
      };

      const result = await runReconciliation({
        filesRepository,
        s3Client,
        logger: silentLogger,
      });

      expect(result.caseAProcessed).toBe(1);
      expect(result.caseAFailed).toBe(0);
      expect(result.caseARepaired).toBe(1);
      expect(filesRepository.updateFileStatus).not.toHaveBeenCalled();
      expect(filesRepository.updateChecksum).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          fileId: 'file-1',
          checksum: expect.any(String),
        })
      );
    });
  });

  describe('runReconciliation — Case B: Orphan S3 Objects', () => {
    it('deletes S3 objects with missing or FAILED DynamoDB records older than grace period', async () => {
      const filesRepository = {
        findSuspiciousUploads: jest.fn().mockResolvedValue([]),
        getFile: jest.fn().mockImplementation(({ userId, fileId }) => {
          if (fileId === 'missing-file') return Promise.resolve(null);
          if (fileId === 'failed-file') {
            return Promise.resolve({
              userId,
              fileId,
              status: 'FAILED',
            });
          }
          if (fileId === 'valid-file') {
            return Promise.resolve({
              userId,
              fileId,
              status: 'COMPLETED',
            });
          }
          return Promise.resolve(null);
        }),
      };

      const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const recentDate = new Date(Date.now() - 5 * 60 * 1000);

      const s3Objects = [
        { Key: 'users/u1/files/missing-file', LastModified: oldDate },
        { Key: 'users/u2/files/failed-file', LastModified: oldDate },
        { Key: 'users/u3/files/valid-file', LastModified: oldDate },
        { Key: 'users/u4/files/recent-file', LastModified: recentDate },
      ];

      const deletedKeys = [];
      const s3Client = {
        send: jest.fn().mockImplementation((command) => {
          const name = command.constructor?.name || '';
          if (name.includes('ListObjectsV2')) {
            return Promise.resolve({ Contents: s3Objects });
          }
          if (name.includes('DeleteObject')) {
            deletedKeys.push(command.input.Key);
            return Promise.resolve({});
          }
          return Promise.resolve({});
        }),
      };

      const result = await runReconciliation({
        filesRepository,
        s3Client,
        logger: silentLogger,
      });

      expect(result.caseBScanned).toBe(4);
      expect(result.caseBOrphansDeleted).toBe(2);
      expect(deletedKeys).toContain('users/u1/files/missing-file');
      expect(deletedKeys).toContain('users/u2/files/failed-file');
      expect(deletedKeys).not.toContain('users/u3/files/valid-file');
      expect(deletedKeys).not.toContain('users/u4/files/recent-file');
    });

    it('preserves S3 object when canonical DynamoDB record is missing or failed but other active dedup records reference it', async () => {
      const filesRepository = {
        findSuspiciousUploads: jest.fn().mockResolvedValue([]),
        getFile: jest.fn().mockImplementation(({ fileId }) => {
          if (fileId === 'deleted-canonical-file') return Promise.resolve(null);
          if (fileId === 'failed-canonical-file') {
            return Promise.resolve({
              userId: 'u1',
              fileId: 'failed-canonical-file',
              status: 'FAILED',
            });
          }
          return Promise.resolve(null);
        }),
        hasActiveReferencesToS3Key: jest.fn().mockImplementation((key) => {
          if (key === 'users/u1/files/deleted-canonical-file') return Promise.resolve(true);
          if (key === 'users/u1/files/failed-canonical-file') return Promise.resolve(true);
          return Promise.resolve(false);
        }),
      };

      const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const s3Objects = [
        { Key: 'users/u1/files/deleted-canonical-file', LastModified: oldDate },
        { Key: 'users/u1/files/failed-canonical-file', LastModified: oldDate },
      ];

      const deletedKeys = [];
      const s3Client = {
        send: jest.fn().mockImplementation((command) => {
          const name = command.constructor?.name || '';
          if (name.includes('ListObjectsV2')) {
            return Promise.resolve({ Contents: s3Objects });
          }
          if (name.includes('DeleteObject')) {
            deletedKeys.push(command.input.Key);
            return Promise.resolve({});
          }
          return Promise.resolve({});
        }),
      };

      const result = await runReconciliation({
        filesRepository,
        s3Client,
        logger: silentLogger,
      });

      expect(result.caseBScanned).toBe(2);
      expect(result.caseBOrphansDeleted).toBe(0);
      expect(deletedKeys).toHaveLength(0);
      expect(filesRepository.hasActiveReferencesToS3Key).toHaveBeenCalledWith(
        'users/u1/files/deleted-canonical-file'
      );
      expect(filesRepository.hasActiveReferencesToS3Key).toHaveBeenCalledWith(
        'users/u1/files/failed-canonical-file'
      );
    });
  });

  describe('processReconciliation (on-demand)', () => {
    it('marks file FAILED if S3 object is missing', async () => {
      const file = {
        userId: 'u1',
        fileId: 'f1',
        s3Key: 'users/u1/files/f1',
        status: 'COMPLETING',
      };

      const filesRepository = {
        getFile: jest.fn().mockResolvedValue(file),
        updateFileStatus: jest.fn().mockResolvedValue({}),
      };

      const s3Client = {
        send: jest.fn().mockRejectedValue({
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        }),
      };

      const res = await processReconciliation(
        { userId: 'u1', fileId: 'f1' },
        { filesRepository, s3Client }
      );

      expect(res.status).toBe('FAILED');
      expect(res.reason).toBe('reconciliation: object missing');
      expect(filesRepository.updateFileStatus).toHaveBeenCalledWith({
        userId: 'u1',
        fileId: 'f1',
        fromStatuses: ['COMPLETING'],
        toStatus: 'FAILED',
        extraAttributes: expect.objectContaining({
          failureReason: 'reconciliation: object missing',
        }),
      });
    });
  });
});
