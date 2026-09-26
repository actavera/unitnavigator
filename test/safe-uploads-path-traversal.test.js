'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { resolveUploadPath } = require('../services/uploads');

const UNITS_ROOT = path.join(__dirname, '..', 'public', 'uploads', 'units');
const DEALERS_ROOT = path.join(__dirname, '..', 'public', 'uploads', 'dealers');

test('rejects path-traversal attempts disguised as a photo URL', () => {
  for (const bad of [
    '../../../../etc/passwd',
    '/uploads/units/../../../../etc/passwd',
    '/uploads/units/../../database.js',
    '/uploads/units/..%2f..%2fdatabase.js',
    '/uploads/units/subdir/../../secret.txt',
    '/etc/passwd',
    '/uploads/units/',
    '/uploads/other/file.png',
    '',
    null,
    undefined,
  ]) {
    assert.equal(resolveUploadPath(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('resolves a legitimate, server-generated upload filename inside the right directory', () => {
  const unitPath = resolveUploadPath('/uploads/units/1700000000000-0-abcd1234.jpg');
  assert.equal(unitPath, path.join(UNITS_ROOT, '1700000000000-0-abcd1234.jpg'));

  const dealerPath = resolveUploadPath('/uploads/dealers/12-1700000000000-logo.png');
  assert.equal(dealerPath, path.join(DEALERS_ROOT, '12-1700000000000-logo.png'));
});
