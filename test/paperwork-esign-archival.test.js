'use strict';
// Covers archiveDocusealSubmission's all-or-nothing archival guarantee and
// its use of safeFetch for DocuSeal's temporary document/audit-log URLs.
//
// These run IN-PROCESS (not through the spawned server + HTTP) because
// combined_document_url/audit_log_url are now routed through safeFetch,
// which correctly refuses to fetch a private address — and any server this
// test suite can stand up locally is necessarily on one (127.0.0.1). That's
// exactly the protection under test in safe-fetch-ssrf.test.js, so rather
// than fight it, the success/failure-mode tests inject a `download`
// function (archiveDocusealSubmission's documented override point) to
// control the downloaded bytes directly, and a separate test proves the
// REAL default `downloadProviderFile` genuinely refuses a private-looking
// provider URL, closing the loop.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('node:http');

const REPO_ROOT = path.join(__dirname, '..');

let tmpDataDir;
let statusServer;
let statusPort;
let nextStatusBody;
let paperwork;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-esign-archival-'));
  process.env.UNITNAV_DATA_DIR = tmpDataDir;
  process.env.DOCUSEAL_API_KEY = 'test-key';

  // A minimal DocuSeal status-check mock. This is our own configured
  // endpoint (DOCUSEAL_BASE_URL), so docusealSubmissionStatus's plain fetch
  // to it is fine — it's the *document/audit* URLs returned inside the body
  // that are provider-supplied and go through safeFetch.
  statusServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(nextStatusBody || { status: 'pending' }));
  });
  statusPort = await listen(statusServer);
  process.env.DOCUSEAL_BASE_URL = `http://127.0.0.1:${statusPort}`;

  delete require.cache[require.resolve('../database')];
  delete require.cache[require.resolve('../routes/paperwork')];
  paperwork = require('../routes/paperwork');
});

test.after(() => {
  statusServer.close();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.UNITNAV_DATA_DIR;
  delete process.env.DOCUSEAL_API_KEY;
  delete process.env.DOCUSEAL_BASE_URL;
});

function archiveDir() {
  return path.join(tmpDataDir, 'esign-archives');
}

function listArchiveFiles() {
  try {
    return fs.readdirSync(archiveDir());
  } catch {
    return [];
  }
}

let submissionCounter = 0;
function nextId() {
  submissionCounter += 1;
  return `sub-${submissionCounter}`;
}

test('archives both the signed document and audit log, all-or-nothing, on success', async () => {
  const id = nextId();
  const dealershipId = 111;
  nextStatusBody = {
    status: 'completed',
    completed_at: '2026-09-26T00:00:00Z',
    combined_document_url: 'https://provider.example/doc',
    audit_log_url: 'https://provider.example/audit',
  };

  const download = async url => {
    if (url === 'https://provider.example/doc') return Buffer.from('SIGNED-DOC-BYTES');
    if (url === 'https://provider.example/audit') return Buffer.from('AUDIT-LOG-BYTES');
    throw new Error(`unexpected url ${url}`);
  };

  const before = listArchiveFiles().length;
  const result = await paperwork.archiveDocusealSubmission(id, dealershipId, { download });
  assert.ok(result.archivePath);
  assert.ok(result.auditLogPath);

  const docFile = path.join(archiveDir(), path.basename(result.archivePath));
  const auditFile = path.join(archiveDir(), path.basename(result.auditLogPath));
  assert.equal(fs.readFileSync(docFile, 'utf8'), 'SIGNED-DOC-BYTES');
  assert.equal(fs.readFileSync(auditFile, 'utf8'), 'AUDIT-LOG-BYTES');
  assert.equal(listArchiveFiles().length, before + 2, 'exactly the two final files must exist, no temp files left behind');
  assert.ok(listArchiveFiles().every(f => !f.includes('.tmp-')), 'no temp files must survive a successful archive');
});

test('document download failure: nothing is archived, including no partial audit file', async () => {
  const id = nextId();
  const dealershipId = 222;
  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/doc-fails',
    audit_log_url: 'https://provider.example/audit-ok',
  };
  let auditWasFetched = false;
  const download = async url => {
    if (url === 'https://provider.example/doc-fails') throw new Error('simulated document download failure');
    auditWasFetched = true;
    return Buffer.from('should never be written');
  };

  const before = listArchiveFiles().length;
  await assert.rejects(() => paperwork.archiveDocusealSubmission(id, dealershipId, { download }), /simulated document download failure/);
  // The document download is attempted first and rejects immediately, so the
  // audit URL is never even requested.
  assert.equal(auditWasFetched, false);
  assert.equal(listArchiveFiles().length, before, 'no files of any kind must be written when the document download fails');
});

test('audit download failure: the document is not left behind as a partial archive', async () => {
  const id = nextId();
  const dealershipId = 333;
  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/doc-ok',
    audit_log_url: 'https://provider.example/audit-fails',
  };
  const download = async url => {
    if (url === 'https://provider.example/doc-ok') return Buffer.from('SIGNED-DOC-BYTES-2');
    throw new Error('simulated audit download failure');
  };

  const before = listArchiveFiles().length;
  await assert.rejects(() => paperwork.archiveDocusealSubmission(id, dealershipId, { download }), /simulated audit download failure/);
  assert.equal(listArchiveFiles().length, before, 'the successfully-downloaded document must not be left behind when the audit log fails');
});

test('a "completed" status missing either URL is a retryable error and downloads nothing', async () => {
  const id = nextId();
  const dealershipId = 444;
  nextStatusBody = { status: 'completed', combined_document_url: 'https://provider.example/doc-only' };
  let downloadCalled = false;
  const download = async () => { downloadCalled = true; return Buffer.from('x'); };

  await assert.rejects(
    () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
    err => {
      assert.match(err.message, /did not return both/);
      assert.equal(err.statusCode, 502);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(downloadCalled, false, 'must not attempt any download when a required URL is missing');
});

test('a filesystem write failure rolls back cleanly and leaves no partial archive', async () => {
  const id = nextId();
  const dealershipId = 555;
  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/doc-fs',
    audit_log_url: 'https://provider.example/audit-fs',
  };
  const download = async url => Buffer.from(url === 'https://provider.example/doc-fs' ? 'DOC' : 'AUDIT');

  fs.mkdirSync(archiveDir(), { recursive: true });
  const before = listArchiveFiles();
  fs.chmodSync(archiveDir(), 0o500); // read+execute only: writes must fail
  try {
    await assert.rejects(
      () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
      err => {
        assert.match(err.message, /Could not write the signed document\/audit log archive/);
        assert.equal(err.retryable, true);
        return true;
      },
    );
  } finally {
    fs.chmodSync(archiveDir(), 0o700);
  }
  assert.deepEqual(listArchiveFiles().sort(), before.sort(), 'no new files (partial or otherwise) must exist after a write failure');
});

test('a still-pending submission is not archived and is not an error', async () => {
  const id = nextId();
  nextStatusBody = { status: 'pending' };
  const result = await paperwork.archiveDocusealSubmission(id, 666);
  assert.equal(result.archivePath, undefined);
  assert.equal(result.submission.status, 'pending');
});

test('the real default download path refuses a provider URL that points at a private/reserved address (SSRF guard is actually wired in)', async () => {
  const id = nextId();
  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'http://169.254.169.254/latest/meta-data/', // cloud metadata endpoint
    audit_log_url: 'https://provider.example/audit',
  };
  // No `download` override here — this exercises the REAL downloadProviderFile,
  // which must route through safeFetch and refuse the request before ever
  // attempting a connection.
  await assert.rejects(
    () => paperwork.archiveDocusealSubmission(id, 777),
    /not allowed|private or reserved/,
  );
});

// Mirrors the production filename convention exactly, so tests can pre-seed
// or inspect the exact final paths archiveDocusealSubmission will use.
function finalPaths(submissionId, dealershipId) {
  const safeId = String(submissionId).replace(/[^a-z0-9_-]+/gi, '-');
  return {
    docFinalPath: path.join(archiveDir(), `${dealershipId}-${safeId}.pdf`),
    auditFinalPath: path.join(archiveDir(), `${dealershipId}-${safeId}-audit.pdf`),
  };
}

function tempFileCount() {
  return listArchiveFiles().filter(f => f.includes('.tmp-')).length;
}

test('both final files already exist: idempotent return, zero provider downloads, byte-for-byte unchanged', async () => {
  const id = nextId();
  const dealershipId = 888;
  const { docFinalPath, auditFinalPath } = finalPaths(id, dealershipId);
  fs.mkdirSync(archiveDir(), { recursive: true });
  fs.writeFileSync(docFinalPath, 'ORIGINAL-DOC');
  fs.writeFileSync(auditFinalPath, 'ORIGINAL-AUDIT');

  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/doc-idempotent',
    audit_log_url: 'https://provider.example/audit-idempotent',
  };
  let downloadCount = 0;
  const trapDownload = async () => { downloadCount += 1; return Buffer.from('SHOULD-NEVER-BE-WRITTEN'); };

  const result = await paperwork.archiveDocusealSubmission(id, dealershipId, { download: trapDownload });

  assert.equal(downloadCount, 0, 'must not download anything when both final files already exist');
  assert.equal(path.basename(result.archivePath), path.basename(docFinalPath));
  assert.equal(path.basename(result.auditLogPath), path.basename(auditFinalPath));
  assert.equal(fs.readFileSync(docFinalPath, 'utf8'), 'ORIGINAL-DOC', 'document must be byte-for-byte unchanged');
  assert.equal(fs.readFileSync(auditFinalPath, 'utf8'), 'ORIGINAL-AUDIT', 'audit log must be byte-for-byte unchanged');
  assert.equal(tempFileCount(), 0);

  // And calling it again is just as inert.
  const result2 = await paperwork.archiveDocusealSubmission(id, dealershipId, { download: trapDownload });
  assert.equal(downloadCount, 0);
  assert.deepEqual(result2, result);
});

test('document-only pre-existing: fails before any download and preserves the document byte-for-byte', async () => {
  const id = nextId();
  const dealershipId = 901;
  const { docFinalPath, auditFinalPath } = finalPaths(id, dealershipId);
  fs.mkdirSync(archiveDir(), { recursive: true });
  fs.writeFileSync(docFinalPath, 'PRE-EXISTING-DOC-ONLY');
  assert.ok(!fs.existsSync(auditFinalPath));

  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/doc-x',
    audit_log_url: 'https://provider.example/audit-x',
  };
  let downloadCalled = false;
  const download = async () => { downloadCalled = true; return Buffer.from('SHOULD-NEVER-BE-WRITTEN'); };

  await assert.rejects(
    () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
    err => {
      assert.match(err.message, /inconsistent partial archive/);
      assert.equal(err.statusCode, 409);
      assert.equal(err.retryable, false);
      assert.equal(err.needsManualRecovery, true);
      return true;
    },
  );
  assert.equal(downloadCalled, false, 'must not attempt any download for an inconsistent partial archive');
  assert.equal(fs.readFileSync(docFinalPath, 'utf8'), 'PRE-EXISTING-DOC-ONLY', 'the pre-existing document must remain exactly unchanged — not the old content by coincidence, but because nothing touched it');
  assert.ok(!fs.existsSync(auditFinalPath), 'no audit file must have been created');
  assert.equal(tempFileCount(), 0);
});

test('audit-only pre-existing: fails before any download and preserves the audit file byte-for-byte', async () => {
  const id = nextId();
  const dealershipId = 902;
  const { docFinalPath, auditFinalPath } = finalPaths(id, dealershipId);
  fs.mkdirSync(archiveDir(), { recursive: true });
  fs.writeFileSync(auditFinalPath, 'PRE-EXISTING-AUDIT-ONLY');
  assert.ok(!fs.existsSync(docFinalPath));

  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/doc-y',
    audit_log_url: 'https://provider.example/audit-y',
  };
  let downloadCalled = false;
  const download = async () => { downloadCalled = true; return Buffer.from('SHOULD-NEVER-BE-WRITTEN'); };

  await assert.rejects(
    () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
    err => {
      assert.match(err.message, /inconsistent partial archive/);
      assert.equal(err.statusCode, 409);
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(downloadCalled, false, 'must not attempt any download for an inconsistent partial archive');
  assert.equal(fs.readFileSync(auditFinalPath, 'utf8'), 'PRE-EXISTING-AUDIT-ONLY', 'the pre-existing audit log must remain exactly unchanged');
  assert.ok(!fs.existsSync(docFinalPath), 'no document file must have been created');
  assert.equal(tempFileCount(), 0);
});

test('first-time archival, audit finalization failure: neither final file remains and no temp files remain', async () => {
  const id = nextId();
  const dealershipId = 903;
  const { docFinalPath, auditFinalPath } = finalPaths(id, dealershipId);
  fs.mkdirSync(archiveDir(), { recursive: true });
  assert.ok(!fs.existsSync(docFinalPath) && !fs.existsSync(auditFinalPath), 'neither file exists at the start — this is a first-time archive');

  // Force the audit *finalization* (fs.linkSync) to fail without needing its
  // download to fail: a directory sitting at the audit's final path makes
  // linkSync(tempFile, thatPath) fail (EEXIST/EISDIR-equivalent), exactly
  // like a real filesystem collision would.
  fs.mkdirSync(auditFinalPath);

  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/doc-z',
    audit_log_url: 'https://provider.example/audit-z',
  };
  const download = async url => Buffer.from(url.includes('doc') ? 'FRESHLY-DOWNLOADED-DOCUMENT' : 'FRESHLY-DOWNLOADED-AUDIT');

  await assert.rejects(
    () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
    err => {
      assert.match(err.message, /Could not write the signed document\/audit log archive/);
      assert.equal(err.retryable, true);
      return true;
    },
  );

  assert.ok(!fs.existsSync(docFinalPath), 'the document must have been rolled back since it was this attempt\'s own first-time creation and audit finalization failed');
  // The directory fixture at auditFinalPath is the test's own setup, not
  // something the code created — it's expected to remain (untouched by us).
  assert.ok(fs.statSync(auditFinalPath).isDirectory());
  assert.equal(tempFileCount(), 0, 'no temp files must survive');
});

test('a no-clobber collision at finalization time cannot overwrite an existing final file', async () => {
  const id = nextId();
  const dealershipId = 904;
  const { docFinalPath, auditFinalPath } = finalPaths(id, dealershipId);
  fs.mkdirSync(archiveDir(), { recursive: true });
  assert.ok(!fs.existsSync(docFinalPath) && !fs.existsSync(auditFinalPath), 'neither file exists when this attempt starts — passes the upfront check');

  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/doc-race',
    audit_log_url: 'https://provider.example/audit-race',
  };
  // Simulate another process/attempt winning a race and creating the audit
  // final file *after* our upfront check but *before* our own finalization
  // — by having our own download callback (which runs after that check)
  // create it as a side effect.
  const download = async url => {
    if (url.includes('audit')) {
      fs.writeFileSync(auditFinalPath, 'COLLISION-WINNER-CONTENT');
    }
    return Buffer.from(url.includes('doc') ? 'OUR-DOWNLOADED-DOCUMENT' : 'OUR-DOWNLOADED-AUDIT');
  };

  await assert.rejects(
    () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
    /Could not write the signed document\/audit log archive/,
  );

  assert.equal(fs.readFileSync(auditFinalPath, 'utf8'), 'COLLISION-WINNER-CONTENT', 'the no-clobber link must not have overwritten the file that won the race');
  assert.ok(!fs.existsSync(docFinalPath), 'the document (this attempt\'s own first-time creation) must be rolled back since audit finalization failed');
  assert.equal(tempFileCount(), 0, 'no temp files must survive');
});

// Real single-document DocuSeal "completed" response shape (observed on
// submission 11714958): no combined_document_url, but exactly one document
// whose own .url is the signed PDF.
test('a real single-document response (no combined_document_url, one documents[].url) archives via that document URL', async () => {
  const id = nextId();
  const dealershipId = 1001;
  nextStatusBody = {
    status: 'completed',
    audit_log_url: 'https://provider.example/audit-single-doc',
    documents: [{ name: 'packet.pdf', url: 'https://provider.example/single-doc' }],
  };
  const download = async url => {
    if (url === 'https://provider.example/single-doc') return Buffer.from('SINGLE-DOC-BYTES');
    if (url === 'https://provider.example/audit-single-doc') return Buffer.from('SINGLE-DOC-AUDIT-BYTES');
    throw new Error(`unexpected url ${url}`);
  };

  const result = await paperwork.archiveDocusealSubmission(id, dealershipId, { download });
  assert.ok(result.archivePath);
  assert.ok(result.auditLogPath);
  const docFile = path.join(archiveDir(), path.basename(result.archivePath));
  const auditFile = path.join(archiveDir(), path.basename(result.auditLogPath));
  assert.equal(fs.readFileSync(docFile, 'utf8'), 'SINGLE-DOC-BYTES');
  assert.equal(fs.readFileSync(auditFile, 'utf8'), 'SINGLE-DOC-AUDIT-BYTES');
});

test('existing combined_document_url-only behavior is unchanged', async () => {
  const id = nextId();
  const dealershipId = 1002;
  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/combined-only',
    audit_log_url: 'https://provider.example/audit-combined-only',
  };
  const download = async url => {
    if (url === 'https://provider.example/combined-only') return Buffer.from('COMBINED-ONLY-BYTES');
    if (url === 'https://provider.example/audit-combined-only') return Buffer.from('COMBINED-ONLY-AUDIT-BYTES');
    throw new Error(`unexpected url ${url}`);
  };

  const result = await paperwork.archiveDocusealSubmission(id, dealershipId, { download });
  const docFile = path.join(archiveDir(), path.basename(result.archivePath));
  assert.equal(fs.readFileSync(docFile, 'utf8'), 'COMBINED-ONLY-BYTES');
});

test('combined_document_url is preferred over documents[].url when both are present', async () => {
  const id = nextId();
  const dealershipId = 1003;
  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/preferred-combined',
    audit_log_url: 'https://provider.example/audit-both-present',
    documents: [{ name: 'packet.pdf', url: 'https://provider.example/should-not-be-used' }],
  };
  const download = async url => {
    if (url === 'https://provider.example/preferred-combined') return Buffer.from('PREFERRED-COMBINED-BYTES');
    if (url === 'https://provider.example/audit-both-present') return Buffer.from('BOTH-PRESENT-AUDIT-BYTES');
    throw new Error(`unexpected url ${url} — must prefer combined_document_url over documents[].url`);
  };

  const result = await paperwork.archiveDocusealSubmission(id, dealershipId, { download });
  const docFile = path.join(archiveDir(), path.basename(result.archivePath));
  assert.equal(fs.readFileSync(docFile, 'utf8'), 'PREFERRED-COMBINED-BYTES');
});

test('empty/missing documents array with no combined_document_url is rejected as retryable, downloading nothing', async () => {
  const id = nextId();
  const dealershipId = 1004;
  nextStatusBody = {
    status: 'completed',
    audit_log_url: 'https://provider.example/audit-empty-docs',
    documents: [],
  };
  let downloadCalled = false;
  const download = async () => { downloadCalled = true; return Buffer.from('x'); };

  await assert.rejects(
    () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
    err => {
      assert.match(err.message, /did not return both/);
      assert.equal(err.statusCode, 502);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(downloadCalled, false);
});

test('multiple documents with no combined_document_url is rejected as retryable — never guesses which one to archive', async () => {
  const id = nextId();
  const dealershipId = 1005;
  nextStatusBody = {
    status: 'completed',
    audit_log_url: 'https://provider.example/audit-multi-docs',
    documents: [
      { name: 'a.pdf', url: 'https://provider.example/doc-a' },
      { name: 'b.pdf', url: 'https://provider.example/doc-b' },
    ],
  };
  let downloadCalled = false;
  const download = async () => { downloadCalled = true; return Buffer.from('x'); };

  await assert.rejects(
    () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
    err => {
      assert.match(err.message, /did not return both/);
      assert.equal(err.statusCode, 502);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(downloadCalled, false, 'must never guess which of multiple documents is the signed packet');
});

test('two documents where only one has a usable HTTP(S) URL is still rejected as retryable — document count, not URL validity, governs', async () => {
  const id = nextId();
  const dealershipId = 1008;
  nextStatusBody = {
    status: 'completed',
    audit_log_url: 'https://provider.example/audit-two-docs-one-valid',
    documents: [
      { name: 'a.pdf', url: '' },
      { name: 'b.pdf', url: 'https://provider.example/doc-b-valid' },
    ],
  };
  let downloadCalled = false;
  const download = async () => { downloadCalled = true; return Buffer.from('x'); };

  await assert.rejects(
    () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
    err => {
      assert.match(err.message, /did not return both/);
      assert.equal(err.statusCode, 502);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(downloadCalled, false, 'must never guess even when only one of two documents has a usable URL — zero downloads or writes');
});

test('a single usable documents[].url but a missing audit_log_url is still rejected as retryable', async () => {
  const id = nextId();
  const dealershipId = 1006;
  nextStatusBody = {
    status: 'completed',
    documents: [{ name: 'packet.pdf', url: 'https://provider.example/doc-no-audit' }],
  };
  let downloadCalled = false;
  const download = async () => { downloadCalled = true; return Buffer.from('x'); };

  await assert.rejects(
    () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
    err => {
      assert.match(err.message, /did not return both/);
      assert.equal(err.statusCode, 502);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(downloadCalled, false, 'audit_log_url is still required regardless of the document-URL source');
});

test('archiving via documents[].url never persists the temporary provider URL anywhere in the result', async () => {
  const id = nextId();
  const dealershipId = 1007;
  const providerDocUrl = 'https://provider.example/temp-signing-doc-token-abc123';
  nextStatusBody = {
    status: 'completed',
    audit_log_url: 'https://provider.example/audit-no-persist',
    documents: [{ name: 'packet.pdf', url: providerDocUrl }],
  };
  const download = async url => Buffer.from(url.includes('audit') ? 'AUDIT-NO-PERSIST' : 'DOC-NO-PERSIST');

  const result = await paperwork.archiveDocusealSubmission(id, dealershipId, { download });
  const serialized = JSON.stringify({ archivePath: result.archivePath, auditLogPath: result.auditLogPath });
  assert.ok(!serialized.includes(providerDocUrl), 'the temporary provider document URL must never appear in the persisted result — only local archive paths');
});

test('a failure unlinking the audit temp file AFTER both final links succeeded does not leave an audit-only partial archive', async () => {
  // This is the specific gap being closed: fs.linkSync(auditTempPath,
  // auditFinalPath) succeeds (auditLinked = true), but the subsequent
  // fs.unlinkSync(auditTempPath) throws. Without an `auditLinked` ownership
  // flag, the old rollback only ever removed docFinalPath, leaving
  // auditFinalPath committed — an audit-only partial archive despite the
  // whole operation reporting failure.
  const id = nextId();
  const dealershipId = 905;
  const { docFinalPath, auditFinalPath } = finalPaths(id, dealershipId);
  fs.mkdirSync(archiveDir(), { recursive: true });
  assert.ok(!fs.existsSync(docFinalPath) && !fs.existsSync(auditFinalPath));

  // An unrelated, pre-existing file in the same directory that must survive
  // completely untouched by any cleanup this attempt performs.
  const unrelatedPath = path.join(archiveDir(), 'unrelated-file.txt');
  fs.writeFileSync(unrelatedPath, 'UNRELATED-CONTENT');

  nextStatusBody = {
    status: 'completed',
    combined_document_url: 'https://provider.example/doc-unlink-fail',
    audit_log_url: 'https://provider.example/audit-unlink-fail',
  };
  const download = async url => Buffer.from(url.includes('doc') ? 'DOC-BYTES' : 'AUDIT-BYTES');

  // Narrowly mock fs.unlinkSync to fail only for this attempt's own audit
  // temp file (whose exact name — including its random suffix — isn't known
  // until the call is made, so match by prefix), leaving every other
  // filesystem operation, including the real unlinkSync for anything else,
  // completely untouched. Restored in `finally` no matter what happens
  // below, including an assertion failure.
  const auditTempPrefix = `${auditFinalPath}.tmp-`;
  const originalUnlinkSync = fs.unlinkSync;
  let matchedAndFailed = false;
  fs.unlinkSync = function patchedUnlinkSync(targetPath, ...args) {
    if (typeof targetPath === 'string' && targetPath.startsWith(auditTempPrefix)) {
      matchedAndFailed = true;
      throw new Error('simulated failure unlinking the audit temp file');
    }
    return originalUnlinkSync.call(fs, targetPath, ...args);
  };

  try {
    await assert.rejects(
      () => paperwork.archiveDocusealSubmission(id, dealershipId, { download }),
      err => {
        assert.match(err.message, /Could not write the signed document\/audit log archive/);
        assert.equal(err.retryable, true);
        return true;
      },
    );

    assert.ok(matchedAndFailed, 'the mock must have actually intercepted the audit temp unlink — otherwise this test proves nothing');
    assert.ok(!fs.existsSync(docFinalPath), 'neither final file may remain: document must be rolled back');
    assert.ok(!fs.existsSync(auditFinalPath), 'neither final file may remain: audit must be rolled back even though its link succeeded before the unlink failed');
    // The audit temp file itself could not be removed by our own mocked
    // unlinkSync (that's the whole premise), so it's expected to remain —
    // cleanupArchiveFiles's failure there is silently best-effort. Confirm
    // nothing ELSE (particularly the doc temp file, which never had a
    // reason to fail) survives.
    const remaining = listArchiveFiles();
    assert.ok(!remaining.includes(path.basename(docFinalPath) + `.tmp-should-not-exist`), 'sanity: no unexpected doc temp naming');
    const docTempSurvivors = remaining.filter(f => f.startsWith(path.basename(docFinalPath) + '.tmp-'));
    assert.deepEqual(docTempSurvivors, [], 'the document temp file must have been cleaned up (its unlink was never mocked to fail)');
    assert.ok(fs.existsSync(unrelatedPath), 'an unrelated pre-existing file in the same directory must not be touched');
    assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'UNRELATED-CONTENT');
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
});
