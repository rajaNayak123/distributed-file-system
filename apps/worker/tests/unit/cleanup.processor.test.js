import { runCleanup } from '../../src/processors/cleanup.processor.js';

describe('cleanup.processor — unit', () => {
  const silentLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('aborts abandoned multipart uploads in S3 and marks them FAILED in DynamoDB', async () => {
    const abandoned = [
      {
        userId: 'user-1',
        fileId: 'file-1',
        s3Key: 'users/user-1/files/file-1',
        s3UploadId: 's3-upload-123',
        status: 'UPLOADING',
      },
      {
        userId: 'user-2',
        fileId: 'file-2',
        s3Key: 'users/user-2/files/file-2',
        status: 'UPLOADING',
      },
    ];

    const filesRepository = {
      findAbandonedUploads: jest.fn().mockResolvedValue(abandoned),
      findStuckCompleting: jest.fn().mockResolvedValue([]),
      updateFileStatus: jest.fn().mockResolvedValue({}),
    };

    const s3Client = {
      send: jest.fn().mockResolvedValue({}),
    };

    const result = await runCleanup({
      filesRepository,
      s3Client,
      logger: silentLogger,
    });

    expect(result.abandonedProcessed).toBe(2);
    expect(result.stuckCompletingProcessed).toBe(0);

    expect(s3Client.send).toHaveBeenCalledTimes(1);
    const sentCommand = s3Client.send.mock.calls[0][0];
    expect(sentCommand.input).toEqual(
      expect.objectContaining({
        Key: 'users/user-1/files/file-1',
        UploadId: 's3-upload-123',
      })
    );

    expect(filesRepository.updateFileStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        fileId: 'file-1',
        fromStatuses: ['UPLOADING'],
        toStatus: 'FAILED',
      })
    );

    expect(filesRepository.updateFileStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        fileId: 'file-2',
        fromStatuses: ['UPLOADING'],
        toStatus: 'FAILED',
      })
    );
  });

  it('marks stuck COMPLETING uploads as FAILED', async () => {
    const stuck = [
      {
        userId: 'user-3',
        fileId: 'file-3',
        status: 'COMPLETING',
      },
    ];

    const filesRepository = {
      findAbandonedUploads: jest.fn().mockResolvedValue([]),
      findStuckCompleting: jest.fn().mockResolvedValue(stuck),
      updateFileStatus: jest.fn().mockResolvedValue({}),
    };

    const s3Client = {
      send: jest.fn().mockResolvedValue({}),
    };

    const result = await runCleanup({
      filesRepository,
      s3Client,
      logger: silentLogger,
    });

    expect(result.abandonedProcessed).toBe(0);
    expect(result.stuckCompletingProcessed).toBe(1);

    expect(filesRepository.updateFileStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-3',
        fileId: 'file-3',
        fromStatuses: ['COMPLETING'],
        toStatus: 'FAILED',
        extraAttributes: expect.objectContaining({
          failureReason: expect.stringMatching(/stuck in COMPLETING/i),
        }),
      })
    );
  });

  it('handles S3 abort errors gracefully without crashing the cleanup loop', async () => {
    const abandoned = [
      {
        userId: 'user-1',
        fileId: 'file-1',
        s3Key: 'users/user-1/files/file-1',
        s3UploadId: 's3-upload-err',
        status: 'UPLOADING',
      },
    ];

    const filesRepository = {
      findAbandonedUploads: jest.fn().mockResolvedValue(abandoned),
      findStuckCompleting: jest.fn().mockResolvedValue([]),
      updateFileStatus: jest.fn().mockResolvedValue({}),
    };

    const s3Client = {
      send: jest.fn().mockRejectedValue(new Error('S3 network glitch')),
    };

    const result = await runCleanup({
      filesRepository,
      s3Client,
      logger: silentLogger,
    });

    expect(result.abandonedProcessed).toBe(1);
    expect(filesRepository.updateFileStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        fileId: 'file-1',
        fromStatuses: ['UPLOADING'],
        toStatus: 'FAILED',
      })
    );
  });

  it('handles ConditionalCheckFailedException silently when another worker replica handles the upload', async () => {
    const abandoned = [
      {
        userId: 'user-1',
        fileId: 'file-1',
        status: 'UPLOADING',
      },
    ];

    const conditionalErr = new Error('Conditional check failed');
    conditionalErr.name = 'ConditionalCheckFailedException';

    const filesRepository = {
      findAbandonedUploads: jest.fn().mockResolvedValue(abandoned),
      findStuckCompleting: jest.fn().mockResolvedValue([]),
      updateFileStatus: jest.fn().mockRejectedValue(conditionalErr),
    };

    const s3Client = {
      send: jest.fn().mockResolvedValue({}),
    };

    const result = await runCleanup({
      filesRepository,
      s3Client,
      logger: silentLogger,
    });

    expect(result.abandonedProcessed).toBe(1);
    expect(silentLogger.error).not.toHaveBeenCalled();
  });
});
