'use strict';
// Dedicated tests for scripts/lib/isolatedDataDir.js — the safety gate that
// every integration-test script relies on. Particular focus on the
// symlink/canonical-path gap: a lexical path.resolve() alone cannot detect
// that a directory is a symlink pointing at something forbidden.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { requireIsolatedDataDir, IsolatedDataDirError, REPO_ROOT } = require('../scripts/lib/isolatedDataDir');

function mktempTestDir(prefix = 'unitnav-esign-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('accepts a safe, real, properly-named mktemp directory and returns its canonical path', () => {
  const dir = mktempTestDir();
  try {
    const result = requireIsolatedDataDir(dir);
    // Must equal the *canonical* (realpath'd) form, which can differ from
    // the lexical input on systems where the temp root itself is a symlink
    // (e.g. macOS: /tmp -> /private/tmp, /var -> /private/var).
    const expectedCanonical = (fs.realpathSync.native || fs.realpathSync)(dir);
    assert.equal(result, expectedCanonical);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses when UNITNAV_DATA_DIR is unset', () => {
  assert.throws(() => requireIsolatedDataDir(undefined), IsolatedDataDirError);
  assert.throws(() => requireIsolatedDataDir(''), IsolatedDataDirError);
  assert.throws(() => requireIsolatedDataDir('   '), IsolatedDataDirError);
});

test('refuses a path that does not exist', () => {
  const missing = path.join(os.tmpdir(), `unitnav-esign-test-does-not-exist-${Date.now()}`);
  assert.ok(!fs.existsSync(missing));
  assert.throws(() => requireIsolatedDataDir(missing), err => {
    assert.ok(err instanceof IsolatedDataDirError);
    assert.match(err.message, /does not exist/);
    return true;
  });
});

test('refuses an existing regular file (not a directory)', () => {
  const filePath = path.join(os.tmpdir(), `unitnav-esign-test-file-${Date.now()}`);
  fs.writeFileSync(filePath, 'not a directory');
  try {
    assert.throws(() => requireIsolatedDataDir(filePath), err => {
      assert.ok(err instanceof IsolatedDataDirError);
      assert.match(err.message, /not a directory/);
      return true;
    });
  } finally {
    fs.unlinkSync(filePath);
  }
});

test('refuses a symlink whose target is the repository root', () => {
  const linkPath = path.join(os.tmpdir(), `unitnav-esign-test-symlink-reporoot-${Date.now()}`);
  fs.symlinkSync(REPO_ROOT, linkPath, 'dir');
  try {
    assert.throws(() => requireIsolatedDataDir(linkPath), err => {
      assert.ok(err instanceof IsolatedDataDirError);
      assert.match(err.message, /symbolic link/i);
      return true;
    });
  } finally {
    fs.unlinkSync(linkPath);
  }
});

test('refuses a symlink whose target is the repository\'s data/ directory', () => {
  const repoDataDir = path.join(REPO_ROOT, 'data');
  assert.ok(fs.existsSync(repoDataDir), 'sanity: repo data/ directory must exist for this test to be meaningful');
  const linkPath = path.join(os.tmpdir(), `unitnav-esign-test-symlink-repodata-${Date.now()}`);
  fs.symlinkSync(repoDataDir, linkPath, 'dir');
  try {
    assert.throws(() => requireIsolatedDataDir(linkPath), err => {
      assert.ok(err instanceof IsolatedDataDirError);
      assert.match(err.message, /symbolic link/i);
      return true;
    });
  } finally {
    fs.unlinkSync(linkPath);
  }
});

test('refuses a symlink whose target is a forbidden directory (home directory, or /var/www/unitnavigator when present)', () => {
  // /var/www/unitnavigator won't exist on a typical dev machine; the home
  // directory is a reliable stand-in representative forbidden directory
  // that's guaranteed to exist and be banned by the same code path.
  const home = os.homedir();
  assert.ok(home && fs.existsSync(home));
  const linkPath = path.join(os.tmpdir(), `unitnav-esign-test-symlink-home-${Date.now()}`);
  fs.symlinkSync(home, linkPath, 'dir');
  try {
    assert.throws(() => requireIsolatedDataDir(linkPath), IsolatedDataDirError);
  } finally {
    fs.unlinkSync(linkPath);
  }

  // Best-effort, non-blocking: if /var/www/unitnavigator genuinely exists on
  // this machine, also prove the symlink-to-production-dir case directly.
  const prodDir = '/var/www/unitnavigator';
  if (fs.existsSync(prodDir)) {
    const prodLinkPath = path.join(os.tmpdir(), `unitnav-esign-test-symlink-proddir-${Date.now()}`);
    fs.symlinkSync(prodDir, prodLinkPath, 'dir');
    try {
      assert.throws(() => requireIsolatedDataDir(prodLinkPath), err => {
        assert.ok(err instanceof IsolatedDataDirError);
        assert.match(err.message, /symbolic link/i);
        return true;
      });
    } finally {
      fs.unlinkSync(prodLinkPath);
    }
  } else {
    console.log('[isolated-data-dir.test.js] /var/www/unitnavigator not present on this machine — skipped the direct production-dir symlink case (covered by the home-dir case above via the same code path).');
  }
});

test('never creates, deletes, or modifies anything — only reads', () => {
  // Regression guard: requireIsolatedDataDir must never call mkdirSync,
  // rmSync, writeFileSync, or any mutating fs call — it only ever reads.
  // Scoped to the directory being validated itself (not the shared OS temp
  // root, which other processes and concurrently-running test files also
  // touch — counting entries there is inherently flaky and proves nothing
  // about this function specifically).
  const dir = mktempTestDir();
  const markerPath = path.join(dir, 'marker.txt');
  fs.writeFileSync(markerPath, 'unchanged');
  const before = fs.readdirSync(dir).sort();
  try {
    requireIsolatedDataDir(dir);
  } finally {
    const after = fs.readdirSync(dir).sort();
    assert.deepEqual(after, before, 'requireIsolatedDataDir must not create, delete, or modify anything inside the directory it validates');
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'unchanged');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a directory under the temp root with a name that does not match the required convention', () => {
  const dir = mktempTestDir('unitnav-wrong-name-');
  try {
    assert.throws(() => requireIsolatedDataDir(dir), err => {
      assert.ok(err instanceof IsolatedDataDirError);
      assert.match(err.message, /leaf directory name/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a directory not under the OS temp root, even with the right name and outside the repo', () => {
  // The home directory is guaranteed to exist and to be outside both the
  // repo and (on most systems) the temp root.
  const home = os.homedir();
  const tmpRoot = (fs.realpathSync.native || fs.realpathSync)(os.tmpdir());
  const homeCanonical = (fs.realpathSync.native || fs.realpathSync)(home);
  if (homeCanonical === tmpRoot || homeCanonical.startsWith(tmpRoot + path.sep)) {
    console.log('[isolated-data-dir.test.js] home directory happens to be under the temp root on this machine — skipping (environment-specific, not meaningful here).');
    return;
  }
  const dir = fs.mkdtempSync(path.join(home, 'unitnav-esign-test-'));
  try {
    assert.throws(() => requireIsolatedDataDir(dir), err => {
      assert.ok(err instanceof IsolatedDataDirError);
      assert.match(err.message, /temp directory|home directory/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
