'use strict';
// Route-level coverage for inventory assignment, review, escalation, and
// disposition: permission boundaries, tenant isolation, the dealership review
// interval setting, the dashboard/priorities alert payload, and the public
// showroom staying free of internal disposition data. Runs a real server in a
// throwaway data directory.
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
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-inventory-truth-test-'));
  const port = 5200 + Math.floor(Math.random() * 500);
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
  assert.equal(res.status, 200);
  const dealershipId = jwt.decode(res.body.token).dealership_id;
  withDb(db => {
    db.prepare('DELETE FROM deals WHERE dealership_id = ?').run(dealershipId);
    db.prepare('DELETE FROM units WHERE dealership_id = ?').run(dealershipId);
  });
  return { token: res.body.token, dealershipId };
}

function addUser(dealershipId, { permissions, status = 'active', name }) {
  seq += 1;
  const id = withDb(db => Number(db.prepare(`INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, status, last_login_at)
    VALUES (?, ?, ?, 'x', 'staff', ?, ?, datetime('now'))`).run(dealershipId, name || `User ${seq}`, `truth-${seq}-${Date.now()}@example.invalid`, JSON.stringify(permissions), status).lastInsertRowid));
  return { id, token: jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' }) };
}

function addUnit(dealershipId, { stage = 'ready', createdDaysAgo = 0, checkedDaysAgo = null, make = 'Toyota' } = {}) {
  seq += 1;
  return withDb(db => Number(db.prepare(`INSERT INTO units (dealership_id, vin, year, make, model, stage, acquisition_cost, asking_price, created_at, last_age_check_at)
    VALUES (?, ?, 2020, ?, 'Camry', ?, 1000, 15000, datetime('now', ?), ${checkedDaysAgo === null ? 'NULL' : "datetime('now', ?)"})`)
    .run(dealershipId, `TRUTHVIN${String(seq).padStart(9, '0')}`, make, stage, `-${createdDaysAgo} days`, ...(checkedDaysAgo === null ? [] : [`-${checkedDaysAgo} days`])).lastInsertRowid));
}

const VIEW = ['inventory_view'];
const EDIT = ['inventory_view', 'inventory_edit'];
const PRICE = ['inventory_view', 'inventory_edit', 'inventory_pricing'];

test('assignment: valid target succeeds; revoked, cross-dealer, and non-editor requests are refused', async () => {
  const a = await dealer();
  const b = await dealer();
  const unitId = addUnit(a.dealershipId);
  const ann = addUser(a.dealershipId, { permissions: EDIT, name: 'Ann Assignee' });
  const revoked = addUser(a.dealershipId, { permissions: EDIT, status: 'revoked' });
  const other = addUser(b.dealershipId, { permissions: EDIT });
  const viewer = addUser(a.dealershipId, { permissions: VIEW });

  assert.equal((await api(a.token, 'PUT', `/api/inventory/${unitId}/assignment`, { user_id: revoked.id })).status, 400);
  assert.equal((await api(a.token, 'PUT', `/api/inventory/${unitId}/assignment`, { user_id: other.id })).status, 400);
  assert.equal((await api(viewer.token, 'PUT', `/api/inventory/${unitId}/assignment`, { user_id: ann.id })).status, 403);
  assert.equal((await api(b.token, 'PUT', `/api/inventory/${unitId}/assignment`, { user_id: other.id })).status, 404, 'other dealership cannot assign');
  const ok = await api(ann.token, 'PUT', `/api/inventory/${unitId}/assignment`, { user_id: ann.id });
  assert.equal(ok.status, 200);

  const detail = await api(a.token, 'GET', `/api/inventory/${unitId}`);
  assert.deepEqual(detail.body.assignment, { user_id: ann.id, name: 'Ann Assignee', active: true });
  assert.equal(detail.body.assignment_history.length, 1);
  assert.ok(detail.body.activity.some(x => x.action === 'Assigned'));

  const people = await api(a.token, 'GET', '/api/inventory/assignees');
  const ids = people.body.users.map(u => u.id);
  assert.ok(ids.includes(ann.id) && !ids.includes(revoked.id) && !ids.includes(other.id));
  assert.equal((await api(viewer.token, 'GET', '/api/inventory/assignees')).status, 403);
  assert.equal((await api(b.token, 'GET', `/api/inventory/${unitId}`)).status, 404, 'other dealership cannot view');
});

test('dashboard and priorities show assignee, due and escalated state; sold/archived never alert', async () => {
  const a = await dealer();
  const ann = addUser(a.dealershipId, { permissions: EDIT, name: 'Ann Alert' });
  const due = addUnit(a.dealershipId, { createdDaysAgo: 35, make: 'DueMake' });
  const escalated = addUnit(a.dealershipId, { createdDaysAgo: 65, make: 'EscMake' });
  const fresh = addUnit(a.dealershipId, { createdDaysAgo: 100, checkedDaysAgo: 3 });
  const sold = addUnit(a.dealershipId, { stage: 'sold', createdDaysAgo: 200 });
  const archived = addUnit(a.dealershipId, { stage: 'archived', createdDaysAgo: 200 });
  await api(a.token, 'PUT', `/api/inventory/${due}/assignment`, { user_id: ann.id });

  const dash = await api(a.token, 'GET', '/api/dashboard');
  const units = dash.body.alerts.filter(x => x.type === 'unit');
  const byId = Object.fromEntries(units.map(u => [u.id, u]));
  assert.ok(byId[due] && byId[escalated]);
  assert.ok(!byId[fresh] && !byId[sold] && !byId[archived]);
  assert.equal(byId[due].assignee_name, 'Ann Alert');
  assert.equal(byId[due].escalated, false);
  assert.equal(byId[due].overdue_days, 5);
  assert.equal(byId[escalated].escalated, true);
  assert.equal(byId[escalated].assignee_name, null);
  assert.equal(dash.body.metrics.inventory_reviews_escalated, 1);

  const pri = await api(a.token, 'GET', '/api/dashboard/priorities');
  const esc = pri.body.priorities.find(p => p.id === `unit:${escalated}`);
  assert.equal(esc.escalated, true);
  assert.match(esc.title, /^Escalated/);
  const assigned = pri.body.priorities.find(p => p.id === `unit:${due}`);
  assert.equal(assigned.assignee_name, 'Ann Alert');
  assert.ok(!assigned.ai_context.includes('Ann'), 'the assignee never enters the AI context');

  // Revoking the assignee makes the alert show as unassigned.
  withDb(db => db.prepare("UPDATE users SET status = 'revoked' WHERE id = ?").run(ann.id));
  const after = (await api(a.token, 'GET', '/api/dashboard')).body.alerts.find(x => x.type === 'unit' && x.id === due);
  assert.equal(after.assignee_name, null);
});

test('confirm current status resets the clock and resolves escalation; cross-dealer and view-only refused', async () => {
  const a = await dealer();
  const b = await dealer();
  const unitId = addUnit(a.dealershipId, { createdDaysAgo: 70 });
  const viewer = addUser(a.dealershipId, { permissions: VIEW });
  assert.equal((await api(viewer.token, 'POST', `/api/inventory/${unitId}/verify`)).status, 403);
  assert.equal((await api(b.token, 'POST', `/api/inventory/${unitId}/verify`)).status, 404);
  const res = await api(a.token, 'POST', `/api/inventory/${unitId}/verify`);
  assert.equal(res.status, 200);
  assert.equal(res.body.was_escalated, true);
  const dash = await api(a.token, 'GET', '/api/dashboard');
  assert.ok(!dash.body.alerts.some(x => x.type === 'unit' && x.id === unitId));
  const detail = await api(a.token, 'GET', `/api/inventory/${unitId}`);
  assert.ok(detail.body.activity.some(x => x.action === 'Escalation resolved'));
  assert.equal(detail.body.review.due, false);
});

test('existing alert action still confirms status and logs escalation resolution', async () => {
  const a = await dealer();
  const unitId = addUnit(a.dealershipId, { createdDaysAgo: 70 });
  assert.equal((await api(a.token, 'POST', `/api/dashboard/unit-alert/${unitId}/action`, {})).status, 200);
  const detail = await api(a.token, 'GET', `/api/inventory/${unitId}`);
  assert.equal(detail.body.review.due, false);
  assert.ok(detail.body.activity.some(x => x.action === 'Escalation resolved'));
});

test('disposition permissions: edit for non-sale outcomes, pricing for retail sold; history preserved', async () => {
  const a = await dealer();
  const b = await dealer();
  const editor = addUser(a.dealershipId, { permissions: EDIT });
  const pricer = addUser(a.dealershipId, { permissions: PRICE });
  const viewer = addUser(a.dealershipId, { permissions: VIEW });
  const unitId = addUnit(a.dealershipId, { createdDaysAgo: 40 });

  assert.equal((await api(viewer.token, 'POST', `/api/inventory/${unitId}/disposition`, { outcome: 'auction' })).status, 403);
  assert.equal((await api(b.token, 'POST', `/api/inventory/${unitId}/disposition`, { outcome: 'auction' })).status, 404);
  assert.equal((await api(editor.token, 'POST', `/api/inventory/${unitId}/disposition`, { outcome: 'retail_sold', amount: 14000 })).status, 403);
  assert.equal((await api(editor.token, 'POST', `/api/inventory/${unitId}/disposition`, { outcome: 'bogus' })).status, 400);

  const wholesale = await api(editor.token, 'POST', `/api/inventory/${unitId}/disposition`, { outcome: 'wholesale', amount: 9100, destination: 'TruthWholesaleBuyer', note: 'TruthInternalNote' });
  assert.equal(wholesale.status, 201);
  assert.equal(wholesale.body.unit.stage, 'archived');

  const sold = await api(pricer.token, 'POST', `/api/inventory/${unitId}/disposition`, { outcome: 'retail_sold', amount: 14500, disposition_date: '2026-10-01' });
  assert.equal(sold.status, 201);
  assert.equal(sold.body.unit.stage, 'sold');
  assert.equal(sold.body.unit.sold_price, 14500);
  assert.equal((await api(editor.token, 'POST', `/api/inventory/${unitId}/disposition`, { outcome: 'wholesale' })).status, 403, 'a sold unit needs pricing to change');

  const priced = await api(pricer.token, 'GET', `/api/inventory/${unitId}`);
  assert.equal(priced.body.dispositions.length, 2, 'the earlier disposition is preserved');
  assert.ok(priced.body.dispositions[1].superseded_at);
  assert.equal(priced.body.dispositions[1].amount, 9100);
  const unpriced = await api(editor.token, 'GET', `/api/inventory/${unitId}`);
  assert.ok(unpriced.body.dispositions.every(d => !('amount' in d)), 'amounts hidden without pricing');
  assert.ok(withDb(db => db.prepare('SELECT 1 FROM units WHERE id = ?').get(unitId)), 'unit never deleted');
});

test('public showroom never exposes assignment or disposition data', async () => {
  const a = await dealer();
  withDb(db => db.prepare("UPDATE dealerships SET public_site_enabled = 1, public_slug = ? WHERE id = ?").run(`truth-${a.dealershipId}`, a.dealershipId));
  const ann = addUser(a.dealershipId, { permissions: EDIT });
  const ready = addUnit(a.dealershipId);
  const gone = addUnit(a.dealershipId);
  await api(a.token, 'PUT', `/api/inventory/${ready}/assignment`, { user_id: ann.id });
  await api(a.token, 'POST', `/api/inventory/${gone}/disposition`, { outcome: 'auction', amount: 7777, destination: 'PublicLeakProbe', note: 'PublicLeakNote' });
  const pub = await api(null, 'GET', `/api/public/inventory?dealer=truth-${a.dealershipId}`);
  assert.equal(pub.status, 200);
  const ids = pub.body.units.map(u => u.id);
  assert.ok(ids.includes(ready) && !ids.includes(gone), 'disposed unit leaves the showroom through its archived stage');
  for (const probe of ['assigned_user_id', 'PublicLeakProbe', 'PublicLeakNote', '7777', 'disposition', 'review_interval', 'last_age_check_at']) {
    assert.ok(!pub.text.includes(probe), `public response must not include ${probe}`);
  }
  assert.ok(!('inventory_review_interval_days' in (pub.body.dealer || {})));
});

test('dealership review interval: default 30, validated 7-90, settings permission required', async () => {
  const a = await dealer();
  const current = await api(a.token, 'GET', '/api/admin/dealership-settings');
  assert.equal(current.body.dealership.inventory_review_interval_days, 30);
  for (const bad of [6, 91, 14.5, 'abc']) {
    assert.equal((await api(a.token, 'PUT', '/api/admin/dealership-settings', { ...current.body.dealership, inventory_review_interval_days: bad })).status, 400, `interval ${bad}`);
  }
  const saved = await api(a.token, 'PUT', '/api/admin/dealership-settings', { ...current.body.dealership, inventory_review_interval_days: 10 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.dealership.inventory_review_interval_days, 10);
  const kept = await api(a.token, 'PUT', '/api/admin/dealership-settings', { name: current.body.dealership.name });
  assert.equal(kept.body.dealership.inventory_review_interval_days, 10, 'omitting the field keeps the saved interval');

  const unitId = addUnit(a.dealershipId, { createdDaysAgo: 12 });
  const dash = await api(a.token, 'GET', '/api/dashboard');
  const alert = dash.body.alerts.find(x => x.type === 'unit' && x.id === unitId);
  assert.ok(alert, 'a 12-day-old unit is due on a 10-day interval');
  assert.equal(alert.review_interval_days, 10);

  const noSettings = addUser(a.dealershipId, { permissions: EDIT });
  assert.equal((await api(noSettings.token, 'PUT', '/api/admin/dealership-settings', { name: 'x', inventory_review_interval_days: 20 })).status, 403);
});

// --- terminal-stage bypasses are closed ---

test('direct sold/archived transitions are refused everywhere and point to the disposition workflow', async () => {
  const a = await dealer();
  const pricer = addUser(a.dealershipId, { permissions: PRICE });
  const unitId = addUnit(a.dealershipId, { createdDaysAgo: 40 });
  for (const stage of ['sold', 'archived']) {
    const patch = await api(pricer.token, 'PATCH', `/api/inventory/${unitId}/stage`, { stage });
    assert.equal(patch.status, 409, `PATCH ${stage}`);
    assert.equal(patch.body.code, 'disposition_required');
    const alert = await api(pricer.token, 'POST', `/api/dashboard/unit-alert/${unitId}/action`, { stage, sold_price: 9000 });
    assert.equal(alert.status, 409, `alert ${stage}`);
    const created = await api(a.token, 'POST', '/api/inventory', { vin: `NEWTERM${stage.toUpperCase()}00001`.slice(0, 17), year: 2020, make: 'Kia', model: 'Soul', acquisition_cost: 100, stage });
    assert.equal(created.status, 409, `create ${stage}`);
  }
  assert.equal(withDb(db => db.prepare('SELECT stage FROM units WHERE id = ?').get(unitId)).stage, 'ready');
  assert.equal((await api(pricer.token, 'PATCH', `/api/inventory/${unitId}/stage`, { stage: 'recon' })).status, 200, 'non-terminal moves are unchanged');
  assert.equal((await api(pricer.token, 'POST', `/api/dashboard/unit-alert/${unitId}/action`, { stage: 'ready' })).status, 200);
});

test('closing a linked deal records a retail-sold disposition atomically, even without inventory permissions', async () => {
  const a = await dealer();
  const b = await dealer();
  const dealsOnly = addUser(a.dealershipId, { permissions: ['deals_manage', 'deals_view'] });
  const viewer = addUser(a.dealershipId, { permissions: ['deals_view'] });
  const seedDeal = unitId => withDb(db => {
    const customer = Number(db.prepare("INSERT INTO customers (dealership_id, first_name, last_name) VALUES (?, 'Close', 'Probe')").run(a.dealershipId).lastInsertRowid);
    return Number(db.prepare("INSERT INTO deals (dealership_id, customer_id, unit_id, deal_type, status) VALUES (?, ?, ?, 'cash', 'pending')").run(a.dealershipId, customer, unitId).lastInsertRowid);
  });
  const state = (unitId, dealId) => withDb(db => ({
    stage: db.prepare('SELECT stage FROM units WHERE id = ?').get(unitId).stage,
    sold_price: db.prepare('SELECT sold_price FROM units WHERE id = ?').get(unitId).sold_price,
    deal: db.prepare('SELECT status FROM deals WHERE id = ?').get(dealId).status,
    dispositions: db.prepare('SELECT outcome FROM unit_dispositions WHERE unit_id = ?').all(unitId).map(r => r.outcome),
    deals: db.prepare('SELECT COUNT(*) AS n FROM deals WHERE unit_id = ?').get(unitId).n,
  }));

  const u1 = addUnit(a.dealershipId);
  const d1 = seedDeal(u1);
  assert.equal((await api(viewer.token, 'POST', `/api/dashboard/deal-alert/${d1}/action`, { action: 'closed' })).status, 403, 'deals_manage still required');
  assert.equal((await api(b.token, 'POST', `/api/dashboard/deal-alert/${d1}/action`, { action: 'closed' })).status, 404, 'other dealership cannot close it');
  assert.deepEqual(state(u1, d1), { stage: 'ready', sold_price: null, deal: 'pending', dispositions: [], deals: 1 });

  const r1 = await api(dealsOnly.token, 'POST', `/api/dashboard/deal-alert/${d1}/action`, { action: 'closed' });
  assert.equal(r1.status, 200);
  assert.deepEqual(state(u1, d1), { stage: 'sold', sold_price: null, deal: 'closed', dispositions: ['retail_sold'], deals: 1 });
  assert.equal((await api(dealsOnly.token, 'PUT', `/api/inventory/${u1}`, { sold_price: 9000 })).status, 403, 'price edits still need pricing permission');
  assert.equal((await api(dealsOnly.token, 'POST', `/api/inventory/${u1}/disposition`, { outcome: 'retail_sold', amount: 9000 })).status, 403, 'corrections still need inventory permissions');

  // Force the disposition write to fail: neither side may change.
  const u2 = addUnit(a.dealershipId);
  const d2 = seedDeal(u2);
  withDb(db => db.exec(`CREATE TRIGGER fail_disposition_${u2} BEFORE INSERT ON unit_dispositions WHEN NEW.unit_id = ${u2} BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`));
  try {
    const r2 = await api(dealsOnly.token, 'POST', `/api/dashboard/deal-alert/${d2}/action`, { action: 'closed' });
    assert.equal(r2.status, 500);
    assert.deepEqual(state(u2, d2), { stage: 'ready', sold_price: null, deal: 'pending', dispositions: [], deals: 1 });
  } finally {
    withDb(db => db.exec(`DROP TRIGGER IF EXISTS fail_disposition_${u2};`));
  }
});

test('starting a deal never moves an archived vehicle; sale price edits go through the disposition', async () => {
  const a = await dealer();
  const pricer = addUser(a.dealershipId, { permissions: PRICE });
  const archivedId = addUnit(a.dealershipId, { stage: 'archived' });
  await api(a.token, 'POST', '/api/deals', { customer: { name: 'Arch Probe' }, unit_id: archivedId, deal_type: 'cash' });
  assert.equal(withDb(db => db.prepare('SELECT stage FROM units WHERE id = ?').get(archivedId)).stage, 'archived');

  const soldId = addUnit(a.dealershipId);
  await api(pricer.token, 'POST', `/api/inventory/${soldId}/disposition`, { outcome: 'retail_sold', amount: 10000 });
  const edit = await api(pricer.token, 'PUT', `/api/inventory/${soldId}`, { sold_price: 1 });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, 'disposition_required');

  const legacyId = addUnit(a.dealershipId, { stage: 'sold' });
  assert.equal((await api(pricer.token, 'GET', `/api/inventory/${legacyId}`)).status, 200, 'legacy sold units stay readable');
  assert.equal((await api(pricer.token, 'PUT', `/api/inventory/${legacyId}`, { sold_price: 7000 })).status, 200, 'legacy sale price still editable');
});

test('reopening a disposed vehicle reverses the disposition and needs pricing for a sale', async () => {
  const a = await dealer();
  const editor = addUser(a.dealershipId, { permissions: EDIT });
  const pricer = addUser(a.dealershipId, { permissions: PRICE });
  const unitId = addUnit(a.dealershipId);
  await api(pricer.token, 'POST', `/api/inventory/${unitId}/disposition`, { outcome: 'retail_sold', amount: 11000 });
  assert.equal((await api(editor.token, 'PATCH', `/api/inventory/${unitId}/stage`, { stage: 'ready' })).status, 403);
  const reopened = await api(pricer.token, 'PATCH', `/api/inventory/${unitId}/stage`, { stage: 'ready' });
  assert.equal(reopened.status, 200);
  assert.deepEqual([reopened.body.unit.stage, reopened.body.unit.sold_price, reopened.body.unit.sold_at], ['ready', null, null]);
  const detail = await api(pricer.token, 'GET', `/api/inventory/${unitId}`);
  assert.equal(detail.body.dispositions.length, 1);
  assert.ok(detail.body.dispositions[0].superseded_at);
  assert.ok(detail.body.activity.some(x => x.action === 'Disposition reversed'));
  assert.equal(withDb(db => db.prepare('SELECT COUNT(*) AS n FROM platform_sold_units WHERE unit_id = ?').get(unitId)).n, 0);
});

test('reopening legacy sold and archived units clears stale fields and comparables, with pricing still required for a sale', async () => {
  const a = await dealer();
  const editor = addUser(a.dealershipId, { permissions: EDIT });
  const pricer = addUser(a.dealershipId, { permissions: PRICE });
  const legacySold = addUnit(a.dealershipId, { stage: 'sold' });
  const legacyArchived = addUnit(a.dealershipId, { stage: 'archived' });
  withDb(db => {
    db.prepare("UPDATE units SET sold_price = 6000, sold_at = '2026-01-05T00:00:00.000Z' WHERE id = ?").run(legacySold);
    db.prepare("UPDATE units SET archived_at = '2026-02-05T00:00:00.000Z' WHERE id = ?").run(legacyArchived);
    db.prepare("INSERT INTO platform_sold_units (dealership_id, unit_id, sold_price, sold_at) VALUES (?, ?, 6000, '2026-01-05')").run(a.dealershipId, legacySold);
  });
  assert.equal((await api(editor.token, 'PATCH', `/api/inventory/${legacySold}/stage`, { stage: 'ready' })).status, 403);
  const sold = await api(pricer.token, 'PATCH', `/api/inventory/${legacySold}/stage`, { stage: 'ready' });
  assert.equal(sold.status, 200);
  assert.deepEqual([sold.body.unit.stage, sold.body.unit.sold_price, sold.body.unit.sold_at, sold.body.unit.archived_at], ['ready', null, null, null]);
  const archived = await api(editor.token, 'PATCH', `/api/inventory/${legacyArchived}/stage`, { stage: 'recon' });
  assert.equal(archived.status, 200);
  assert.deepEqual([archived.body.unit.stage, archived.body.unit.archived_at], ['recon', null]);
  withDb(db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM platform_sold_units WHERE unit_id = ?').get(legacySold).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unit_dispositions WHERE unit_id IN (?, ?)').get(legacySold, legacyArchived).n, 0, 'no history fabricated');
  });
});

// --- permanent deletion keeps truth history ---

test('permanent delete: refused with assignment or disposition history, allowed without, tenant-scoped', async () => {
  const a = await dealer();
  const b = await dealer();
  const ann = addUser(a.dealershipId, { permissions: EDIT });
  const deleter = addUser(a.dealershipId, { permissions: [...EDIT, 'inventory_delete'] });

  const assigned = addUnit(a.dealershipId);
  await api(a.token, 'PUT', `/api/inventory/${assigned}/assignment`, { user_id: ann.id });
  await api(a.token, 'PUT', `/api/inventory/${assigned}/assignment`, { user_id: null });
  const r1 = await api(deleter.token, 'DELETE', `/api/inventory/${assigned}`);
  assert.equal(r1.status, 409, 'assignment history blocks deletion even after unassigning');
  assert.equal(r1.body.code, 'truth_history_exists');

  const disposed = addUnit(a.dealershipId);
  await api(a.token, 'POST', `/api/inventory/${disposed}/disposition`, { outcome: 'duplicate_error' });
  assert.equal((await api(deleter.token, 'DELETE', `/api/inventory/${disposed}`)).status, 409);

  const plain = addUnit(a.dealershipId);
  assert.equal((await api(b.token, 'DELETE', `/api/inventory/${plain}`)).status, 404, 'cross-dealer delete refused');
  assert.equal((await api(ann.token, 'DELETE', `/api/inventory/${plain}`)).status, 403, 'inventory_delete still required');
  assert.equal((await api(deleter.token, 'DELETE', `/api/inventory/${plain}`)).status, 200);

  withDb(db => {
    for (const id of [assigned, disposed]) assert.ok(db.prepare('SELECT 1 FROM units WHERE id = ?').get(id));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unit_assignments WHERE unit_id NOT IN (SELECT id FROM units)').get().n, 0, 'no orphan assignment rows');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unit_dispositions WHERE unit_id NOT IN (SELECT id FROM units)').get().n, 0, 'no orphan disposition rows');
  });
});
