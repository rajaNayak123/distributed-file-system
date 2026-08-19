import FilesService from '../services/files.service.js';

const filesService = new FilesService();

function parseIncludeIncomplete(query) {
  return query.includeIncomplete === 'true' || query.includeIncomplete === '1';
}

export async function listFiles(req, res, next) {
  try {
    const includeIncomplete = parseIncludeIncomplete(req.query);
    const files = await filesService.listFiles({ userId: req.user.userId, includeIncomplete });
    res.status(200).json({ files });
  } catch (err) {
    next(err);
  }
}

export async function getFile(req, res, next) {
  try {
    const fileId = assertString(req.params.id, 'id', { minLength: 1, maxLength: 128 });
    const includeIncomplete = parseIncludeIncomplete(req.query);
    const file = await filesService.getFile({ userId: req.user.userId, fileId, includeIncomplete });
    res.status(200).json({ file });
  } catch (err) {
    next(err);
  }
}