import fs from 'fs';
import path from 'path';

// Note: this test file relies on __dirname, which Babel's CommonJS-target
// transform provides automatically when Jest transpiles this ESM source for
// execution (see babel.config.cjs). It is not run via Node's native ESM
// loader, where __dirname wouldn't exist - only the transpiled test run does.
const SRC_DIR = path.join(__dirname, '..', '..', 'src');

// Patterns that would indicate file bytes are being persisted to local disk
// inside the API tier - forbidden by the project's core principle (API
// servers must NEVER permanently store uploaded file bytes on local disk).
// This is a static guard, not a runtime one: it fails the build the moment
// someone (in a later phase) accidentally reaches for multer or a disk
// write API instead of streaming through S3.
const FORBIDDEN_PATTERNS = [
  /from ['"]multer['"]/,
  /require\(['"]multer['"]\)/,
  /fs\.writeFile/,
  /fs\.writeFileSync/,
  /fs\.createWriteStream/,
  /fs\.appendFile/,
];

function listJsFilesRecursive(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFilesRecursive(fullPath);
    if (entry.isFile() && entry.name.endsWith('.js')) return [fullPath];
    return [];
  });
}

describe('No local disk writes for file bytes (Phase 1/2 core principle)', () => {
  const jsFiles = listJsFilesRecursive(SRC_DIR);

  it('found at least the expected source files (sanity check the scan itself works)', () => {
    expect(jsFiles.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN_PATTERNS.map((p) => [p.toString(), p]))(
    'no source file matches forbidden pattern %s',
    (_label, pattern) => {
      const offenders = jsFiles.filter((file) => pattern.test(fs.readFileSync(file, 'utf8')));
      expect(offenders).toEqual([]);
    }
  );

  it('the only body parser configured in app.js is express.json (no multipart/raw upload middleware)', () => {
    const appJs = fs.readFileSync(path.join(SRC_DIR, 'app.js'), 'utf8');
    expect(appJs).toContain('express.json(');
    expect(appJs).not.toMatch(/express\.raw\(/);
    expect(appJs).not.toMatch(/multer\(/);
  });
});
