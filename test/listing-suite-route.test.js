'use strict';
// Route-level coverage against a real server with NO OPENAI_API_KEY, so no
// provider is ever contacted: authorization, the ten-unit cap, tenant
// isolation, "suggestions never write", explicit save through the existing
// update route, and the untouched single-vehicle routes.
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
const SECRET_VIN = 'ROUTEVIN0123456XY';
const SECRET_MIN = 6543.21;
const SECRET_COST = 4321.09;

let child;
let baseUrl;
let tmpDataDir;
let admin;      // dealership A, role admin (has inventory_edit)
let adminB;     // dealership B
let viewer;     // dealership A user WITHOUT inventory_edit
let unitsA = [];
let unitB;

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.status) return; } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

const openDb = () => new Database(path.join(tmpDataDir, 'unitnavigator.db'));

async function api(token, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  return { status: res.status, body: json, raw };
}

async function demoDealer() {
  const res = await api(null, 'POST', '/api/auth/demo-login');
  assert.equal(res.status, 200);
  return { token: res.body.token, dealershipId: jwt.decode(res.body.token).dealership_id };
}

function addUnit(db, dealershipId, o = {}) {
  return Number(db.prepare(`
    INSERT INTO units (dealership_id, vin, year, make, model, trim, mileage, asking_price, minimum_price, acquisition_cost, notes, photos)
    VALUES (?, ?, 2020, 'Honda', ?, 'EX', ?, ?, ?, ?, ?, ?)
  `).run(
    dealershipId, o.vin || `${SECRET_VIN.slice(0, 14)}${Math.floor(Math.random() * 900 + 100)}`, o.model || 'Accord',
    o.mileage === undefined ? 41000 : o.mileage, o.asking === undefined ? 15995 : o.asking,
    SECRET_MIN, SECRET_COST, o.notes === undefined ? null : o.notes, o.photos || '["/uploads/units/a.jpg"]',
  ).lastInsertRowid);
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-listing-route-test-'));
  const port = 6900 + Math.floor(Math.random() * 400);
  baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET, NODE_ENV: 'test' };
  delete env.OPENAI_API_KEY; // the whole file runs without a provider key
  child = spawn(process.execPath, ['server.js'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForServer(`${baseUrl}/api/public/dealer`);

  admin = await demoDealer();
  adminB = await demoDealer();

  const db = openDb();
  try {
    unitsA = [
      addUnit(db, admin.dealershipId, { model: 'Accord' }),
      addUnit(db, admin.dealershipId, { model: 'Civic', asking: null, mileage: 0, photos: '[]' }),
      addUnit(db, admin.dealershipId, { model: 'Pilot', notes: 'Hand-written description for the Pilot.' }),
    ];
    unitB = addUnit(db, adminB.dealershipId, { model: 'Camry' });
    const viewerId = Number(db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, status)
      VALUES (?, 'View Only', 'viewer-listing@example.test', ?, 'staff', '["inventory_view"]', 'active')
    `).run(admin.dealershipId, bcrypt.hashSync('x', 4)).lastInsertRowid);
    viewer = { token: jwt.sign({ id: viewerId }, JWT_SECRET, { expiresIn: '1h' }) };
  } finally {
    db.close();
  }
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

const bulk = (token, body) => api(token, 'POST', '/api/inventory/description-suggestions/bulk', body);
const unitsSnapshot = () => {
  const db = openDb();
  try { return JSON.stringify(db.prepare('SELECT * FROM units ORDER BY id').all()); } finally { db.close(); }
};

test('bulk suggestions require authentication and inventory_edit', async () => {
  assert.equal((await bulk(null, { unit_ids: [unitsA[0]] })).status, 401);
  const denied = await bulk(viewer.token, { unit_ids: [unitsA[0]] });
  assert.equal(denied.status, 403);
  assert.equal((await bulk(admin.token, { unit_ids: [unitsA[0]] })).status, 200);
});

test('more than ten units is a 400 and nothing else happens', async () => {
  const eleven = Array.from({ length: 11 }, (_, i) => unitsA[0] + i);
  const res = await bulk(admin.token, { unit_ids: eleven });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /up to 10/);
  assert.equal((await bulk(admin.token, { unit_ids: [] })).status, 400);
  assert.equal((await bulk(admin.token, { unit_ids: unitsA, variant: 'nope' })).status, 400);
});

test('with no API key: 200, a clear not-configured message, warnings, and existing descriptions identified', async () => {
  const res = await bulk(admin.token, { unit_ids: unitsA });
  assert.equal(res.status, 200);
  assert.equal(res.body.ai_unavailable, true);
  assert.equal(res.body.reason, 'not_configured');
  assert.match(res.body.message, /not configured/i);

  const [accord, civic, pilot] = unitsA.map(id => res.body.units.find(u => u.id === id));
  assert.deepEqual(accord.warnings, []);
  assert.deepEqual(civic.warnings.map(w => w.field), ['asking_price', 'mileage', 'photos']);
  assert.equal(pilot.has_description, true);
  assert.equal(pilot.status, 'skipped_existing', 'a unit that already has a description is not touched');
  assert.equal(pilot.current_description, 'Hand-written description for the Pilot.');
  assert.equal(accord.status, 'unavailable');
});

test('tenant isolation: another dealership\'s unit is silently excluded, and its data never appears', async () => {
  const mixed = await bulk(admin.token, { unit_ids: [unitsA[0], unitB] });
  assert.deepEqual(mixed.body.units.map(u => u.id), [unitsA[0]]);
  assert.ok(!mixed.raw.includes('Camry'));

  const onlyForeign = await bulk(admin.token, { unit_ids: [unitB] });
  assert.equal(onlyForeign.status, 200);
  assert.deepEqual(onlyForeign.body.units, []);

  const missing = await bulk(admin.token, { unit_ids: [987654] });
  assert.deepEqual(missing.body, onlyForeign.body, 'a foreign id looks exactly like a nonexistent one');

  const fromB = await bulk(adminB.token, { unit_ids: [unitsA[0], unitB] });
  assert.deepEqual(fromB.body.units.map(u => u.id), [unitB]);
});

test('the response never contains a VIN, cost, minimum price, or tenant metadata', async () => {
  const res = await bulk(admin.token, { unit_ids: unitsA, include_existing: true });
  for (const secret of ['ROUTEVIN', String(SECRET_MIN), String(SECRET_COST), 'dealership_id', 'minimum_price', 'acquisition_cost', '"vin"']) {
    assert.ok(!res.raw.includes(secret), `response must not contain ${secret}`);
  }
});

test('generating suggestions never writes: the units table is unchanged, with or without include_existing', async () => {
  const before = unitsSnapshot();
  await bulk(admin.token, { unit_ids: unitsA });
  await bulk(admin.token, { unit_ids: unitsA, variant: 'facebook', include_existing: true });
  await bulk(admin.token, { unit_ids: [unitB] });
  assert.equal(unitsSnapshot(), before);
});

test('saving is explicit and goes through the existing update route, one unit at a time', async () => {
  const before = JSON.parse(unitsSnapshot());
  const target = unitsA[1];

  const saved = await api(admin.token, 'PUT', `/api/inventory/${target}`, { notes: 'A reviewed, explicitly saved description.' });
  assert.equal(saved.status, 200);

  const after = JSON.parse(unitsSnapshot());
  for (const row of after) {
    const prior = before.find(b => b.id === row.id);
    if (row.id === target) assert.equal(row.notes, 'A reviewed, explicitly saved description.');
    else assert.deepEqual(row, prior, `unit ${row.id} must be untouched`);
  }

  // The update route is still tenant-scoped and permission-checked.
  const foreign = await api(admin.token, 'PUT', `/api/inventory/${unitB}`, { notes: 'hijack' });
  assert.equal(foreign.status, 404);
  assert.notEqual(JSON.parse(unitsSnapshot()).find(u => u.id === unitB).notes, 'hijack');
  assert.equal((await api(viewer.token, 'PUT', `/api/inventory/${unitsA[0]}`, { notes: 'nope' })).status, 403);
});

test('existing single-vehicle routes are unchanged: same status codes and messages', async () => {
  const stateless = await api(admin.token, 'POST', '/api/inventory/description-suggestion', { year: 2020, make: 'Honda', model: 'Accord' });
  assert.equal(stateless.status, 503);
  assert.match(stateless.body.error, /not configured/i);

  const perUnit = await api(admin.token, 'POST', `/api/inventory/${unitsA[0]}/description-suggestion`, {});
  assert.equal(perUnit.status, 503);

  const foreign = await api(admin.token, 'POST', `/api/inventory/${unitB}/description-suggestion`, {});
  assert.equal(foreign.status, 404);
  assert.equal((await api(viewer.token, 'POST', '/api/inventory/description-suggestion', {})).status, 403);
  assert.equal((await api(null, 'POST', '/api/inventory/description-suggestion', {})).status, 401);
});
