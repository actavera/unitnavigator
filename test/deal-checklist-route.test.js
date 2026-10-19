'use strict';
// Route-level coverage for the deal document checklist and the shared deal
// close: permissions, tenant isolation, sensitive notes, outstanding counts on
// deals/dashboard/priorities, both close paths, and cleanup. Real server,
// throwaway data directory, no AI key.
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
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-checklist-route-test-'));
  const port = 6100 + Math.floor(Math.random() * 400);
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

const withDb = fn => {
  const db = new Database(path.join(tmpDataDir, 'unitnavigator.db'));
  try { return fn(db); } finally { db.close(); }
};

let seq = 0;
async function dealer() {
  const res = await api(null, 'POST', '/api/auth/demo-login');
  const dealershipId = jwt.decode(res.body.token).dealership_id;
  withDb(db => { db.prepare('DELETE FROM deals WHERE dealership_id = ?').run(dealershipId); });
  return { token: res.body.token, dealershipId };
}

function addUser(dealershipId, permissions) {
  seq += 1;
  const id = withDb(db => Number(db.prepare(`INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, status, last_login_at)
    VALUES (?, ?, ?, 'x', 'staff', ?, 'active', datetime('now'))`).run(dealershipId, `Checklist User ${seq}`, `checklist-${seq}-${Date.now()}@example.invalid`, JSON.stringify(permissions)).lastInsertRowid));
  return { id, token: jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' }) };
}

function addDeal(dealershipId, { dealType = 'we_finance', withUnit = false, daysOld = 0 } = {}) {
  seq += 1;
  return withDb(db => {
    const customer = Number(db.prepare("INSERT INTO customers (dealership_id, first_name, last_name) VALUES (?, 'Check', 'Probe')").run(dealershipId).lastInsertRowid);
    const unit = withUnit ? Number(db.prepare(`INSERT INTO units (dealership_id, vin, year, make, model, stage, acquisition_cost) VALUES (?, ?, 2020, 'Kia', 'Soul', 'ready', 100)`)
      .run(dealershipId, `CHKVIN${String(seq).padStart(11, '0')}`).lastInsertRowid) : null;
    const deal = Number(db.prepare(`INSERT INTO deals (dealership_id, customer_id, unit_id, deal_type, status, created_at) VALUES (?, ?, ?, ?, 'pending', datetime('now', ?))`)
      .run(dealershipId, customer, unit, dealType, `-${daysOld} days`).lastInsertRowid);
    return { dealId: deal, unitId: unit, customerId: customer };
  });
}

const VIEW = ['deals_view'];
const MANAGE = ['deals_view', 'deals_manage'];
const PAPER = ['deals_view', 'paperwork_manage'];

test('permissions: view sees labels/statuses; manage adds and receives; paperwork approves', async () => {
  const a = await dealer();
  const viewer = addUser(a.dealershipId, VIEW);
  const manager = addUser(a.dealershipId, MANAGE);
  const paper = addUser(a.dealershipId, PAPER);
  const nobody = addUser(a.dealershipId, ['inventory_view']);
  const { dealId } = addDeal(a.dealershipId);

  assert.equal((await api(nobody.token, 'GET', `/api/deals/${dealId}/checklist`)).status, 403);
  assert.equal((await api(viewer.token, 'POST', `/api/deals/${dealId}/checklist/standard`)).status, 403);
  const std = await api(manager.token, 'POST', `/api/deals/${dealId}/checklist/standard`);
  assert.equal(std.status, 200);
  assert.equal(std.body.added, 5);
  assert.equal((await api(manager.token, 'POST', `/api/deals/${dealId}/checklist/standard`)).body.added, 0, 'idempotent');
  const view = await api(viewer.token, 'GET', `/api/deals/${dealId}/checklist`);
  assert.deepEqual(view.body.items.map(i => i.label), ['Identification', 'Pay stubs', 'Proof of residence', 'Insurance', 'Required signatures']);
  const id = view.body.items[0].id;

  assert.equal((await api(viewer.token, 'PATCH', `/api/deals/${dealId}/checklist/${id}`, { status: 'received' })).status, 403);
  assert.equal((await api(paper.token, 'PATCH', `/api/deals/${dealId}/checklist/${id}`, { status: 'received' })).status, 403, 'received needs deals_manage');
  assert.equal((await api(manager.token, 'PATCH', `/api/deals/${dealId}/checklist/${id}`, { status: 'received' })).status, 200);
  assert.equal((await api(manager.token, 'PATCH', `/api/deals/${dealId}/checklist/${id}`, { status: 'approved' })).status, 403);
  const approved = await api(paper.token, 'PATCH', `/api/deals/${dealId}/checklist/${id}`, { status: 'approved' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.items[0].status, 'approved');
  assert.equal((await api(nobody.token, 'PATCH', `/api/deals/${dealId}/checklist/${id}`, { status: 'required', reason: 'x' })).status, 403);
});

test('tenant isolation: another dealership cannot read or change a checklist, or reach items through another deal', async () => {
  const a = await dealer();
  const b = await dealer();
  const { dealId } = addDeal(a.dealershipId);
  const { dealId: otherDeal } = addDeal(a.dealershipId);
  await api(a.token, 'POST', `/api/deals/${dealId}/checklist/standard`);
  const itemId = (await api(a.token, 'GET', `/api/deals/${dealId}/checklist`)).body.items[0].id;
  assert.equal((await api(b.token, 'GET', `/api/deals/${dealId}/checklist`)).status, 404);
  assert.equal((await api(b.token, 'POST', `/api/deals/${dealId}/checklist/standard`)).status, 404);
  assert.equal((await api(b.token, 'POST', `/api/deals/${dealId}/checklist`, { label: 'x' })).status, 404);
  assert.equal((await api(b.token, 'PATCH', `/api/deals/${dealId}/checklist/${itemId}`, { status: 'received' })).status, 404);
  assert.equal((await api(a.token, 'PATCH', `/api/deals/${otherDeal}/checklist/${itemId}`, { status: 'received' })).status, 404, 'item must belong to the deal in the URL');
  assert.equal((await api(b.token, 'DELETE', `/api/deals/${dealId}/checklist/${itemId}`)).status, 404);
});

test('sensitive notes are withheld from users without paperwork or credit access', async () => {
  const a = await dealer();
  const manager = addUser(a.dealershipId, MANAGE);
  const credit = addUser(a.dealershipId, ['deals_view', 'credit_pull']);
  const { dealId } = addDeal(a.dealershipId);
  await api(a.token, 'POST', `/api/deals/${dealId}/checklist`, { item_key: 'identification', note: 'SensitiveNoteProbe' });
  const hidden = await api(manager.token, 'GET', `/api/deals/${dealId}/checklist`);
  assert.ok(!hidden.text.includes('SensitiveNoteProbe'));
  assert.equal(hidden.body.items[0].note_hidden, true);
  assert.equal((await api(credit.token, 'GET', `/api/deals/${dealId}/checklist`)).body.items[0].note, 'SensitiveNoteProbe');
  assert.equal((await api(a.token, 'GET', `/api/deals/${dealId}/checklist`)).body.items[0].note, 'SensitiveNoteProbe');
});

test('outstanding counts reach deals, the dashboard metric, and priorities (count only, never labels)', async () => {
  const a = await dealer();
  const { dealId } = addDeal(a.dealershipId, { daysOld: 5 });
  await api(a.token, 'POST', `/api/deals/${dealId}/checklist`, { item_key: 'lender_stipulation', label: 'PriorityLabelProbe', note: 'PriorityNoteProbe' });
  await api(a.token, 'POST', `/api/deals/${dealId}/checklist`, { label: 'Second item' });
  const list = await api(a.token, 'GET', '/api/deals?status=all');
  assert.equal(list.body.deals.find(d => d.id === dealId).missing_docs, 2);
  assert.equal((await api(a.token, 'GET', '/api/dashboard')).body.metrics.paperwork_incomplete, 1);
  const pri = await api(a.token, 'GET', '/api/dashboard/priorities');
  const item = pri.body.priorities.find(p => p.id === `deal:${dealId}`);
  assert.match(item.reason, /2 checklist items outstanding/);
  assert.match(item.ai_context, /2 checklist items outstanding/);
  assert.equal(item.checklist_outstanding, 2);
  assert.ok(!pri.text.includes('PriorityLabelProbe') && !pri.text.includes('PriorityNoteProbe'), 'no labels or notes in priorities');
});

test('both close paths record the same retail-sold disposition and return the outstanding warning', async () => {
  const a = await dealer();
  const b = await dealer();
  const dealsOnly = addUser(a.dealershipId, ['deals_view', 'deals_manage']);
  const viewer = addUser(a.dealershipId, VIEW);
  const viaAlert = addDeal(a.dealershipId, { withUnit: true });
  const viaStatus = addDeal(a.dealershipId, { withUnit: true });
  for (const d of [viaAlert, viaStatus]) await api(a.token, 'POST', `/api/deals/${d.dealId}/checklist/standard`);

  assert.equal((await api(viewer.token, 'PATCH', `/api/deals/${viaStatus.dealId}/status`, { status: 'closed' })).status, 403);
  assert.equal((await api(b.token, 'PATCH', `/api/deals/${viaStatus.dealId}/status`, { status: 'closed' })).status, 404);

  const r1 = await api(dealsOnly.token, 'POST', `/api/dashboard/deal-alert/${viaAlert.dealId}/action`, { action: 'closed' });
  const r2 = await api(dealsOnly.token, 'PATCH', `/api/deals/${viaStatus.dealId}/status`, { status: 'closed' });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.match(r1.body.warning, /5 checklist items are still outstanding/);
  assert.match(r2.body.warning, /5 checklist items are still outstanding/);
  assert.equal(r2.body.deal.status, 'closed');

  const state = d => withDb(db => ({
    deal: db.prepare('SELECT status FROM deals WHERE id = ?').get(d.dealId).status,
    unit: db.prepare('SELECT stage, sold_price FROM units WHERE id = ?').get(d.unitId),
    dispositions: db.prepare('SELECT outcome, amount, superseded_at FROM unit_dispositions WHERE unit_id = ?').all(d.unitId),
    deals: db.prepare('SELECT COUNT(*) AS n FROM deals WHERE unit_id = ?').get(d.unitId).n,
  }));
  assert.deepEqual(state(viaAlert), state(viaStatus), 'both paths produce identical results');
  assert.deepEqual(state(viaStatus), { deal: 'closed', unit: { stage: 'sold', sold_price: null }, dispositions: [{ outcome: 'retail_sold', amount: null, superseded_at: null }], deals: 1 });

  // Atomic through the status route too.
  const failing = addDeal(a.dealershipId, { withUnit: true });
  withDb(db => db.exec(`CREATE TRIGGER fail_close_${failing.unitId} BEFORE INSERT ON unit_dispositions WHEN NEW.unit_id = ${failing.unitId} BEGIN SELECT RAISE(ABORT, 'forced'); END;`));
  try {
    assert.equal((await api(dealsOnly.token, 'PATCH', `/api/deals/${failing.dealId}/status`, { status: 'closed' })).status, 500);
    assert.deepEqual([state(failing).deal, state(failing).unit.stage], ['pending', 'ready']);
  } finally {
    withDb(db => db.exec(`DROP TRIGGER IF EXISTS fail_close_${failing.unitId};`));
  }
});

test('deal delete, customer delete, and demo cleanup remove checklist rows', async () => {
  const a = await dealer();
  const keep = await dealer();
  const d1 = addDeal(a.dealershipId);
  const d2 = addDeal(a.dealershipId);
  const d3 = addDeal(a.dealershipId);
  const kept = addDeal(keep.dealershipId);
  for (const d of [d1, d2, d3]) await api(a.token, 'POST', `/api/deals/${d.dealId}/checklist/standard`);
  await api(keep.token, 'POST', `/api/deals/${kept.dealId}/checklist/standard`);
  const rows = where => withDb(db => db.prepare(`SELECT (SELECT COUNT(*) FROM deal_checklist_items WHERE ${where}) + (SELECT COUNT(*) FROM deal_checklist_events WHERE ${where}) AS n`).get().n);

  assert.equal((await api(a.token, 'DELETE', `/api/deals/${d1.dealId}`)).status, 200);
  assert.equal(rows(`deal_id = ${d1.dealId}`), 0);
  assert.equal((await api(a.token, 'DELETE', `/api/customers/${d2.customerId}`)).status, 200);
  assert.equal(rows(`deal_id = ${d2.dealId}`), 0);
  await api(a.token, 'POST', '/api/auth/demo-clear');
  assert.equal(rows(`dealership_id = ${a.dealershipId}`), 0);
  assert.ok(rows(`dealership_id = ${keep.dealershipId}`) > 0, 'another dealership untouched');
});
