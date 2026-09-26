'use strict';
// Any code that deletes an uploaded file by URL (photo removal, unit delete,
// demo-dealership cleanup) must resolve the path through here first. The
// `photos` column can contain values that were never validated at write time
// (CSV import rows, website-photo matching), so treat every stored URL as
// untrusted and only ever unlink a path that resolves inside our own upload
// directories.
const path = require('path');

const UPLOAD_ROOTS = {
  units: path.join(__dirname, '..', 'public', 'uploads', 'units'),
  dealers: path.join(__dirname, '..', 'public', 'uploads', 'dealers'),
};

function resolveUploadPath(url) {
  const text = String(url ?? '');
  const match = text.match(/^\/uploads\/(units|dealers)\/([^/]+)$/);
  if (!match) return null;
  const [, kind, filename] = match;
  if (!filename || filename.includes('..') || filename.includes('\\')) return null;
  const root = UPLOAD_ROOTS[kind];
  const resolved = path.join(root, filename);
  if (path.dirname(resolved) !== root) return null;
  return resolved;
}

module.exports = { resolveUploadPath };
