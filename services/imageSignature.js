'use strict';
// multer's fileFilter only sees the client-supplied Content-Type of the
// multipart part, and the ORIGINAL FILENAME is entirely caller-controlled —
// both are trivially spoofable. Magic-byte-valid content named "payload.html"
// would still be served from our own origin with an HTML content type if we
// ever kept that extension. So every upload lands on disk under a neutral
// temporary name (see the multer storage configs in routes/inventory.js and
// routes/admin.js), and only after we've inspected the real bytes here do we
// rename it to a fully server-generated filename whose extension is taken
// exclusively from the detected image type — never from anything the caller sent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SIGNATURES = [
  { type: 'png', check: buf => buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a },
  { type: 'jpeg', check: buf => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff },
  { type: 'gif', check: buf => buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') },
  { type: 'webp', check: buf => buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' },
];

const EXTENSION_BY_TYPE = { png: '.png', jpeg: '.jpg', gif: '.gif', webp: '.webp' };
const CONTENT_TYPE_BY_TYPE = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function detectImageType(buffer) {
  for (const sig of SIGNATURES) {
    if (sig.check(buffer)) return sig.type;
  }
  return null;
}

function readImageTypeFromFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, header, 0, 16, 0);
    return detectImageType(header.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function isValidImageFile(filePath) {
  return readImageTypeFromFile(filePath) !== null;
}

// Takes a multer file object pointing at a just-uploaded temp file, inspects
// its real content, and either renames it to a trusted, server-generated
// name (extension from the detected type) or deletes it. Returns
// { filename, path, type, contentType } on success, or null if the content
// wasn't a recognized image (the temp file is deleted either way).
function finalizeUploadedImage(file, { namePrefix = '' } = {}) {
  const type = readImageTypeFromFile(file.path);
  if (!type) {
    try { fs.unlinkSync(file.path); } catch { /* already gone */ }
    return null;
  }
  const dir = path.dirname(file.path);
  const filename = `${namePrefix}${Date.now()}-${crypto.randomBytes(8).toString('hex')}${EXTENSION_BY_TYPE[type]}`;
  const finalPath = path.join(dir, filename);
  fs.renameSync(file.path, finalPath);
  return { filename, path: finalPath, type, contentType: CONTENT_TYPE_BY_TYPE[type] };
}

// Finalizes every file in a multer files array, keeping only the valid ones.
function finalizeUploadedImages(files) {
  const valid = [];
  const rejected = [];
  for (const file of files) {
    const result = finalizeUploadedImage(file);
    if (result) valid.push(result);
    else rejected.push(file.filename);
  }
  return { valid, rejected };
}

module.exports = {
  detectImageType,
  isValidImageFile,
  finalizeUploadedImage,
  finalizeUploadedImages,
  EXTENSION_BY_TYPE,
};
