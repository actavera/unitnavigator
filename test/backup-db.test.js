'use strict';
// The backup script produces a private, integrity-checked copy and prunes old ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

test('backup is a consistent private copy; retention keeps the newest N', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-backup-test-'));
  try {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const db = new Database(path.join(dataDir, 'unitnavigator.db'));
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');");
    db.close();
    const out = path.join(root, 'backups');
    fs.mkdirSync(out, { mode: 0o700 });
    ['unitnavigator-20200101-000000.db', 'unitnavigator-20200102-000000.db'].forEach(f => fs.writeFileSync(path.join(out, f), ''));
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'backup-db.js'), out, '--keep', '2'], { env: { ...process.env, UNITNAV_DATA_DIR: dataDir }, stdio: 'pipe' });
    const files = fs.readdirSync(out).sort();
    assert.equal(files.length, 2);
    assert.equal(files[0], 'unitnavigator-20200102-000000.db');
    const copy = path.join(out, files[1]);
    assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    const check = new Database(copy, { readonly: true });
    assert.equal(check.prepare('SELECT v FROM t').get().v, 'kept');
    check.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
