'use strict';
// Route-level coverage: the dedicated contacts_export permission (with legacy
// compatibility), export audit rows for contacts and inventory, the usage
// summary's permissions and tenant scope, and platform-admin-only
// entitlements.
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
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-usage-route-test-'));
  const port = 7600 + Math.floor(Math.random() * 400);
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
test.after(() => { if (child) child.kill(); fs.rmSync(tmpDataDir, { recursive: true, force: true }); });

async function api(token, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, body: json, text };
}
const withDb = fn => { const db = new Database(path.join(tmpDataDir, 'unitnavigator.db')); try { return fn(db); } finally { db.close(); } };

let seq = 0;
async function dealer() {
  const res = await api(null, 'POST', '/api/auth/demo-login');
  return { token: res.body.token, dealershipId: jwt.decode(res.body.token).dealership_id };
}
function addUser(dealershipId, { permissions = null, version = 1, role = 'staff' } = {}) {
  seq += 1;
  const id = withDb(db => Number(db.prepare(`INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, permissions_version, status, last_login_at)
    VALUES (?, ?, ?, 'x', ?, ?, ?, 'active', datetime('now'))`).run(dealershipId, `Usage ${seq}`, `usage-${seq}-${Date.now()}@example.invalid`, role, permissions && JSON.stringify(permissions), version).lastInsertRowid));
  return { id, token: jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' }) };
}
const audit = id => withDb(db => db.prepare('SELECT export_type, row_count, user_id FROM export_audit WHERE dealership_id = ? ORDER BY id').all(id));

test('contacts export: legacy staff keep access; new exact lists need contacts_export; every export is audited', async () => {
  const a = await dealer();
  const legacyStaff = addUser(a.dealershipId);
  const legacyCustom = addUser(a.dealershipId, { permissions: ['deals_view', 'reports_view'] });
  const newStaff = addUser(a.dealershipId, { permissions: ['deals_view', 'reports_view'], version: 2 });
  const exporter = addUser(a.dealershipId, { permissions: ['contacts_export'], version: 2 });
  assert.equal((await api(legacyStaff.token, 'GET', '/api/deals/export/contacts.csv')).status, 200);
  assert.equal((await api(legacyCustom.token, 'GET', '/api/deals/export/contacts.csv')).status, 200);
  assert.equal((await api(newStaff.token, 'GET', '/api/deals/export/contacts.csv')).status, 403);
  assert.equal((await api(exporter.token, 'GET', '/api/deals/export/contacts.csv')).status, 200);
  const rows = audit(a.dealershipId).filter(r => r.export_type === 'contacts');
  assert.deepEqual(rows.map(r => r.user_id), [legacyStaff.id, legacyCustom.id, exporter.id], 'refused export not audited');
  assert.ok(rows.every(r => r.row_count >= 1));
  assert.equal((await api(a.token, 'GET', '/api/inventory/export')).status, 200);
  assert.ok(audit(a.dealershipId).some(r => r.export_type === 'inventory'));
});

test('saving a user through user management writes an exact (v2) list', async () => {
  const a = await dealer();
  const legacy = addUser(a.dealershipId, { permissions: ['deals_view', 'reports_view'] });
  const saved = await api(a.token, 'PATCH', `/api/admin/dealership-users/${legacy.id}`, { permissions: ['deals_view', 'reports_view'] });
  assert.equal(saved.status, 200);
  assert.ok(!saved.body.user.permissions.includes('contacts_export'));
  assert.equal(withDb(db => db.prepare('SELECT permissions_version FROM users WHERE id = ?').get(legacy.id).permissions_version), 2);
  assert.equal((await api(legacy.token, 'GET', '/api/deals/export/contacts.csv')).status, 403);
});

test('usage summary: dealership admins only, own dealership only', async () => {
  const a = await dealer();
  const b = await dealer();
  const viewer = addUser(a.dealershipId, { permissions: ['deals_view'], version: 2 });
  await api(a.token, 'GET', '/api/deals/export/contacts.csv');
  const s = await api(a.token, 'GET', '/api/admin/usage');
  assert.equal(s.status, 200);
  assert.ok(s.body.exports.length >= 1);
  assert.equal(s.body.entitlements.length, 4);
  assert.equal((await api(viewer.token, 'GET', '/api/admin/usage')).status, 403);
  assert.equal((await api(b.token, 'GET', `/api/admin/usage?dealership_id=${a.dealershipId}`)).status, 403, 'cannot read another dealership');
});

test('entitlements are platform-admin only', async () => {
  const a = await dealer();
  assert.equal((await api(a.token, 'GET', `/api/admin/dealerships/${a.dealershipId}/entitlements`)).status, 403);
  assert.equal((await api(a.token, 'PUT', `/api/admin/dealerships/${a.dealershipId}/entitlements/market_pricing`, { enabled: true })).status, 403);
  const platform = addUser(a.dealershipId, { role: 'super_admin' });
  const set = await api(platform.token, 'PUT', `/api/admin/dealerships/${a.dealershipId}/entitlements/market_pricing`, { enabled: true, note: 'Trial' });
  assert.equal(set.status, 200);
  assert.equal(set.body.entitlements.find(e => e.feature === 'market_pricing').active, true);
  assert.equal((await api(platform.token, 'PUT', `/api/admin/dealerships/${a.dealershipId}/entitlements/bogus`, { enabled: true })).status, 400);
  await api(a.token, 'POST', '/api/auth/demo-clear');
  assert.equal(withDb(db => db.prepare('SELECT (SELECT COUNT(*) FROM export_audit WHERE dealership_id = ?) + (SELECT COUNT(*) FROM dealership_entitlements WHERE dealership_id = ?) AS n').get(a.dealershipId, a.dealershipId).n), 0, 'demo cleanup removes usage rows');
});
