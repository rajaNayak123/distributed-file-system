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

export async function initiateMultipartUpload(req, res, next) {
  try {
    const fileId = assertString(req.params.id, 'id', { minLength: 1, maxLength: 128 });
    const result = await uploadsService.initiateMultipartUpload({
      userId: req.user.userId,
      fileId,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getMultipartParts(req, res, next) {
  try {
    const fileId = assertString(req.params.id, 'id', { minLength: 1, maxLength: 128 });
    const partNumbers = req.body.partNumbers;
    if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
      return res.status(400).json({ error: 'partNumbers must be a non-empty array' });
    }
    const parsedPartNumbers = partNumbers.map((pn) => assertPositiveInt(pn, 'partNumber', { max: 10000 }));
    
    const result = await uploadsService.getMultipartUploadPartUrls({
      userId: req.user.userId,
      fileId,
      partNumbers: parsedPartNumbers,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function completeMultipartUpload(req, res, next) {
  try {
    const fileId = assertString(req.params.id, 'id', { minLength: 1, maxLength: 128 });
    const parts = req.body.parts;
    if (!Array.isArray(parts)) {
      return res.status(400).json({ error: 'parts must be an array' });
    }
    const parsedParts = parts.map((p) => ({
      PartNumber: assertPositiveInt(p.partNumber, 'partNumber', { max: 10000 }),
      ETag: assertString(p.eTag, 'eTag', { minLength: 1, maxLength: 1024 }),
    }));

    const result = await uploadsService.completeMultipartUpload({
      userId: req.user.userId,
      fileId,
      parts: parsedParts,
    });
    const statusCode = result.status === 'COMPLETED' ? 200 : 422;
    res.status(statusCode).json(result);
  } catch (err) {
    next(err);
  }
}

export async function abortMultipartUpload(req, res, next) {
  try {
    const fileId = assertString(req.params.id, 'id', { minLength: 1, maxLength: 128 });
    const result = await uploadsService.abortMultipartUpload({
      userId: req.user.userId,
      fileId,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}