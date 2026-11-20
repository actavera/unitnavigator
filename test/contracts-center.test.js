'use strict';
// Contracts center: listing signed/unsigned e-sign packets, serving archived
// signed PDFs, and voiding unsigned packets. A fake DocuSeal server stands in
// for the provider; nothing real is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');
const JWT_SECRET = 'test-only-secret-do-not-use-in-prod';
let child;
let baseUrl;
let tmpDataDir;
let docuseal;
const calls = [];
const remote = {}; // submission id -> status at the fake provider

test.before(async () => {
  docuseal = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url.split('/').pop());
    calls.push([req.method, req.url, req.headers['x-auth-token']]);
    if (!(id in remote)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"Not found"}'); }
    if (req.method === 'DELETE') { if (remote[id] === 'fail') { res.writeHead(500); return res.end('{"error":"boom"}'); } remote[id] = 'archived'; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, status: remote[id] === 'fail' ? 'pending' : remote[id] }));
  });
  await new Promise(r => docuseal.listen(0, '127.0.0.1', r));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-contracts-test-'));
  const port = 8600 + Math.floor(Math.random() * 300);
  baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET, NODE_ENV: 'test', DOCUSEAL_API_KEY: 'fake-docuseal-key', DOCUSEAL_BASE_URL: `http://127.0.0.1:${docuseal.address().port}` };
  delete env.OPENAI_API_KEY;
  child = spawn(process.execPath, ['server.js'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 10000;
  for (;;) {
    try { await fetch(`${baseUrl}/healthz`); break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 100));
  }
});
test.after(() => { if (child) child.kill(); docuseal.close(); fs.rmSync(tmpDataDir, { recursive: true, force: true }); });

async function api(token, method, urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch { /* pdf */ }
  return { status: res.status, json, buf, type: res.headers.get('content-type') };
}
const withDb = fn => { const db = new Database(path.join(tmpDataDir, 'unitnavigator.db')); try { return fn(db); } finally { db.close(); } };

let seq = 0;
async function dealer() {
  const res = await fetch(`${baseUrl}/api/auth/demo-login`, { method: 'POST' });
  const token = (await res.json()).token;
  return { token, dealershipId: jwt.decode(token).dealership_id };
}
function envelope(dealershipId, { status = 'pending', archived = false, remoteStatus } = {}) {
  seq += 1;
  const sub = `SUB${seq}`;
  remote[sub] = remoteStatus || status;
  return withDb(db => {
    const customer = Number(db.prepare("INSERT INTO customers (dealership_id, first_name, last_name) VALUES (?, 'Contract', 'Buyer')").run(dealershipId).lastInsertRowid);
    const deal = Number(db.prepare("INSERT INTO deals (dealership_id, customer_id, deal_type, status) VALUES (?, ?, 'cash', 'pending')").run(dealershipId, customer).lastInsertRowid);
    let archivePath = null;
    if (archived) {
      const dir = path.join(tmpDataDir, 'esign-archives');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${dealershipId}-${sub}.pdf`), '%PDF-1.4 signed');
      fs.writeFileSync(path.join(dir, `${dealershipId}-${sub}-audit.pdf`), '%PDF-1.4 audit');
      archivePath = path.join('data', 'esign-archives', `${dealershipId}-${sub}.pdf`);
    }
    const id = Number(db.prepare(`INSERT INTO esign_envelopes (dealership_id, deal_id, provider, provider_envelope_id, title, status, signer_summary, archive_path, audit_log_path, completed_at)
      VALUES (?, ?, 'docuseal', ?, 'Packet', ?, '[{"role":"Buyer","name":"Contract Buyer","email":"buyer@example.invalid"}]', ?, ?, ?)`)
      .run(dealershipId, deal, sub, status, archivePath, archivePath && archivePath.replace('.pdf', '-audit.pdf'), archived ? '2026-11-20T00:00:00Z' : null).lastInsertRowid);
    return { id, deal, sub };
  });
}

test('lists signed and unsigned packets for this dealership only, without signer emails', async () => {
  const a = await dealer();
  const b = await dealer();
  const unsigned = envelope(a.dealershipId);
  const signed = envelope(a.dealershipId, { status: 'completed', archived: true });
  envelope(b.dealershipId);
  const ids = async filter => (await api(a.token, 'GET', `/api/paperwork/esign?filter=${filter}`)).json.contracts.map(c => c.id);
  assert.deepEqual(await ids('unsigned'), [unsigned.id]);
  assert.deepEqual(await ids('signed'), [signed.id]);
  assert.deepEqual((await ids('all')).sort(), [unsigned.id, signed.id].sort());
  const list = await api(a.token, 'GET', '/api/paperwork/esign?filter=all');
  assert.ok(!list.buf.toString().includes('buyer@example.invalid'), 'signer emails are not listed');
  assert.equal(list.json.contracts.find(c => c.id === signed.id).has_document, true);
});

test('serves the archived signed PDF and audit log inline; refuses other dealerships and missing files', async () => {
  const a = await dealer();
  const b = await dealer();
  const signed = envelope(a.dealershipId, { status: 'completed', archived: true });
  const doc = await api(a.token, 'GET', `/api/paperwork/esign/${signed.id}/document`);
  assert.equal(doc.status, 200);
  assert.equal(doc.type, 'application/pdf');
  assert.equal(doc.buf.toString(), '%PDF-1.4 signed');
  assert.equal((await api(a.token, 'GET', `/api/paperwork/esign/${signed.id}/document?kind=audit`)).buf.toString(), '%PDF-1.4 audit');
  assert.equal((await api(b.token, 'GET', `/api/paperwork/esign/${signed.id}/document`)).status, 404);
  const unsigned = envelope(a.dealershipId);
  assert.equal((await api(a.token, 'GET', `/api/paperwork/esign/${unsigned.id}/document`)).status, 404);
  // A recorded path naming another dealership's file is refused.
  withDb(db => db.prepare('UPDATE esign_envelopes SET archive_path = ? WHERE id = ?').run(`data/esign-archives/${b.dealershipId}-X.pdf`, unsigned.id));
  assert.equal((await api(a.token, 'GET', `/api/paperwork/esign/${unsigned.id}/document`)).status, 404);
});

test('voiding: unsigned packets are archived at DocuSeal then removed; signed ones never', async () => {
  const a = await dealer();
  const b = await dealer();
  const unsigned = envelope(a.dealershipId);
  assert.equal((await api(b.token, 'DELETE', `/api/paperwork/esign/${unsigned.id}`)).status, 404);
  const ok = await api(a.token, 'DELETE', `/api/paperwork/esign/${unsigned.id}`);
  assert.equal(ok.status, 200);
  assert.ok(calls.some(([m, u, k]) => m === 'DELETE' && u.endsWith(`/submissions/${unsigned.sub}`) && k === 'fake-docuseal-key'));
  assert.equal(remote[unsigned.sub], 'archived');
  withDb(db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esign_envelopes WHERE id = ?').get(unsigned.id).n, 0);
    assert.ok(db.prepare("SELECT 1 FROM activity_logs WHERE entity_type = 'deal' AND entity_id = ? AND action = 'Unsigned e-sign packet voided'").get(unsigned.deal));
  });

  const signed = envelope(a.dealershipId, { status: 'completed', archived: true });
  assert.equal((await api(a.token, 'DELETE', `/api/paperwork/esign/${signed.id}`)).status, 409);

  const signedSinceRefresh = envelope(a.dealershipId, { status: 'pending', remoteStatus: 'completed' });
  assert.equal((await api(a.token, 'DELETE', `/api/paperwork/esign/${signedSinceRefresh.id}`)).status, 409, 'rechecks DocuSeal before deleting');
  assert.notEqual(remote[signedSinceRefresh.sub], 'archived');

  const failing = envelope(a.dealershipId, { remoteStatus: 'fail' });
  assert.equal((await api(a.token, 'DELETE', `/api/paperwork/esign/${failing.id}`)).status, 502);
  assert.equal(withDb(db => db.prepare('SELECT COUNT(*) AS n FROM esign_envelopes WHERE id = ?').get(failing.id).n), 1, 'nothing deleted when DocuSeal fails');
});

test('requires contracts_manage', async () => {
  const a = await dealer();
  const id = withDb(db => Number(db.prepare(`INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, permissions_version, status)
    VALUES (?, 'Viewer', ?, 'x', 'staff', '["deals_view"]', 2, 'active')`).run(a.dealershipId, `viewer-${Date.now()}@example.invalid`).lastInsertRowid));
  const token = jwt.sign({ id }, JWT_SECRET);
  const e = envelope(a.dealershipId);
  assert.equal((await api(token, 'GET', '/api/paperwork/esign')).status, 403);
  assert.equal((await api(token, 'DELETE', `/api/paperwork/esign/${e.id}`)).status, 403);
  assert.equal((await api(token, 'GET', `/api/paperwork/esign/${e.id}/document`)).status, 403);
});
