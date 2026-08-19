import UploadsService from '../services/uploads.service.js';
import { assertFileName, assertContentType, assertPositiveInt, assertString } from '../utils/validators.js';
import config from '../config/index.js';

const uploadsService = new UploadsService();

export async function initiateUpload(req, res, next) {
  try {
    const fileName = assertFileName(req.body.fileName);
    const contentType = assertContentType(req.body.contentType);
    const size = assertPositiveInt(req.body.size, 'size', { max: config.uploads.maxFileSizeBytes });

    const result = await uploadsService.initiateUpload({
      userId: req.user.userId,
      fileName,
      contentType,
      size,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function completeUpload(req, res, next) {
  try {
    const fileId = assertString(req.params.id, 'id', { minLength: 1, maxLength: 128 });
    const result = await uploadsService.completeUpload({ userId: req.user.userId, fileId });
    const statusCode = result.status === 'COMPLETED' ? 200 : 422;
    res.status(statusCode).json(result);
  } catch (err) {
    next(err);
  }
}