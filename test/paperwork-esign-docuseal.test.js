'use strict';
// End-to-end coverage of the DocuSeal e-sign migration, driven against the
// real running server with two local mock providers standing in for Stirling
// and DocuSeal — no real network call, no real credentials, nothing sent to
// an actual signer.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');
const TEST_DOCUSEAL_KEY = 'unitnav-test-docuseal-key-do-not-use';

let child;
let baseUrl;
let tmpDataDir;
let stirlingServer;
let docusealServer;
let stirlingCalls;
let docusealCalls;
let docusealDownloads;
// pdf-lib embeds a timestamp, so two separately-generated "marker" PDFs are
// never byte-identical even with the same page structure — generate it once
// and reuse this exact buffer everywhere, rather than regenerating it for
// comparison later.
let flattenedMarkerPdf;

// A fixed, distinctive 6-page PDF standing in for "whatever Stirling
// flattened" — deliberately unrelated to buildOfficialPacket's real output,
// so if the code ever accidentally submitted the PRE-flatten bytes to
// DocuSeal instead of Stirling's (this mock's) output, the byte-comparison
// tests below would fail.
async function makeFlattenedMarkerPdf() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 6; i += 1) pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test.before(async () => {
  flattenedMarkerPdf = await makeFlattenedMarkerPdf();

  // --- Mock Stirling: records every flatten call, always returns the marker PDF.
  stirlingCalls = [];
  stirlingServer = http.createServer(async (req, res) => {
    const body = await readRawBody(req);
    stirlingCalls.push({ url: req.url, method: req.method, receivedByteLength: body.length });
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(flattenedMarkerPdf);
  });
  const stirlingPort = await listen(stirlingServer);

  // --- Mock DocuSeal: records every submission-create/status call, serves
  // fake "fresh" document/audit-log downloads with per-call tokens.
  docusealCalls = [];
  docusealDownloads = [];
  let nextSubmissionState = null; // set per-test via docusealServer.setState(...)
  docusealServer = http.createServer(async (req, res) => {
    const body = await readRawBody(req);
    const authToken = req.headers['x-auth-token'];

    if (req.method === 'POST' && req.url === '/submissions/pdf') {
      let parsed = {};
      try { parsed = JSON.parse(body.toString('utf8')); } catch { /* ignore */ }
      docusealCalls.push({ type: 'create', authToken, payload: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 555, name: parsed.name, status: 'pending', submitters: parsed.submitters.map((s, i) => ({ ...s, embed_src: `https://docuseal.mock/s/${i}` })) }));
      return;
    }

    if (req.method === 'GET' && /^\/submissions\/\d+$/.test(req.url)) {
      docusealCalls.push({ type: 'status', authToken, url: req.url });
      const state = nextSubmissionState || { status: 'pending' };
      res.writeHead(state.httpStatus || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.body || { status: 'pending' }));
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/download/document')) {
      const token = new URL(req.url, 'http://x').searchParams.get('token');
      docusealDownloads.push({ type: 'document', token });
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(Buffer.from(`SIGNED-DOCUMENT-${token}`));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/download/audit')) {
      const token = new URL(req.url, 'http://x').searchParams.get('token');
      docusealDownloads.push({ type: 'audit', token });
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(Buffer.from(`AUDIT-LOG-${token}`));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/download/fail')) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('provider is down');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  docusealServer.setState = state => { nextSubmissionState = state; };
  const docusealPort = await listen(docusealServer);

  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-esign-test-'));
  const port = 5300 + Math.floor(Math.random() * 300);
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      UNITNAV_DATA_DIR: tmpDataDir,
      JWT_SECRET: 'test-only-secret-do-not-use-in-prod',
      NODE_ENV: 'test',
      STIRLING_PDF_URL: `http://127.0.0.1:${stirlingPort}`,
      DOCUSEAL_API_KEY: TEST_DOCUSEAL_KEY,
      DOCUSEAL_BASE_URL: `http://127.0.0.1:${docusealPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(`${baseUrl}/api/paperwork`);
});

test.after(async () => {
  if (child) child.kill();
  await new Promise(r => stirlingServer.close(r));
  await new Promise(r => docusealServer.close(r));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

async function api(token, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function demoDealer() {
  const res = await api(null, 'POST', '/api/auth/demo-login');
  assert.equal(res.status, 200);
  return { token: res.body.token, user: res.body.user };
}

function packetPayload(overrides = {}) {
  return {
    dealNumber: 'D-2001',
    packetType: 'they_finance',
    customer: { name: 'Alice Buyer', email: 'alice@example.com', phone: '555-0100', address: '456 Oak St, Provo, UT 84601', idNumber: 'D1234567' },
    vehicle: { year: 2020, make: 'Honda', model: 'Accord', trim: 'EX', color: 'Blue', vin: '1HGCV1F34LA000000', mileage: 42000 },
    finance: { responsibility: 'dealer', apr: 9.99, termMonths: 60, payment: 350 },
    pricing: { salePrice: 20000, salesTax: 1450, docFee: 399, total: 22006.5, downPayment: 1000, amountFinanced: 21006.5 },
    formAnswers: {},
    rules: {},
    ...overrides,
  };
}

test('POST /api/paperwork/esign: packet is flattened before submission, exact flattened bytes go to DocuSeal, using only Unit Navigator\'s key', async () => {
  docusealServer.setState({ status: 'pending' });
  const dealer = await demoDealer();
  const me = await api(dealer.token, 'GET', '/api/auth/me');
  const dealershipId = me.body.user.dealership_id;
  await api(dealer.token, 'PUT', '/api/admin/dealership-settings', {
    dealership_id: dealershipId,
    representative_name: 'Jane Rep',
    representative_email: 'dealer@testmotors.example',
  });

  const stirlingBefore = stirlingCalls.length;
  const docusealBefore = docusealCalls.length;

  const res = await api(dealer.token, 'POST', '/api/paperwork/esign', packetPayload());
  assert.equal(res.status, 201, JSON.stringify(res.body));

  assert.equal(stirlingCalls.length, stirlingBefore + 1, 'Stirling must be called exactly once (packet generation happens before flattening, in-process, so there is nothing to observe there — flattening is the first externally observable step)');
  assert.equal(docusealCalls.length, docusealBefore + 1, 'DocuSeal must be called exactly once, after Stirling');
  assert.ok(
    stirlingCalls[stirlingCalls.length - 1].receivedByteLength > 10000,
    'a genuinely generated multi-page packet (not an empty/trivial body) must reach Stirling for flattening before DocuSeal is ever called',
  );

  const createCall = docusealCalls[docusealCalls.length - 1];
  assert.equal(createCall.authToken, TEST_DOCUSEAL_KEY, 'must authenticate with Unit Navigator\'s own DocuSeal key');

  const submittedPdfBytes = Buffer.from(createCall.payload.documents[0].file, 'base64');
  assert.ok(submittedPdfBytes.equals(flattenedMarkerPdf), 'DocuSeal must receive exactly the bytes Stirling returned, not the pre-flatten packet');
});

test('customer is signer 0, dealer representative is signer 1, and order is explicitly preserved', async () => {
  const dealer = await demoDealer();
  const me = await api(dealer.token, 'GET', '/api/auth/me');
  await api(dealer.token, 'PUT', '/api/admin/dealership-settings', {
    dealership_id: me.body.user.dealership_id,
    representative_name: 'Jane Rep',
    representative_email: 'dealer@testmotors.example',
  });

  await api(dealer.token, 'POST', '/api/paperwork/esign', packetPayload());
  const createCall = docusealCalls[docusealCalls.length - 1];
  assert.equal(createCall.payload.order, 'preserved');
  assert.equal(createCall.payload.submitters.length, 2);
  assert.equal(createCall.payload.submitters[0].role, 'Buyer');
  assert.equal(createCall.payload.submitters[0].email, 'alice@example.com');
  assert.equal(createCall.payload.submitters[1].role, 'Dealer');
  assert.equal(createCall.payload.submitters[1].email, 'dealer@testmotors.example');
});

test('request-body attempts to override the countersigner are ignored: dealer identity always comes from server-side settings', async () => {
  const dealer = await demoDealer();
  const me = await api(dealer.token, 'GET', '/api/auth/me');
  await api(dealer.token, 'PUT', '/api/admin/dealership-settings', {
    dealership_id: me.body.user.dealership_id,
    representative_name: 'Real Rep',
    representative_email: 'real-rep@testmotors.example',
  });

  const maliciousPayload = packetPayload({
    dealer: { representativeName: 'Attacker Controlled', email: 'attacker@evil.example', name: 'Fake Dealer Inc' },
  });
  const res = await api(dealer.token, 'POST', '/api/paperwork/esign', maliciousPayload);
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const createCall = docusealCalls[docusealCalls.length - 1];
  const dealerSubmitter = createCall.payload.submitters.find(s => s.role === 'Dealer');
  assert.equal(dealerSubmitter.email, 'real-rep@testmotors.example', 'the attacker-supplied email must be ignored');
  assert.equal(dealerSubmitter.name, 'Real Rep', 'the attacker-supplied name must be ignored');
});

test('a user without contracts_manage receives 403', async () => {
  const dealer = await demoDealer();
  const me = await api(dealer.token, 'GET', '/api/auth/me');
  const dealershipId = me.body.user.dealership_id;
  const staffEmail = `staff-${Date.now()}@example.com`;
  await api(dealer.token, 'POST', '/api/admin/dealership-users', {
    dealership_id: dealershipId, name: 'Limited Staff', email: staffEmail, password: 'password123', role: 'staff',
  });
  const loginRes = await api(null, 'POST', '/api/auth/login', { email: staffEmail, password: 'password123' });
  const staffToken = loginRes.body.token;

  const res = await api(staffToken, 'POST', '/api/paperwork/esign', packetPayload());
  assert.equal(res.status, 403);
});

test('Dealer A cannot inspect or archive Dealer B\'s e-sign submission', async () => {
  const dealerA = await demoDealer();
  const meA = await api(dealerA.token, 'GET', '/api/auth/me');
  await api(dealerA.token, 'PUT', '/api/admin/dealership-settings', {
    dealership_id: meA.body.user.dealership_id, representative_name: 'A Rep', representative_email: 'a-rep@example.com',
  });
  const sendRes = await api(dealerA.token, 'POST', '/api/paperwork/esign', packetPayload());
  const envelopeId = sendRes.body.envelope_id;
  assert.ok(envelopeId);

  const dealerB = await demoDealer();
  const statusAsB = await api(dealerB.token, 'GET', `/api/paperwork/esign/${envelopeId}/status`);
  assert.equal(statusAsB.status, 404, 'Dealer B must not be able to inspect Dealer A\'s submission');
});

// The success-path archival test, and the document/audit/filesystem-write
// failure tests, live in test/paperwork-esign-archival.test.js: once
// combined_document_url/audit_log_url are routed through safeFetch (item 5),
// no locally-run mock server can ever pass as the download target here
// (127.0.0.1 is exactly what that guard exists to block), so those cases are
// covered in-process instead, driving archiveDocusealSubmission directly.
// This file keeps the failure mode that doesn't involve a download at all.
test('a "completed" status with a missing audit-log URL is a retryable error, not a silent partial archive', async () => {
  const dealer = await demoDealer();
  const me = await api(dealer.token, 'GET', '/api/auth/me');
  await api(dealer.token, 'PUT', '/api/admin/dealership-settings', {
    dealership_id: me.body.user.dealership_id, representative_name: 'Jane Rep', representative_email: 'dealer@testmotors.example',
  });
  docusealServer.setState({ status: 'pending' });
  const sendRes = await api(dealer.token, 'POST', '/api/paperwork/esign', packetPayload());
  const envelopeId = sendRes.body.envelope_id;

  docusealServer.setState({
    status: 200,
    httpStatus: 200,
    body: {
      status: 'completed',
      combined_document_url: `http://127.0.0.1:${docusealServer.address().port}/download/document?token=x`,
      // audit_log_url deliberately omitted
    },
  });
  const failedStatusRes = await api(dealer.token, 'GET', `/api/paperwork/esign/${envelopeId}/status`);
  assert.notEqual(failedStatusRes.status, 200, 'must surface as an error, not a success');
  assert.equal(docusealDownloads.length, 0, 'must not attempt any download when a required URL is missing');

  docusealServer.setState({ status: 'pending' });
  const stillPendingRes = await api(dealer.token, 'GET', `/api/paperwork/esign/${envelopeId}/status`);
  assert.equal(stillPendingRes.status, 200);
  assert.notEqual(stillPendingRes.body.status, 'completed');
  assert.equal(stillPendingRes.body.archived, false);
});

test('e-sign requires a dedicated representative_email; the dealership\'s general contact email is never used as the countersigner', async () => {
  const dealer = await demoDealer();
  const me = await api(dealer.token, 'GET', '/api/auth/me');
  await api(dealer.token, 'PUT', '/api/admin/dealership-settings', {
    dealership_id: me.body.user.dealership_id,
    representative_name: 'Jane Rep',
    email: 'general-contact@testmotors.example', // general dealership email, NOT the countersigner
    // representative_email intentionally left unset
  });

  const before = docusealCalls.length;
  const res = await api(dealer.token, 'POST', '/api/paperwork/esign', packetPayload());
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(docusealCalls.length, before, 'must not even attempt to create a DocuSeal submission without a configured representative_email');

  // Now set representative_email and confirm it — not the general email — is used.
  await api(dealer.token, 'PUT', '/api/admin/dealership-settings', {
    dealership_id: me.body.user.dealership_id,
    representative_name: 'Jane Rep',
    email: 'general-contact@testmotors.example',
    representative_email: 'jane.rep@testmotors.example',
  });
  const res2 = await api(dealer.token, 'POST', '/api/paperwork/esign', packetPayload());
  assert.equal(res2.status, 201, JSON.stringify(res2.body));
  const dealerSubmitter = docusealCalls[docusealCalls.length - 1].payload.submitters.find(s => s.role === 'Dealer');
  assert.equal(dealerSubmitter.email, 'jane.rep@testmotors.example');
  assert.notEqual(dealerSubmitter.email, 'general-contact@testmotors.example');
});

test('a legacy (non-docuseal) provider row returns 409 and is never sent to the DocuSeal API', async () => {
  const dealer = await demoDealer();
  const me = await api(dealer.token, 'GET', '/api/auth/me');
  const dealershipId = me.body.user.dealership_id;

  // Insert a legacy row directly — this app version never creates one, but a
  // pre-migration database could still contain one.
  const rawDb = new Database(path.join(tmpDataDir, 'unitnavigator.db'));
  const insert = rawDb.prepare(`
    INSERT INTO esign_envelopes (dealership_id, provider, provider_envelope_id, title, status, signer_summary)
    VALUES (?, 'documenso', 'legacy-envelope-id-123', 'Legacy Deal Packet', 'pending', '[]')
  `).run(dealershipId);
  rawDb.close();

  const before = docusealCalls.length;
  const res = await api(dealer.token, 'GET', `/api/paperwork/esign/${insert.lastInsertRowid}/status`);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.provider, 'documenso');
  assert.equal(docusealCalls.length, before, 'must never send a legacy provider ID to the DocuSeal API');
});

test('the stored provider_response and signing_url never contain temporary URLs or signing tokens', async () => {
  const dealer = await demoDealer();
  const me = await api(dealer.token, 'GET', '/api/auth/me');
  await api(dealer.token, 'PUT', '/api/admin/dealership-settings', {
    dealership_id: me.body.user.dealership_id, representative_name: 'Jane Rep', representative_email: 'dealer@testmotors.example',
  });
  docusealServer.setState({ status: 'pending' });
  const sendRes = await api(dealer.token, 'POST', '/api/paperwork/esign', packetPayload());
  assert.equal(sendRes.status, 201, JSON.stringify(sendRes.body));
  const envelopeId = sendRes.body.envelope_id;

  // The immediate HTTP response may carry a one-time signing link (for the
  // "open signing link now" UX) — but the DATABASE must not.
  assert.ok(sendRes.body.signing_url, 'sanity check: the mock did return an embed_src for the immediate response');

  const rawDb = new Database(path.join(tmpDataDir, 'unitnavigator.db'), { readonly: true });
  const row = rawDb.prepare('SELECT * FROM esign_envelopes WHERE id = ?').get(envelopeId);
  rawDb.close();

  assert.equal(row.signing_url, null, 'signing_url column must never be populated');
  assert.ok(row.provider_response, 'provider_response must still be present (sanitized)');
  const stored = JSON.parse(row.provider_response);
  const storedText = JSON.stringify(stored);
  assert.ok(!/docuseal\.mock/.test(storedText), 'no provider host/URL of any kind may appear in stored provider_response');
  assert.ok(!/https?:\/\//.test(storedText), 'no URL scheme of any kind may appear in stored provider_response');
  assert.ok(!storedText.includes('embed_src'), 'embed_src key name must not appear');
  assert.ok(!storedText.includes('slug'), 'no signing-token-bearing slug field may appear');
  // Durable fields the sanitizer IS supposed to keep:
  assert.equal(typeof stored.created.id, 'number');
  assert.equal(stored.created.status, 'pending');
});
