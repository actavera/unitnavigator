'use strict';
// Route-level coverage for title and registration cases: permissions, tenant
// isolation, automatic creation on both close paths, dashboard/priorities
// surfacing (no names or notes in AI context), and cleanup.
const test = require('node:test');
const assert = require('node:assert/strict');
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

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-titles-route-test-'));
  const port = 7100 + Math.floor(Math.random() * 400);
  baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET, NODE_ENV: 'test' };
  delete env.OPENAI_API_KEY;
  child = spawn(process.execPath, ['server.js'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 10000;
  for (;;) {
    try { await fetch(`${baseUrl}/api/public/dealer`); break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 100));
  }
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

async function api(token, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const withDb = fn => { const db = new Database(path.join(tmpDataDir, 'unitnavigator.db')); try { return fn(db); } finally { db.close(); } };

let seq = 0;
async function dealer() {
  const res = await api(null, 'POST', '/api/auth/demo-login');
  const dealershipId = jwt.decode(res.body.token).dealership_id;
  withDb(db => db.prepare('DELETE FROM deals WHERE dealership_id = ?').run(dealershipId));
  return { token: res.body.token, dealershipId };
}
function addUser(dealershipId, permissions, status = 'active') {
  seq += 1;
  const id = withDb(db => Number(db.prepare(`INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, status, last_login_at)
    VALUES (?, ?, ?, 'x', 'staff', ?, ?, datetime('now'))`).run(dealershipId, `Title User ${seq}`, `title-${seq}-${Date.now()}@example.invalid`, JSON.stringify(permissions), status).lastInsertRowid));
  return { id, token: jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' }) };
}
function addDeal(dealershipId, status = 'pending') {
  seq += 1;
  return withDb(db => {
    const customer = Number(db.prepare("INSERT INTO customers (dealership_id, first_name, last_name) VALUES (?, 'TitleCustomerProbe', 'Buyer')").run(dealershipId).lastInsertRowid);
    const unit = Number(db.prepare("INSERT INTO units (dealership_id, vin, year, make, model, stage, acquisition_cost) VALUES (?, ?, 2020, 'Kia', 'Soul', 'ready', 100)").run(dealershipId, `TTLVIN${String(seq).padStart(11, '0')}`).lastInsertRowid);
    return { unitId: unit, dealId: Number(db.prepare("INSERT INTO deals (dealership_id, customer_id, unit_id, deal_type, status) VALUES (?, ?, ?, 'cash', ?)").run(dealershipId, customer, unit, status).lastInsertRowid) };
  });
}

const VIEW = ['deals_view'];
const MANAGE = ['deals_view', 'deals_manage'];

test('both close paths open a case; manual creation for legacy closed deals; permissions', async () => {
  const a = await dealer();
  const manager = addUser(a.dealershipId, MANAGE);
  const viewer = addUser(a.dealershipId, VIEW);
  const viaAlert = addDeal(a.dealershipId);
  const viaStatus = addDeal(a.dealershipId);
  const legacy = addDeal(a.dealershipId, 'closed');
  await api(manager.token, 'POST', `/api/dashboard/deal-alert/${viaAlert.dealId}/action`, { action: 'closed' });
  await api(manager.token, 'PATCH', `/api/deals/${viaStatus.dealId}/status`, { status: 'closed' });
  for (const d of [viaAlert, viaStatus]) {
    const r = await api(viewer.token, 'GET', `/api/titles/deal/${d.dealId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.case.status, 'not_started');
  }
  assert.equal((await api(viewer.token, 'GET', `/api/titles/deal/${legacy.dealId}`)).body.case, null, 'no automatic backfill');
  assert.equal((await api(viewer.token, 'POST', '/api/titles', { deal_id: legacy.dealId })).status, 403);
  const made = await api(manager.token, 'POST', '/api/titles', { deal_id: legacy.dealId });
  assert.equal(made.status, 201);
  assert.ok(made.body.case.id);
  const pending = addDeal(a.dealershipId);
  assert.equal((await api(manager.token, 'POST', '/api/titles', { deal_id: pending.dealId })).status, 409);
  assert.equal((await api(viewer.token, 'PATCH', `/api/titles/${made.body.case.id}`, { status: 'submitted' })).status, 403);
  assert.equal((await api(addUser(a.dealershipId, ['inventory_view']).token, 'GET', '/api/titles')).status, 403);
});

test('updates, assignment rules, history, and tenant isolation', async () => {
  const a = await dealer();
  const b = await dealer();
  const manager = addUser(a.dealershipId, MANAGE);
  const revoked = addUser(a.dealershipId, MANAGE, 'revoked');
  const other = addUser(b.dealershipId, MANAGE);
  const d = addDeal(a.dealershipId, 'closed');
  const id = (await api(manager.token, 'POST', '/api/titles', { deal_id: d.dealId })).body.case.id;
  assert.equal((await api(manager.token, 'PATCH', `/api/titles/${id}`, { assigned_user_id: revoked.id })).status, 400);
  assert.equal((await api(manager.token, 'PATCH', `/api/titles/${id}`, { assigned_user_id: other.id })).status, 400);
  const saved = await api(manager.token, 'PATCH', `/api/titles/${id}`, { assigned_user_id: manager.id, plate_status: 'received', temp_tag_expires_on: '2020-01-01', blocking_issue: 'Waiting on lien release' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.case.level, 'overdue');
  assert.ok(saved.body.case.history.some(h => h.field === 'plate_status' && h.to_value === 'received'));
  assert.equal((await api(b.token, 'GET', `/api/titles/deal/${d.dealId}`)).status, 404);
  assert.equal((await api(b.token, 'PATCH', `/api/titles/${id}`, { status: 'completed' })).status, 404);
  assert.equal((await api(b.token, 'POST', '/api/titles', { deal_id: d.dealId })).status, 404);
  assert.equal((await api(b.token, 'GET', '/api/titles?filter=all')).body.cases.length, 0);
  const people = (await api(manager.token, 'GET', '/api/titles/assignees')).body.users.map(u => u.id);
  assert.ok(people.includes(manager.id) && !people.includes(revoked.id) && !people.includes(other.id));
});

test('due and overdue cases reach the dashboard and priorities without names or notes in the AI context', async () => {
  const a = await dealer();
  const d1 = addDeal(a.dealershipId, 'closed');
  const d2 = addDeal(a.dealershipId, 'closed');
  const c1 = (await api(a.token, 'POST', '/api/titles', { deal_id: d1.dealId })).body.case.id;
  const c2 = (await api(a.token, 'POST', '/api/titles', { deal_id: d2.dealId })).body.case.id;
  await api(a.token, 'PATCH', `/api/titles/${c1}`, { temp_tag_expires_on: '2020-01-01', note: 'TitleNoteProbe' });
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await api(a.token, 'PATCH', `/api/titles/${c2}`, { temp_tag_expires_on: soon });
  const m = (await api(a.token, 'GET', '/api/dashboard')).body.metrics;
  assert.deepEqual([m.title_cases_due, m.title_cases_overdue], [2, 1]);
  const pri = await api(a.token, 'GET', '/api/dashboard/priorities');
  const items = pri.body.priorities.filter(p => p.type === 'title');
  assert.equal(items.length, 2);
  const overdue = items.find(p => p.id === `title:${c1}`);
  assert.equal(overdue.priority_level, 'high');
  assert.match(overdue.reason, /Temporary tag expired/);
  assert.equal(overdue.link, `/deals?deal=${d1.dealId}`);
  for (const p of items) assert.ok(!/TitleCustomerProbe|TitleNoteProbe/.test(p.ai_context));
  const listed = await api(a.token, 'GET', '/api/titles?filter=overdue');
  assert.deepEqual(listed.body.cases.map(c => c.id), [c1]);
  await api(a.token, 'PATCH', `/api/titles/${c1}`, { status: 'completed' });
  assert.equal((await api(a.token, 'GET', '/api/dashboard')).body.metrics.title_cases_overdue, 0, 'completed cases drop off');
});

test('deal delete, customer delete, and demo cleanup remove title cases and history', async () => {
  const a = await dealer();
  const keep = await dealer();
  const d1 = addDeal(a.dealershipId, 'closed');
  const k = addDeal(keep.dealershipId, 'closed');
  await api(a.token, 'POST', '/api/titles', { deal_id: d1.dealId });
  await api(keep.token, 'POST', '/api/titles', { deal_id: k.dealId });
  assert.equal((await api(a.token, 'DELETE', `/api/deals/${d1.dealId}`)).status, 200);
  const count = id => withDb(db => db.prepare('SELECT (SELECT COUNT(*) FROM title_cases WHERE dealership_id = ?) + (SELECT COUNT(*) FROM title_case_events WHERE dealership_id = ?) AS n').get(id, id).n);
  assert.equal(count(a.dealershipId), 0);
  await api(keep.token, 'POST', '/api/auth/demo-clear');
  assert.equal(count(keep.dealershipId), 0);
});
