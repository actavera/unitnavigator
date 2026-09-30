'use strict';
// Dedicated tests for scripts/preflight-esign.js: the http(s)-only URL
// restriction and the JWT_SECRET check.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { parseHttpUrl, runPreflightChecks } = require('../scripts/preflight-esign');

test('parseHttpUrl accepts only http/https', () => {
  assert.equal(parseHttpUrl('http://example.com').ok, true);
  assert.equal(parseHttpUrl('https://example.com').ok, true);

  for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'ws://example.com', 'javascript:alert(1)', 'not a url at all']) {
    const result = parseHttpUrl(bad);
    assert.equal(result.ok, false, `expected ${bad} to be rejected`);
  }
});

function mktempTestDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-esign-test-'));
}

function findResult(results, labelPattern) {
  return results.find(r => labelPattern.test(r.label));
}

// database.js (and routes/paperwork.js, which captures db.dataDir at its own
// module-load time) cache the data directory at first require — so without
// clearing the cache before every call, every test after the first would
// silently write into the FIRST test's directory instead of its own,
// regardless of which `dir` it thinks it's validating. That's not just
// inaccurate: a later test's writability check can call
// fs.mkdirSync(path.join(db.dataDir, 'esign-archives'), { recursive: true })
// against a directory an EARLIER test's cleanup already deleted, silently
// resurrecting an orphaned directory outside every test's own cleanup.
// Clearing the cache before each call keeps db.dataDir aligned with the
// `dir` this specific test owns and cleans up.
function freshRequireDatabase() {
  delete require.cache[require.resolve('../database')];
  delete require.cache[require.resolve('../routes/paperwork')];
}

test('fails overall, and flags DOCUSEAL_BASE_URL specifically, when given a file: URL', () => {
  const dir = mktempTestDir();
  try {
    freshRequireDatabase();
    const outcome = runPreflightChecks({
      dataDir: dir,
      env: {
        DOCUSEAL_API_KEY: 'fake',
        DOCUSEAL_BASE_URL: 'file:///etc/passwd',
        STIRLING_PDF_URL: 'http://127.0.0.1:8085',
        JWT_SECRET: 'fake-secret',
      },
    });
    assert.equal(outcome.allOk, false);
    const docusealResult = findResult(outcome.results, /DOCUSEAL_BASE_URL/);
    assert.equal(docusealResult.ok, false);
    assert.match(docusealResult.detail, /http\/https/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fails overall, and flags STIRLING_PDF_URL specifically, when given an ftp: URL', () => {
  const dir = mktempTestDir();
  try {
    freshRequireDatabase();
    const outcome = runPreflightChecks({
      dataDir: dir,
      env: {
        DOCUSEAL_API_KEY: 'fake',
        STIRLING_PDF_URL: 'ftp://example.com/x',
        JWT_SECRET: 'fake-secret',
      },
    });
    assert.equal(outcome.allOk, false);
    const stirlingResult = findResult(outcome.results, /STIRLING_PDF_URL/);
    assert.equal(stirlingResult.ok, false);
    assert.match(stirlingResult.detail, /http\/https/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fails overall when JWT_SECRET is missing, and never includes its value when present', () => {
  const dir = mktempTestDir();
  try {
    freshRequireDatabase();
    const withoutSecret = runPreflightChecks({
      dataDir: dir,
      env: { DOCUSEAL_API_KEY: 'fake', STIRLING_PDF_URL: 'http://127.0.0.1:8085' },
    });
    assert.equal(withoutSecret.allOk, false);
    const jwtResultMissing = findResult(withoutSecret.results, /JWT_SECRET/);
    assert.equal(jwtResultMissing.ok, false);
    assert.match(jwtResultMissing.detail, /missing/);

    const withSecret = runPreflightChecks({
      dataDir: dir,
      env: {
        DOCUSEAL_API_KEY: 'fake',
        STIRLING_PDF_URL: 'http://127.0.0.1:8085',
        JWT_SECRET: 'a-very-secret-value-that-must-never-appear-in-output',
      },
    });
    const jwtResultSet = findResult(withSecret.results, /JWT_SECRET/);
    assert.equal(jwtResultSet.ok, true);
    const wholeOutput = JSON.stringify(withSecret.results);
    assert.ok(!wholeOutput.includes('a-very-secret-value-that-must-never-appear-in-output'), 'the JWT_SECRET value must never appear anywhere in the report');
    assert.equal(withSecret.allOk, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('never includes the DOCUSEAL_API_KEY value in the report', () => {
  const dir = mktempTestDir();
  try {
    freshRequireDatabase();
    const outcome = runPreflightChecks({
      dataDir: dir,
      env: {
        DOCUSEAL_API_KEY: 'super-secret-docuseal-key-value',
        STIRLING_PDF_URL: 'http://127.0.0.1:8085',
        JWT_SECRET: 'fake-secret',
      },
    });
    const wholeOutput = JSON.stringify(outcome.results);
    assert.ok(!wholeOutput.includes('super-secret-docuseal-key-value'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('all checks pass with fully valid http(s) config and JWT_SECRET set', () => {
  const dir = mktempTestDir();
  try {
    freshRequireDatabase();
    const outcome = runPreflightChecks({
      dataDir: dir,
      env: {
        DOCUSEAL_API_KEY: 'fake',
        DOCUSEAL_BASE_URL: 'https://api.docuseal.com',
        STIRLING_PDF_URL: 'http://127.0.0.1:8085',
        JWT_SECRET: 'fake-secret',
      },
    });
    assert.equal(outcome.allOk, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    freshRequireDatabase();
  }
});

// runPreflightChecks() installs the validated path into the REAL
// process.env.UNITNAV_DATA_DIR for the duration of the call (database.js
// reads it from there, not from the `env` option, which only feeds the
// DOCUSEAL_*/STIRLING_*/JWT_SECRET checks). That's a real mutation of a
// process-wide global a programmatic caller doesn't expect to outlive the
// call — especially since the directory it names may be deleted by the
// caller immediately after, as every test in this file does in its own
// `finally`. These four tests prove it's always restored: with an existing
// prior value or none at all, on success or on a thrown mid-flight failure.
function withSavedRealEnvDataDir(fn) {
  const saved = process.env.UNITNAV_DATA_DIR;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.UNITNAV_DATA_DIR;
    else process.env.UNITNAV_DATA_DIR = saved;
  }
}

test('restores an existing prior process.env.UNITNAV_DATA_DIR after a successful call', () => {
  withSavedRealEnvDataDir(() => {
    const priorValue = '/some/prior/value/not-validated-on-purpose';
    process.env.UNITNAV_DATA_DIR = priorValue;

    const dir = mktempTestDir();
    try {
      freshRequireDatabase();
      const outcome = runPreflightChecks({
        dataDir: dir,
        env: { DOCUSEAL_API_KEY: 'fake', STIRLING_PDF_URL: 'http://127.0.0.1:8085', JWT_SECRET: 'x' },
      });
      assert.equal(outcome.allOk, true);
      assert.equal(process.env.UNITNAV_DATA_DIR, priorValue, 'the prior value must be restored after a successful call');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      freshRequireDatabase();
    }
  });
});

test('leaves process.env.UNITNAV_DATA_DIR unset after a successful call, if it was unset before', () => {
  withSavedRealEnvDataDir(() => {
    delete process.env.UNITNAV_DATA_DIR;

    const dir = mktempTestDir();
    try {
      freshRequireDatabase();
      const outcome = runPreflightChecks({
        dataDir: dir,
        env: { DOCUSEAL_API_KEY: 'fake', STIRLING_PDF_URL: 'http://127.0.0.1:8085', JWT_SECRET: 'x' },
      });
      assert.equal(outcome.allOk, true);
      assert.equal(process.env.UNITNAV_DATA_DIR, undefined, 'must remain unset after a successful call, not resurrected with the test directory');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      freshRequireDatabase();
    }
  });
});

test('restores an existing prior process.env.UNITNAV_DATA_DIR even when a check throws mid-flight', () => {
  withSavedRealEnvDataDir(() => {
    const priorValue = '/some/other/prior/value';
    process.env.UNITNAV_DATA_DIR = priorValue;

    const dir = mktempTestDir();
    try {
      freshRequireDatabase();
      assert.throws(() => runPreflightChecks({
        dataDir: dir,
        env: { DOCUSEAL_API_KEY: 'fake', STIRLING_PDF_URL: 'http://127.0.0.1:8085', JWT_SECRET: 'x' },
        _injectFailure: () => { throw new Error('simulated mid-flight failure'); },
      }), /simulated mid-flight failure/);
      assert.equal(process.env.UNITNAV_DATA_DIR, priorValue, 'the prior value must be restored even though the call threw');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      freshRequireDatabase();
    }
  });
});

test('leaves process.env.UNITNAV_DATA_DIR unset after a thrown mid-flight failure, if it was unset before', () => {
  withSavedRealEnvDataDir(() => {
    delete process.env.UNITNAV_DATA_DIR;

    const dir = mktempTestDir();
    try {
      freshRequireDatabase();
      assert.throws(() => runPreflightChecks({
        dataDir: dir,
        env: { DOCUSEAL_API_KEY: 'fake', STIRLING_PDF_URL: 'http://127.0.0.1:8085', JWT_SECRET: 'x' },
        _injectFailure: () => { throw new Error('simulated mid-flight failure'); },
      }), /simulated mid-flight failure/);
      assert.equal(process.env.UNITNAV_DATA_DIR, undefined, 'must remain unset even though the call threw, not left pointing at a directory this test is about to delete');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      freshRequireDatabase();
    }
  });
});
