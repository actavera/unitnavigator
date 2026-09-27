'use strict';
// Proves the provider-call timeout stays armed through full response-body
// consumption, not just until headers arrive. Each mock server here sends a
// 200 status immediately, then stalls the body forever — the old code
// (cancel() right after fetch() resolves) would hang indefinitely on that;
// the fix must still time out.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('node:http');
const { PDFDocument } = require('pdf-lib');

const REPO_ROOT = path.join(__dirname, '..');
const SHORT_TIMEOUT_MS = 150;

let tmpDataDir;
let paperwork;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Sends headers immediately, then writes nothing further and never calls end().
function stallingServer() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (res.flushHeaders) res.flushHeaders();
    // Deliberately never call res.end() or res.write() again.
  });
}

test.before(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-esign-timeouts-'));
  process.env.UNITNAV_DATA_DIR = tmpDataDir;
  process.env.UNITNAV_PROVIDER_TIMEOUT_MS = String(SHORT_TIMEOUT_MS);
  process.env.DOCUSEAL_API_KEY = 'test-key';
  delete require.cache[require.resolve('../database')];
  delete require.cache[require.resolve('../routes/paperwork')];
  paperwork = require('../routes/paperwork');
});

test.after(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.UNITNAV_DATA_DIR;
  delete process.env.UNITNAV_PROVIDER_TIMEOUT_MS;
  delete process.env.DOCUSEAL_API_KEY;
  delete process.env.DOCUSEAL_BASE_URL;
});

async function withStallingServer(fn) {
  const server = stallingServer();
  const port = await listen(server);
  try {
    return await fn(port);
  } finally {
    server.close();
  }
}

async function timeAndAssertRejects(promiseFn, pattern) {
  const started = Date.now();
  await assert.rejects(promiseFn, pattern);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < SHORT_TIMEOUT_MS * 10, `expected a timeout around ${SHORT_TIMEOUT_MS}ms, took ${elapsed}ms — looks like it hung instead`);
  assert.ok(elapsed >= SHORT_TIMEOUT_MS / 2, `resolved suspiciously fast (${elapsed}ms) for a configured ${SHORT_TIMEOUT_MS}ms timeout — is the timer actually armed?`);
}

test('preparePacketWithStirling times out when Stirling sends headers but stalls the body', async () => {
  await withStallingServer(async port => {
    const originalUrl = process.env.STIRLING_PDF_URL;
    process.env.STIRLING_PDF_URL = `http://127.0.0.1:${port}`;
    try {
      await timeAndAssertRejects(
        () => paperwork.preparePacketWithStirling(Buffer.from('%PDF-fake'), 'packet.pdf'),
        /did not respond in time/,
      );
    } finally {
      if (originalUrl === undefined) delete process.env.STIRLING_PDF_URL;
      else process.env.STIRLING_PDF_URL = originalUrl;
    }
  });
});

async function fixturePdf() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 5; i += 1) pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

test('createDocusealSubmission times out when DocuSeal sends headers but stalls the body', async () => {
  await withStallingServer(async port => {
    const originalUrl = process.env.DOCUSEAL_BASE_URL;
    process.env.DOCUSEAL_BASE_URL = `http://127.0.0.1:${port}`;
    try {
      const pdf = await fixturePdf();
      const data = { customer: { name: 'Alice Buyer', email: 'alice@example.com' } };
      const dealerInfo = { representativeName: 'Jane Rep', representativeEmail: 'jane@example.com' };
      await timeAndAssertRejects(
        () => paperwork.createDocusealSubmission(pdf, 'packet.pdf', data, dealerInfo),
        /did not respond in time/,
      );
    } finally {
      if (originalUrl === undefined) delete process.env.DOCUSEAL_BASE_URL;
      else process.env.DOCUSEAL_BASE_URL = originalUrl;
    }
  });
});

test('docusealSubmissionStatus (via archiveDocusealSubmission) times out when DocuSeal sends headers but stalls the body', async () => {
  await withStallingServer(async port => {
    const originalUrl = process.env.DOCUSEAL_BASE_URL;
    process.env.DOCUSEAL_BASE_URL = `http://127.0.0.1:${port}`;
    try {
      await timeAndAssertRejects(
        () => paperwork.archiveDocusealSubmission('some-submission-id', 999),
        /did not respond in time/,
      );
    } finally {
      if (originalUrl === undefined) delete process.env.DOCUSEAL_BASE_URL;
      else process.env.DOCUSEAL_BASE_URL = originalUrl;
    }
  });
});
