'use strict';
// Public showroom hardening: no first-active-dealership fallback, ready-only
// inventory, numeric lookup limited to active + explicitly-enabled
// dealerships, and showrooms that are off by default for new dealerships.
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
const ON_HOST = 'showroom-on.example.test';

let child;
let baseUrl;
let tmpDataDir;
const dealer = {};
const unit = {};

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

function openDb() {
  return new Database(path.join(tmpDataDir, 'unitnavigator.db'));
}

function seed() {
  const db = openDb();
  try {
    const addDealer = db.prepare(`
      INSERT INTO dealerships (name, legal_name, public_slug, public_domain, public_site_enabled, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    dealer.on = Number(addDealer.run('Hardening On Dealer', 'Hardening On Dealer LLC', 'hard-on', ON_HOST, 1, 'active').lastInsertRowid);
    dealer.empty = Number(addDealer.run('Hardening Empty Dealer', 'Hardening Empty Dealer LLC', 'hard-empty', null, 1, 'active').lastInsertRowid);
    dealer.off = Number(addDealer.run('Hardening Off Dealer', 'Hardening Off Dealer LLC', 'hard-off', 'showroom-off.example.test', 0, 'active').lastInsertRowid);
    dealer.nul = Number(addDealer.run('Hardening Null Dealer', 'Hardening Null Dealer LLC', 'hard-null', null, null, 'active').lastInsertRowid);
    dealer.revoked = Number(addDealer.run('Hardening Revoked Dealer', 'Hardening Revoked Dealer LLC', 'hard-revoked', null, 1, 'revoked').lastInsertRowid);

    const addUnit = db.prepare(`
      INSERT INTO units (dealership_id, vin, stock_number, year, make, model, stage, asking_price)
      VALUES (?, ?, ?, 2021, 'Toyota', 'Camry', ?, 18000)
    `);
    const u = (name, dealership, stock, stage) => { unit[name] = Number(addUnit.run(dealership, `HARDVIN${stock}`, stock, stage).lastInsertRowid); };
    u('onReady', dealer.on, 'ON-READY', 'ready');
    u('onRecon', dealer.on, 'ON-RECON', 'recon');
    u('onAcquired', dealer.on, 'ON-AUCTION', 'acquired');
    u('onPending', dealer.on, 'ON-PENDING', 'pending');
    u('emptyRecon', dealer.empty, 'EMPTY-RECON', 'recon');
    u('emptyAcquired', dealer.empty, 'EMPTY-AUCTION', 'acquired');
    u('offReady', dealer.off, 'OFF-READY', 'ready');
    u('nullReady', dealer.nul, 'NULL-READY', 'ready');
    u('revokedReady', dealer.revoked, 'REVOKED-READY', 'ready');
  } finally {
    db.close();
  }
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-showroom-hardening-test-'));
  const port = 5700 + Math.floor(Math.random() * 400);
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(`${baseUrl}/api/public/dealer`);
  seed();
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

async function get(urlPath, headers = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, { headers });
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { /* HTML */ }
  return { status: res.status, body, raw };
}

function assertEmptyShowroom(res, label) {
  assert.equal(res.status, 200, label);
  assert.deepEqual(res.body.units, [], `${label}: must return no units`);
  assert.equal(res.body.dealer, undefined, `${label}: must not identify any dealership`);
  for (const name of ['Hardening', 'hard-on', 'hard-off', 'ON-READY', 'OFF-READY', 'NULL-READY']) {
    assert.ok(!res.raw.includes(name), `${label}: must not mention "${name}"`);
  }
}

test('no dealer selection and no matching host: empty response, no first-active-dealership fallback', async () => {
  // Several active, enabled dealerships exist; the old code served the first.
  assertEmptyShowroom(await get('/api/public/inventory'), 'no selection');
  assertEmptyShowroom(await get('/api/public/inventory', { 'x-forwarded-host': 'unmatched.example.test' }), 'unmatched host');
});

test('missing/unknown dealer: the dealer endpoint returns a generic payload that identifies no one, and detail is a 404', async () => {
  for (const query of ['', '?dealer=does-not-exist', '?dealer=999999']) {
    const res = await get(`/api/public/dealer${query}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.dealer.id, null, `dealer${query}: must not return a real dealership id`);
    assert.equal(res.body.dealer.name, 'Dealer Inventory');
    assert.equal(res.body.dealer.slug, '');
  }
  const detail = await get(`/api/public/inventory/${unit.onReady}`);
  assert.equal(detail.status, 404, 'a unit cannot be fetched without selecting its dealership');
});

test('unknown slug and unknown numeric id return empty', async () => {
  assertEmptyShowroom(await get('/api/public/inventory?dealer=does-not-exist'), 'unknown slug');
  assertEmptyShowroom(await get('/api/public/inventory?dealer=999999'), 'unknown numeric id');
});

test('an explicit dealer selection that does not match never falls through to host matching', async () => {
  assertEmptyShowroom(await get('/api/public/inventory?dealer=nope', { 'x-forwarded-host': ON_HOST }), 'mismatched slug on a valid host');
});

test('an enabled dealership is still served by slug, by matching host, and by numeric id', async () => {
  for (const [label, res] of [
    ['slug', await get('/api/public/inventory?dealer=hard-on')],
    ['host', await get('/api/public/inventory', { 'x-forwarded-host': ON_HOST })],
    ['numeric id', await get(`/api/public/inventory?dealer=${dealer.on}`)],
  ]) {
    assert.equal(res.status, 200, label);
    assert.deepEqual(res.body.units.map(x => x.id), [unit.onReady], `${label}: exactly the ready unit`);
    assert.equal(res.body.dealer.slug, 'hard-on', label);
  }
});

test('disabled, NULL-flag, and non-active dealerships are never served — by slug, numeric id, or host', async () => {
  const cases = [
    ['disabled by slug', '/api/public/inventory?dealer=hard-off'],
    ['disabled by numeric id', `/api/public/inventory?dealer=${dealer.off}`],
    ['NULL flag by slug', '/api/public/inventory?dealer=hard-null'],
    ['NULL flag by numeric id', `/api/public/inventory?dealer=${dealer.nul}`],
    ['revoked by slug', '/api/public/inventory?dealer=hard-revoked'],
    ['revoked by numeric id', `/api/public/inventory?dealer=${dealer.revoked}`],
  ];
  for (const [label, url] of cases) assertEmptyShowroom(await get(url), label);
  assertEmptyShowroom(await get('/api/public/inventory', { 'x-forwarded-host': 'showroom-off.example.test' }), 'disabled dealer by host');

  for (const id of [unit.offReady, unit.nullReady, unit.revokedReady]) {
    const byOwnSlug = await get(`/api/public/inventory/${id}`);
    assert.equal(byOwnSlug.status, 404);
  }
  assert.equal((await get(`/api/public/inventory/${unit.offReady}?dealer=hard-off`)).status, 404, 'a disabled dealership\'s unit detail must 404');
  assert.equal((await get(`/api/public/dealer?dealer=hard-off`)).body.dealer.id, null);
});

test('the share-preview page metadata never names a disabled dealership', async () => {
  const off = await get('/hard-off');
  assert.equal(off.status, 200);
  assert.ok(!off.raw.includes('Hardening Off Dealer'), 'disabled dealer name must not appear in the page metadata');
  const on = await get('/hard-on');
  assert.ok(on.raw.includes('Hardening On Dealer'), 'an enabled dealer still gets its own metadata');
});

test('only ready inventory is published: auction/recon/pending units are never listed or fetchable', async () => {
  const list = await get('/api/public/inventory?dealer=hard-on');
  assert.deepEqual(list.body.units.map(x => x.id), [unit.onReady]);

  for (const hidden of [unit.onRecon, unit.onAcquired, unit.onPending]) {
    assert.equal((await get(`/api/public/inventory/${hidden}?dealer=hard-on`)).status, 404, 'a non-ready unit must not be fetchable by id');
  }
  assert.equal((await get(`/api/public/inventory/${unit.onReady}?dealer=hard-on`)).status, 200);
});

test('an enabled dealership with no ready inventory gets an empty list — the old non-ready fallback is gone', async () => {
  const res = await get('/api/public/inventory?dealer=hard-empty');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.units, []);
  assert.ok(!res.raw.includes('EMPTY-RECON') && !res.raw.includes('EMPTY-AUCTION'));
  assert.equal(res.body.dealer.slug, 'hard-empty', 'the showroom itself still resolves; it simply has nothing ready');
});

test('VIN stays excluded', async () => {
  const res = await get('/api/public/inventory?dealer=hard-on');
  assert.ok(!res.raw.includes('HARDVIN'));
  assert.equal('vin' in res.body.units[0], false);
});

test('a dealership inserted without naming the column is off by default (fresh-database default)', () => {
  const db = openDb();
  try {
    const id = Number(db.prepare("INSERT INTO dealerships (name) VALUES ('Default Off Probe')").run().lastInsertRowid);
    assert.equal(db.prepare('SELECT public_site_enabled AS v FROM dealerships WHERE id = ?').get(id).v, 0);
  } finally {
    db.close();
  }
});

test('a dealership created through the admin API starts with its showroom disabled and serves nothing', async () => {
  const db = openDb();
  let adminId;
  try {
    adminId = Number(db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, status)
      VALUES (NULL, 'Platform Admin', 'platform-admin@example.test', ?, 'super_admin', 'active')
    `).run(bcrypt.hashSync('x', 4)).lastInsertRowid);
  } finally {
    db.close();
  }
  const token = jwt.sign({ id: adminId }, JWT_SECRET, { expiresIn: '1h' });
  const res = await fetch(`${baseUrl}/api/admin/dealerships`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Brand New Showroom Probe', public_slug: 'brand-new-probe' }),
  });
  assert.equal(res.status, 201);
  const { dealership } = await res.json();
  assert.equal(dealership.public_site_enabled, 0, 'new dealerships must not be public until deliberately enabled');
  assertEmptyShowroom(await get('/api/public/inventory?dealer=brand-new-probe'), 'new dealership');
});
