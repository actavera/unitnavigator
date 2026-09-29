'use strict';
// Dedicated tests for scripts/cleanup-esign-test-dir.js: proves it deletes
// exactly a valid isolated test directory, and — critically — refuses a
// symlink and leaves its target completely untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLEANUP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'cleanup-esign-test-dir.js');

function runCleanup(dataDir) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLEANUP_SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, UNITNAV_DATA_DIR: dataDir },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

function mktempTestDir(prefix = 'unitnav-esign-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('deletes exactly a valid isolated test directory', async () => {
  const dir = mktempTestDir();
  fs.writeFileSync(path.join(dir, 'some-file.txt'), 'hello');
  const canonical = (fs.realpathSync.native || fs.realpathSync)(dir);

  const result = await runCleanup(dir);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!fs.existsSync(canonical), 'the directory must be gone after cleanup');
});

test('refuses a missing directory', async () => {
  const missing = path.join(os.tmpdir(), `unitnav-esign-test-missing-${Date.now()}`);
  const result = await runCleanup(missing);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not exist/);
});

test('refuses a symlink and leaves its target completely untouched', async () => {
  const realDir = mktempTestDir('unitnav-esign-test-cleanup-target-');
  const canaryFile = path.join(realDir, 'do-not-delete-me.txt');
  fs.writeFileSync(canaryFile, 'irreplaceable test data');
  const canonicalRealDir = (fs.realpathSync.native || fs.realpathSync)(realDir);

  const linkPath = path.join(os.tmpdir(), `unitnav-esign-test-symlink-${Date.now()}`);
  fs.symlinkSync(realDir, linkPath, 'dir');

  try {
    const result = await runCleanup(linkPath);
    assert.notEqual(result.code, 0, 'cleanup must refuse when pointed at a symlink');
    assert.match(result.stderr, /symbolic link/i);

    // The real target directory and its contents must be completely intact.
    assert.ok(fs.existsSync(canonicalRealDir), 'the symlink target directory must still exist');
    assert.ok(fs.existsSync(canaryFile), 'the file inside the symlink target must still exist');
    assert.equal(fs.readFileSync(canaryFile, 'utf8'), 'irreplaceable test data');
  } finally {
    fs.unlinkSync(linkPath);
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

test('refuses a path inside the repository', async () => {
  const result = await runCleanup(path.join(REPO_ROOT, 'data'));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /repository/i);
});

test('refuses an unset UNITNAV_DATA_DIR', async () => {
  const result = await new Promise(resolve => {
    const env = { ...process.env };
    delete env.UNITNAV_DATA_DIR;
    execFile(process.execPath, [CLEANUP_SCRIPT], { cwd: REPO_ROOT, env }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stderr });
    });
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /must be set explicitly/);
});
