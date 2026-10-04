'use strict';
// The production database was found world-readable (data/ 755, db/-wal/-shm
// 644). These tests pin the durable fix: a private data directory and
// database files that stay private across file recreation and restarts,
// verified before the server accepts traffic — without a global umask change.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('node:child_process');
const {
  DataDirSecurityError, ensurePrivateDataDir, ensurePrivateDbFiles, assertPrivate,
} = require('../services/dataDirSecurity');

const REPO_ROOT = path.join(__dirname, '..');
const skip = process.platform !== 'win32' ? false : 'permission bits are not enforced on this platform';
const mode = p => fs.statSync(p).mode & 0o777;
const octal = n => n.toString(8);

const created = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-dirsec-test-'));
  created.push(dir);
  return dir;
}
test.after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });

// Loads database.js in a fresh process (it opens the DB at require time),
// does a write so the WAL exists, and reports the modes it sees while the
// connection is still open.
const CHILD = `
const fs = require('fs'), path = require('path');
const umaskBefore = process.umask();
const db = require('./database');
db.exec('CREATE TABLE IF NOT EXISTS probe (n INTEGER)');
db.prepare('INSERT INTO probe VALUES (1)').run();
const dir = process.env.UNITNAV_DATA_DIR;
fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x');
const out = { umaskBefore, umaskAfter: process.umask(), dir: fs.statSync(dir).mode & 0o777, files: {} };
for (const f of fs.readdirSync(dir)) out.files[f] = fs.statSync(path.join(dir, f)).mode & 0o777;
console.log(JSON.stringify(out));
process.exit(0);
`;

function runChild(dataDir) {
  const res = spawnSync(process.execPath, ['-e', CHILD], {
    cwd: REPO_ROOT,
    env: { ...process.env, UNITNAV_DATA_DIR: dataDir, NODE_ENV: 'test' },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

test('ensurePrivateDataDir creates a missing directory as 0700', { skip }, () => {
  const dir = path.join(tmp(), 'nested', 'data');
  ensurePrivateDataDir(dir);
  assert.equal(octal(mode(dir)), '700');
});

test('ensurePrivateDataDir tightens an existing world-readable directory to 0700', { skip }, () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o755);
  ensurePrivateDataDir(dir);
  assert.equal(octal(mode(dir)), '700');
});

test('ensurePrivateDataDir refuses a path that is not a directory', { skip }, () => {
  const file = path.join(tmp(), 'plain-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => ensurePrivateDataDir(file));
});

test('ensurePrivateDbFiles strips group/other from the db, WAL and SHM, and ignores absent ones', { skip }, () => {
  const dir = tmp();
  const db = path.join(dir, 'unitnavigator.db');
  for (const suffix of ['', '-wal', '-shm']) {
    fs.writeFileSync(db + suffix, 'x');
    fs.chmodSync(db + suffix, 0o644);
  }
  ensurePrivateDbFiles(db); // -journal does not exist: must not throw
  for (const suffix of ['', '-wal', '-shm']) assert.equal(octal(mode(db + suffix)), '600', `unitnavigator.db${suffix}`);
  assert.ok(!fs.existsSync(db + '-journal'));
});

test('ensurePrivateDbFiles refuses a symlinked database file', { skip }, () => {
  const dir = tmp();
  const target = path.join(dir, 'elsewhere');
  fs.writeFileSync(target, 'x');
  fs.symlinkSync(target, path.join(dir, 'unitnavigator.db-wal'));
  assert.throws(() => ensurePrivateDbFiles(path.join(dir, 'unitnavigator.db')), DataDirSecurityError);
});

test('assertPrivate passes when private and throws on a loose directory or a loose file', { skip }, () => {
  const dir = tmp();
  const db = path.join(dir, 'unitnavigator.db');
  fs.writeFileSync(db, 'x');
  fs.chmodSync(db, 0o600);
  assertPrivate(dir, db);

  fs.chmodSync(db, 0o640);
  assert.throws(() => assertPrivate(dir, db), /accessible to group\/other/);
  fs.chmodSync(db, 0o600);

  fs.chmodSync(dir, 0o750);
  assert.throws(() => assertPrivate(dir, db), /accessible to group\/other/);
});

test('loading database.js repairs a previously world-readable data directory, db, WAL and SHM', { skip }, () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o755);
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path.join(dir, 'unitnavigator.db' + suffix);
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o644);
  }
  const out = runChild(dir);
  assert.equal(octal(out.dir), '700');
  for (const name of ['unitnavigator.db', 'unitnavigator.db-wal', 'unitnavigator.db-shm']) {
    assert.equal(octal(out.files[name]), '600', name);
  }
});

test('a fresh database and the WAL/SHM files SQLite creates for it are private from the first write', { skip }, () => {
  const dir = path.join(tmp(), 'brand-new-data');
  const out = runChild(dir);
  assert.equal(octal(out.dir), '700');
  assert.equal(octal(out.files['unitnavigator.db']), '600');
  assert.ok('unitnavigator.db-wal' in out.files && 'unitnavigator.db-shm' in out.files, 'sanity: the WAL and SHM must exist for this to prove anything');
  assert.equal(octal(out.files['unitnavigator.db-wal']), '600');
  assert.equal(octal(out.files['unitnavigator.db-shm']), '600');
});

test('WAL/SHM files recreated after a restart or deleted outright come back private', { skip }, () => {
  const dir = tmp();
  runChild(dir); // first run leaves -wal/-shm behind (process exits without closing)
  const second = runChild(dir); // restart over existing files
  assert.equal(octal(second.files['unitnavigator.db-wal']), '600');

  fs.rmSync(path.join(dir, 'unitnavigator.db-wal'), { force: true });
  fs.rmSync(path.join(dir, 'unitnavigator.db-shm'), { force: true });
  const third = runChild(dir); // SQLite recreates both
  assert.ok('unitnavigator.db-wal' in third.files && 'unitnavigator.db-shm' in third.files);
  assert.equal(octal(third.files['unitnavigator.db-wal']), '600');
  assert.equal(octal(third.files['unitnavigator.db-shm']), '600');
});

test('no global umask change: the process umask is untouched and unrelated files keep their normal mode', { skip }, () => {
  const out = runChild(tmp());
  assert.equal(out.umaskAfter, out.umaskBefore, 'requiring database.js must not change the process umask');
  // unrelated.txt was created by the child with default permissions: it is
  // only the 0700 directory that keeps it private, not a umask.
  assert.equal(octal(out.files['unrelated.txt']), octal(0o666 & ~out.umaskBefore));
});

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.status) return true; } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

test('the server repairs loosened permissions and only then accepts traffic', { skip }, async () => {
  const dir = tmp();
  runChild(dir); // create a database with WAL/SHM, then loosen everything
  fs.chmodSync(dir, 0o755);
  for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o644);

  const port = 6200 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: dir, JWT_SECRET: 'test-only-secret-do-not-use-in-prod', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    assert.ok(await waitForServer(`http://127.0.0.1:${port}/api/public/dealer`), 'server should come up');
    assert.equal(octal(mode(dir)), '700');
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('unitnavigator.db')) assert.equal(octal(mode(path.join(dir, f))), '600', f);
    }
  } finally {
    child.kill();
  }
});

test('the server refuses to start, and never listens, when a database file cannot be made private', { skip }, async () => {
  const dir = tmp();
  const target = path.join(dir, 'elsewhere');
  fs.writeFileSync(target, 'x');
  fs.symlinkSync(target, path.join(dir, 'unitnavigator.db-journal'));

  const port = 6600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: dir, JWT_SECRET: 'test-only-secret-do-not-use-in-prod', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const exitCode = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 10000);
    child.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.notEqual(exitCode, 'timeout', 'the process must exit rather than keep running');
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /Data directory security check failed/);
  let listening = true;
  try { await fetch(`http://127.0.0.1:${port}/api/public/dealer`); } catch { listening = false; }
  assert.equal(listening, false, 'nothing may be listening');
});
