'use strict';
// Route-level coverage for POST /api/deals/:id/follow-up-draft against a real
// server with NO OPENAI_API_KEY, so no provider is ever contacted: auth,
// permissions, scope, tenancy, fallbacks, and that nothing is ever written.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');
const JWT_SECRET = 'test-only-secret-do-not-use-in-prod';

let child;
let baseUrl;
let tmpDataDir;
let A;
let B;
let manager;
let viewer;
let nobody;
const ids = {};

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.status) return; } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function call(token, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  return { status: res.status, body: json, raw };
}

async function demo() {
  const res = await fetch(`${baseUrl}/api/auth/demo-login`, { method: 'POST' });
  const body = await res.json();
  return { token: body.token, dealershipId: jwt.decode(body.token).dealership_id };
}

const openDb = () => new Database(path.join(tmpDataDir, 'unitnavigator.db'));
const draft = (token, dealId, body) => call(token, 'POST', `/api/deals/${dealId}/follow-up-draft`, body);
const snapshot = () => {
  const db = openDb();
  try {
    return JSON.stringify(['deals', 'customers', 'units', 'documents', 'activity_logs', 'users'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
  } finally { db.close(); }
};

function seedDeal(db, dealershipId, { first, last, status = 'pending', followUp = null }) {
  const customer = Number(db.prepare("INSERT INTO customers (dealership_id, first_name, last_name, phone, email) VALUES (?, ?, ?, '801-555-0100', 'customer@example.com')").run(dealershipId, first, last).lastInsertRowid);
  const unit = Number(db.prepare("INSERT INTO units (dealership_id, vin, year, make, model, stage) VALUES (?, ?, 2021, 'Toyota', 'Camry', 'ready')").run(dealershipId, `FUVIN${Math.floor(Math.random() * 1e12)}`).lastInsertRowid);
  return Number(db.prepare("INSERT INTO deals (dealership_id, customer_id, unit_id, deal_type, status, next_follow_up_at) VALUES (?, ?, ?, 'cash', ?, ?)").run(dealershipId, customer, unit, status, followUp).lastInsertRowid);
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-followup-route-test-'));
  const port = 9100 + Math.floor(Math.random() * 300);
  baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET, NODE_ENV: 'test' };
  delete env.OPENAI_API_KEY;
  child = spawn(process.execPath, ['server.js'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForServer(`${baseUrl}/api/public/dealer`);
  A = await demo();
  B = await demo();

  const db = openDb();
  try {
    ids.pending = seedDeal(db, A.dealershipId, { first: 'Casey', last: 'Customer' });
    ids.overdue = seedDeal(db, A.dealershipId, { first: 'Olive', last: 'Overdue', followUp: '2020-01-01' });
    ids.closed = seedDeal(db, A.dealershipId, { first: 'Cleo', last: 'Closed', status: 'closed' });
    ids.dead = seedDeal(db, A.dealershipId, { first: 'Dee', last: 'Dead', status: 'dead' });
    ids.foreign = seedDeal(db, B.dealershipId, { first: 'Forrest', last: 'Foreign' });
    const addUser = (name, permissions) => {
      const id = Number(db.prepare("INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, status) VALUES (?, ?, ?, ?, 'staff', ?, 'active')").run(A.dealershipId, name, `${name.replace(/\s/g, '').toLowerCase()}@example.test`, bcrypt.hashSync('x', 4), JSON.stringify(permissions)).lastInsertRowid);
      return jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' });
    };
    manager = addUser('Dana Manager', ['deals_view', 'deals_manage']);
    viewer = addUser('Vic Viewer', ['deals_view']);
    nobody = addUser('Nora Nobody', ['inventory_view']);
  } finally {
    db.close();
  }
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

test('authentication and the deals_manage permission are required', async () => {
  assert.equal((await draft(null, ids.pending, { channel: 'email' })).status, 401);
  assert.equal((await draft(nobody, ids.pending, { channel: 'email' })).status, 403);
  assert.equal((await draft(viewer, ids.pending, { channel: 'email' })).status, 403, 'deals_view alone is not enough');
  assert.equal((await draft(manager, ids.pending, { channel: 'email' })).status, 200);
  assert.equal((await draft(A.token, ids.pending, { channel: 'email' })).status, 200, 'an admin has it');
});

test('a template draft needs no key, fills real names locally, and is returned as plain data', async () => {
  const res = await draft(manager, ids.pending, { channel: 'email' });
  assert.equal(res.status, 200);
  assert.equal(res.body.draft.source, 'template');
  assert.equal(res.body.ai_unavailable, undefined);
  assert.match(res.body.draft.subject, /2021 Toyota Camry/);
  assert.match(res.body.draft.body, /^Hi Casey,/);
  assert.ok(res.body.draft.body.includes('Dana Manager'), 'the sender is the signed-in user');
  assert.ok(!/\{\{/.test(res.raw));
  assert.equal(res.body.draft.purpose, 'check_in');
  assert.equal((await draft(manager, ids.overdue, { channel: 'email' })).body.draft.purpose, 'overdue_follow_up');

  const text = await draft(manager, ids.pending, { channel: 'text' });
  assert.equal(text.body.draft.subject, undefined);
  assert.match(text.body.draft.body, /^Hi Casey/);
});

test('with no API key an AI request falls back to the template with a clear message; only a literal true asks for AI', async () => {
  const res = await draft(manager, ids.pending, { channel: 'email', ai: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.ai_unavailable, true);
  assert.equal(res.body.reason, 'not_configured');
  assert.match(res.body.message, /not configured/i);
  assert.equal(res.body.draft.source, 'template');
  assert.match(res.body.draft.body, /^Hi Casey,/);

  for (const notTrue of ['true', 1, 'yes', {}, null]) {
    const r = await draft(manager, ids.pending, { channel: 'email', ai: notTrue });
    assert.equal(r.body.ai_unavailable, undefined, `ai: ${JSON.stringify(notTrue)} must not request AI`);
  }
});

test('invalid channels, missing or foreign deals, and non-pending deals are rejected without leaking anything', async () => {
  assert.equal((await draft(manager, ids.pending, { channel: 'sms' })).status, 400);
  assert.equal((await draft(manager, ids.pending, {})).status, 400);
  assert.equal((await draft(manager, ids.pending, undefined)).status, 400);
  assert.equal((await draft(manager, 999999, { channel: 'email' })).status, 404);
  assert.equal((await draft(manager, 'abc', { channel: 'email' })).status, 404);
  const closed = await draft(manager, ids.closed, { channel: 'email' });
  assert.equal(closed.status, 409);
  assert.match(closed.body.error, /pending/);
  assert.equal((await draft(manager, ids.dead, { channel: 'email' })).status, 409);
  assert.ok(!closed.raw.includes('Cleo'));
});

test('tenant isolation: another dealership cannot draft for, or learn about, this deal, and vice versa', async () => {
  const bManager = B.token;
  const cross = await draft(bManager, ids.pending, { channel: 'email' });
  assert.equal(cross.status, 404);
  assert.ok(!cross.raw.includes('Casey'));
  const crossBack = await draft(manager, ids.foreign, { channel: 'email' });
  assert.equal(crossBack.status, 404);
  assert.ok(!crossBack.raw.includes('Forrest'));
  const own = await draft(bManager, ids.foreign, { channel: 'email' });
  assert.equal(own.status, 200);
  assert.match(own.body.draft.body, /^Hi Forrest,/);
});

test('nothing is ever written, and the deal card\'s "last activity" does not change', async () => {
  const before = snapshot();
  const activityBefore = (await call(manager, 'GET', '/api/deals?status=all')).body.deals.map(d => [d.id, d.last_activity]);
  for (const body of [{ channel: 'email' }, { channel: 'text' }, { channel: 'email', ai: true }, { channel: 'text', ai: true }, { channel: 'sms' }]) {
    await draft(manager, ids.pending, body);
    await draft(manager, ids.overdue, body);
    await draft(manager, ids.closed, body);
  }
  assert.equal(snapshot(), before, 'every table is identical');
  const activityAfter = (await call(manager, 'GET', '/api/deals?status=all')).body.deals.map(d => [d.id, d.last_activity]);
  assert.deepEqual(activityAfter, activityBefore);
});

test('there is no way to send: only POST exists, and the older reminder route is unchanged', async () => {
  assert.equal((await call(manager, 'GET', `/api/deals/${ids.pending}/follow-up-draft`)).status, 404);
  for (const suffix of ['send', 'send-email', 'send-sms', 'follow-up-draft/send']) {
    assert.equal((await call(manager, 'POST', `/api/deals/${ids.pending}/${suffix}`, { channel: 'email' })).status, 404, suffix);
  }
  const reminder = await call(manager, 'POST', `/api/deals/${ids.pending}/email-reminder`, {});
  assert.equal(reminder.status, 200);
  assert.match(reminder.body.mailto, /^mailto:/);
});
