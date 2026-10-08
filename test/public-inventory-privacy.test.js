'use strict';
// Regression tests for the unauthenticated showroom API. It previously
// serialized whole `units` rows, publishing vin, minimum_price (the dealer's
// private floor price), costs, stage, dealership_id and timestamps — and
// priced a unit at minimum_price when it had no asking price. These tests
// pin the explicit allowlist, including against a column added to the
// table in the future.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');

// Distinctive sentinel values so a leak anywhere in the raw response text
// (not just under an expected key name) is caught.
const SECRET_VIN = 'SECRETVIN1234567X';
const SECRET_MIN = 8123.77;
const SECRET_COST = 4561.23;
const SECRET_SOURCE = 'SECRET-AUCTION-SOURCE-XYZ';
const SECRET_FUTURE = 'SECRET-FUTURE-COLUMN-VALUE';

const REQUIRED_PUBLIC_KEYS = ['id', 'stock_number', 'year', 'make', 'model', 'trim', 'body_style', 'color', 'mileage', 'asking_price', 'notes', 'photos', 'price'];
const PRIVATE_KEYS = [
  'vin', 'minimum_price', 'sold_price', 'acquisition_cost', 'transport_cost', 'repair_cost', 'repair_items',
  'detail_cost', 'other_cost', 'acquisition_source', 'acquisition_date', 'dealership_id', 'stage',
  'created_at', 'sold_at', 'archived_at', 'future_internal_flag',
];

let child;
let baseUrl;
let tmpDataDir;
let dealerA;
let dealerB;
const ids = {};

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

function seed() {
  const db = new Database(path.join(tmpDataDir, 'unitnavigator.db'));
  try {
    // A column that does not exist in today's schema: proves a future
    // column cannot leak into the public response automatically.
    db.exec('ALTER TABLE units ADD COLUMN future_internal_flag TEXT');

    const addDealer = db.prepare(`
      INSERT INTO dealerships (name, legal_name, public_slug, public_site_enabled, status)
      VALUES (?, ?, ?, 1, 'active')
    `);
    dealerA = Number(addDealer.run('Privacy Dealer A', 'Privacy Dealer A LLC', 'priv-a').lastInsertRowid);
    dealerB = Number(addDealer.run('Privacy Dealer B', 'Privacy Dealer B LLC', 'priv-b').lastInsertRowid);

    const addUnit = db.prepare(`
      INSERT INTO units (
        dealership_id, vin, stock_number, year, make, model, trim, body_style, color, mileage, stage,
        acquisition_cost, transport_cost, repair_cost, detail_cost, other_cost,
        asking_price, minimum_price, sold_price, acquisition_source, acquisition_date, notes, photos,
        archived_at, future_internal_flag
      ) VALUES (?, ?, ?, 2020, 'Honda', 'Accord', 'EX', 'Sedan', 'Blue', 41000, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01', ?, '["/uploads/units/a.jpg"]', ?, ?)
    `);
    const unit = ({ dealership, vin, stock, stage = 'ready', asking, min, notes, archivedAt = null }) =>
      Number(addUnit.run(
        dealership, vin, stock, stage,
        SECRET_COST, SECRET_COST, SECRET_COST, SECRET_COST, SECRET_COST,
        asking, min, SECRET_COST, SECRET_SOURCE, notes, archivedAt, SECRET_FUTURE,
      ).lastInsertRowid);

    ids.readyA = unit({ dealership: dealerA, vin: SECRET_VIN, stock: 'A-100', asking: 15995, min: SECRET_MIN, notes: 'Public description for A' });
    ids.noAskingA = unit({ dealership: dealerA, vin: 'SECRETVIN0000000002', stock: 'A-101', asking: null, min: SECRET_MIN, notes: 'No asking price set' });
    ids.soldA = unit({ dealership: dealerA, vin: 'SECRETVIN0000000003', stock: 'A-102', stage: 'sold', asking: 10000, min: 9000, notes: 'sold' });
    ids.archivedA = unit({ dealership: dealerA, vin: 'SECRETVIN0000000004', stock: 'A-103', asking: 10000, min: 9000, notes: 'archived', archivedAt: '2026-02-01' });
    ids.readyB = unit({ dealership: dealerB, vin: 'SECRETVIN0000000005', stock: 'B-200', asking: 20500, min: 17000, notes: 'Public description for B' });
  } finally {
    db.close();
  }
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-public-privacy-test-'));
  const port = 5200 + Math.floor(Math.random() * 400);
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET: 'test-only-secret-do-not-use-in-prod', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(`${baseUrl}/api/public/dealer`);
  seed();
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

async function getJson(urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`);
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  return { status: res.status, body, raw };
}

function assertNoSecretsInText(raw) {
  for (const secret of [SECRET_VIN, 'SECRETVIN', String(SECRET_MIN), String(SECRET_COST), SECRET_SOURCE, SECRET_FUTURE]) {
    assert.ok(!raw.includes(secret), `response must never contain the private value ${secret}`);
  }
}

test('the showroom list still receives every field it renders, with the right values', async () => {
  const { status, body } = await getJson('/api/public/inventory?dealer=priv-a');
  assert.equal(status, 200);
  const unit = body.units.find(u => u.id === ids.readyA);
  assert.ok(unit, 'a ready unit must be listed');
  for (const key of REQUIRED_PUBLIC_KEYS) {
    assert.ok(key in unit, `public unit must include "${key}" (the showroom reads it)`);
  }
  assert.equal(unit.stock_number, 'A-100');
  assert.equal(unit.year, 2020);
  assert.equal(unit.make, 'Honda');
  assert.equal(unit.model, 'Accord');
  assert.equal(unit.trim, 'EX');
  assert.equal(unit.body_style, 'Sedan');
  assert.equal(unit.color, 'Blue');
  assert.equal(unit.mileage, 41000);
  assert.equal(unit.asking_price, 15995);
  assert.equal(unit.price, 15995);
  assert.equal(unit.notes, 'Public description for A');
  assert.deepEqual(unit.photos, ['/uploads/units/a.jpg']);
});

test('the list exposes exactly the allowlisted keys — nothing more', async () => {
  const { body } = await getJson('/api/public/inventory?dealer=priv-a');
  assert.ok(body.units.length > 0);
  for (const unit of body.units) {
    assert.deepEqual(Object.keys(unit).sort(), [...REQUIRED_PUBLIC_KEYS].sort());
  }
});

test('private fields are absent from the list response, by key and by value', async () => {
  const { body, raw } = await getJson('/api/public/inventory?dealer=priv-a');
  for (const unit of body.units) {
    for (const key of PRIVATE_KEYS) {
      assert.equal(key in unit, false, `list must not include "${key}"`);
    }
  }
  assertNoSecretsInText(raw);
});

test('private fields are absent from the detail response, by key and by value', async () => {
  const { status, body, raw } = await getJson(`/api/public/inventory/${ids.readyA}?dealer=priv-a`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.unit).sort(), [...REQUIRED_PUBLIC_KEYS].sort());
  for (const key of PRIVATE_KEYS) assert.equal(key in body.unit, false, `detail must not include "${key}"`);
  assertNoSecretsInText(raw);
});

test('a column added to the units table in the future cannot leak automatically', async () => {
  // future_internal_flag was added to the table (and populated) in seed().
  const list = await getJson('/api/public/inventory?dealer=priv-a');
  const detail = await getJson(`/api/public/inventory/${ids.readyA}?dealer=priv-a`);
  assert.ok(!list.raw.includes(SECRET_FUTURE));
  assert.ok(!detail.raw.includes(SECRET_FUTURE));
  assert.equal('future_internal_flag' in list.body.units[0], false);

  // And at the serializer itself: any extra key on a row is dropped.
  // Requiring the router opens the database, so point it at this test's own
  // isolated directory first (never the repo's real data/ directory).
  const savedDataDir = process.env.UNITNAV_DATA_DIR;
  process.env.UNITNAV_DATA_DIR = tmpDataDir;
  let publicRouter;
  try {
    delete require.cache[require.resolve('../database')];
    delete require.cache[require.resolve('../routes/public')];
    publicRouter = require('../routes/public');
  } finally {
    if (savedDataDir === undefined) delete process.env.UNITNAV_DATA_DIR;
    else process.env.UNITNAV_DATA_DIR = savedDataDir;
  }
  const mapped = publicRouter.mapUnit({
    id: 1, stock_number: 'S', year: 2020, make: 'M', model: 'X', trim: null, body_style: null, color: null, mileage: 1,
    asking_price: 100, notes: null, photos: '[]',
    vin: 'V', minimum_price: 50, brand_new_private_column: 'leak', dealership_id: 9,
  });
  assert.deepEqual(Object.keys(mapped).sort(), [...REQUIRED_PUBLIC_KEYS].sort());
  assert.equal(mapped.price, 100);
});

test('a unit with no asking price is never priced at its private minimum price', async () => {
  const { body, raw } = await getJson('/api/public/inventory?dealer=priv-a');
  const unit = body.units.find(u => u.id === ids.noAskingA);
  assert.ok(unit);
  assert.equal(unit.price, null, 'price must be null, not the minimum price');
  assert.equal(unit.asking_price, null);
  assert.ok(!raw.includes(String(SECRET_MIN)));
});

test('public showroom scoping is intact: each dealership sees only its own available units', async () => {
  const a = await getJson('/api/public/inventory?dealer=priv-a');
  const b = await getJson('/api/public/inventory?dealer=priv-b');
  const aIds = a.body.units.map(u => u.id);
  const bIds = b.body.units.map(u => u.id);
  assert.deepEqual(aIds.sort(), [ids.readyA, ids.noAskingA].sort(), 'A lists its two available units only (no sold, archived, or B units)');
  assert.deepEqual(bIds, [ids.readyB]);

  const crossRead = await getJson(`/api/public/inventory/${ids.readyB}?dealer=priv-a`);
  assert.equal(crossRead.status, 404, "dealer A's showroom must not serve dealer B's unit");
  for (const hidden of [ids.soldA, ids.archivedA]) {
    const res = await getJson(`/api/public/inventory/${hidden}?dealer=priv-a`);
    assert.equal(res.status, 404, 'sold and archived units must not be served');
  }
});

test('the public dealer payload exposes only its explicit allowlist of keys', async () => {
  const { body } = await getJson('/api/public/dealer?dealer=priv-a');
  assert.deepEqual(
    Object.keys(body.dealer).sort(),
    ['address', 'apr_options', 'display_name', 'email', 'id', 'logo_url', 'name', 'phone', 'public_domain', 'slug', 'website'].sort(),
  );
});
