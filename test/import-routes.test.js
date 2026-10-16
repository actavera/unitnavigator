'use strict';
// Route-level coverage for imports against a real server and database. No
// real import is run against production data: everything lives in a
// throwaway data directory with demo dealerships.
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
let sftpRoot;
let dealerA;
let dealerB;
let viewerToken;      // dealership A, no inventory_import
let superAdminToken;

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

const importRows = (dealer, rows, extra = {}) => api(dealer.token, 'POST', '/api/inventory/import', { source: 'CSV import', rows, ...extra });
const unitsOf = async dealer => (await api(dealer.token, 'GET', '/api/inventory')).body.units;
const unitByVin = async (dealer, vin) => (await unitsOf(dealer)).find(u => u.vin === vin);

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-import-route-test-'));
  sftpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-import-sftp-'));
  const port = 7500 + Math.floor(Math.random() * 400);
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET, NODE_ENV: 'test', DEALERCENTER_SFTP_ROOT: sftpRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(`${baseUrl}/api/public/dealer`);

  dealerA = await demoDealer();
  dealerB = await demoDealer();

  const db = openDb();
  try {
    const viewerId = Number(db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, status)
      VALUES (?, 'Viewer', 'import-viewer@example.test', ?, 'staff', '["inventory_view"]', 'active')
    `).run(dealerA.dealershipId, bcrypt.hashSync('x', 4)).lastInsertRowid);
    viewerToken = jwt.sign({ id: viewerId }, JWT_SECRET, { expiresIn: '1h' });
    const superId = Number(db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, status)
      VALUES (NULL, 'Platform Admin', 'import-super@example.test', ?, 'super_admin', 'active')
    `).run(bcrypt.hashSync('x', 4)).lastInsertRowid);
    superAdminToken = jwt.sign({ id: superId }, JWT_SECRET, { expiresIn: '1h' });
    // Route DealerCenter feed lookups for dealership A to a known inbox.
    db.prepare("UPDATE dealerships SET dealercenter_sftp_username = 'dc_test' WHERE id = ?").run(dealerA.dealershipId);
  } finally {
    db.close();
  }
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.rmSync(sftpRoot, { recursive: true, force: true });
});

// --- baseline behavior, pinned (there were no import tests before) ---

test('baseline: rows are created, re-imports update by VIN without duplicating, unidentifiable rows are skipped and reported', async () => {
  const first = await importRows(dealerA, [
    { vin: 'BASEVIN0000000001', year: 2019, make: 'Honda', model: 'Civic', price: 15000 },
    { vin: 'BASEVIN0000000002', year: 2020, make: 'Ford', model: 'F-150', price: 30000 },
    { make: 'Nothing', model: 'Identifiable' },
  ]);
  assert.equal(first.status, 201);
  assert.deepEqual([first.body.created, first.body.updated, first.body.skipped], [2, 0, 1]);
  assert.deepEqual(first.body.errors, [{ row: 3, error: 'Missing VIN or year/make/model' }]);
  assert.equal(typeof first.body.batch_id, 'number');

  const before = (await unitsOf(dealerA)).length;
  const again = await importRows(dealerA, [{ vin: 'BASEVIN0000000001', year: 2019, make: 'Honda', model: 'Civic', price: 14500 }]);
  assert.deepEqual([again.body.created, again.body.updated, again.body.skipped], [0, 1, 0]);
  assert.equal((await unitsOf(dealerA)).length, before, 'no duplicate was created');
  assert.equal((await unitByVin(dealerA, 'BASEVIN0000000001')).asking_price, 14500);
});

// --- re-import protections ---

test('an existing non-empty description is never overwritten by a re-import; an empty one is filled', async () => {
  await importRows(dealerA, [
    { vin: 'NOTEVIN000000001', year: 2018, make: 'Toyota', model: 'Camry', notes: 'First feed note' },
    { vin: 'NOTEVIN000000002', year: 2018, make: 'Toyota', model: 'Corolla' },
  ]);
  const camry = await unitByVin(dealerA, 'NOTEVIN000000001');
  const saved = await api(dealerA.token, 'PUT', `/api/inventory/${camry.id}`, { notes: 'Hand-written dealer description.' });
  assert.equal(saved.status, 200);

  await importRows(dealerA, [
    { vin: 'NOTEVIN000000001', year: 2018, make: 'Toyota', model: 'Camry', notes: 'Second feed note' },
    { vin: 'NOTEVIN000000002', year: 2018, make: 'Toyota', model: 'Corolla', notes: 'Filled from the feed' },
  ]);
  assert.equal((await unitByVin(dealerA, 'NOTEVIN000000001')).notes, 'Hand-written dealer description.');
  assert.equal((await unitByVin(dealerA, 'NOTEVIN000000002')).notes, 'Filled from the feed');

  await importRows(dealerA, [{ vin: 'NOTEVIN000000001', year: 2018, make: 'Toyota', model: 'Camry' }]);
  assert.equal((await unitByVin(dealerA, 'NOTEVIN000000001')).notes, 'Hand-written dealer description.', 'a feed with no notes does not clear it either');
});

test('stage only changes for a recognized feed status; blank or unknown statuses keep the current stage', async () => {
  const vin = 'STAGEVIN00000001';
  const base = { vin, year: 2017, make: 'Nissan', model: 'Altima' };
  await importRows(dealerA, [{ ...base, status: 'Sold' }]);
  assert.equal((await unitByVin(dealerA, vin)).stage, 'sold');

  await importRows(dealerA, [{ ...base }]);
  assert.equal((await unitByVin(dealerA, vin)).stage, 'sold', 'no status keeps the stage');
  await importRows(dealerA, [{ ...base, status: 'Mystery Status' }]);
  assert.equal((await unitByVin(dealerA, vin)).stage, 'sold', 'an unrecognized status keeps the stage');
  await importRows(dealerA, [{ ...base, status: 'Recon' }]);
  assert.equal((await unitByVin(dealerA, vin)).stage, 'recon', 'a recognized status is applied');

  await importRows(dealerA, [{ vin: 'STAGEVIN00000002', year: 2017, make: 'Nissan', model: 'Rogue' }]);
  assert.equal((await unitByVin(dealerA, 'STAGEVIN00000002')).stage, 'ready', 'a brand-new unit still defaults to ready');
});

// --- VIN-less rows ---

test('VIN-less rows: one stock match updates, no match creates, several matches are skipped, no identifier is created with a warning', async () => {
  await importRows(dealerA, [
    { vin: 'STOCKVIN00000001', stock_number: 'S-ONE', year: 2016, make: 'Kia', model: 'Soul', price: 9000 },
    { vin: 'STOCKVIN00000002', stock_number: 'S-DUP', year: 2016, make: 'Kia', model: 'Rio', price: 8000 },
    { vin: 'STOCKVIN00000003', stock_number: 's-dup', year: 2016, make: 'Kia', model: 'Forte', price: 8500 },
  ]);
  const before = (await unitsOf(dealerA)).length;

  const matched = await importRows(dealerA, [{ stock_number: 'S-ONE', year: 2016, make: 'Kia', model: 'Soul', price: 9500 }]);
  assert.deepEqual([matched.body.created, matched.body.updated, matched.body.skipped], [0, 1, 0]);
  assert.equal((await unitByVin(dealerA, 'STOCKVIN00000001')).asking_price, 9500);
  assert.equal((await unitsOf(dealerA)).length, before);

  const fresh = await importRows(dealerA, [{ stock_number: 'S-FRESH', year: 2015, make: 'Mazda', model: 'CX-5' }]);
  assert.deepEqual([fresh.body.created, fresh.body.updated], [1, 0]);

  const ambiguous = await importRows(dealerA, [{ stock_number: 'S-DUP', year: 2016, make: 'Kia', model: 'Rio', price: 1 }]);
  assert.deepEqual([ambiguous.body.created, ambiguous.body.updated, ambiguous.body.skipped], [0, 0, 1]);
  assert.equal(ambiguous.body.issues[0].code, 'ambiguous_stock_match');
  assert.equal((await unitByVin(dealerA, 'STOCKVIN00000002')).asking_price, 8000, 'neither candidate was touched');
  assert.equal((await unitByVin(dealerA, 'STOCKVIN00000003')).asking_price, 8500);

  const noIdentifier = await importRows(dealerA, [{ year: 2014, make: 'Subaru', model: 'Outback' }]);
  assert.equal(noIdentifier.body.created, 1);
  const warning = noIdentifier.body.issues.find(i => i.code === 'no_vin_no_stock');
  assert.ok(warning && warning.severity === 'warning');
  assert.match(warning.message, /duplicated/i);
});

// --- batch recording ---

test('every import is recorded; history shows counts and issues but never prices, costs, or notes', async () => {
  const res = await importRows(dealerA, [
    { vin: 'PRIVVIN000000001', year: 2021, make: 'Audi', model: 'A4', stock_number: 'P-1', price: 41234, cost: 33333, min_price: 29999, notes: 'SECRET-DEALER-NOTE' },
    { stock_number: 'P-2', make: 'Incomplete' },
  ]);
  assert.equal(res.status, 201);
  const detail = await api(dealerA.token, 'GET', `/api/inventory/import/batches/${res.body.batch_id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.batch.status, 'completed_with_errors');
  assert.deepEqual([detail.body.batch.created, detail.body.batch.skipped], [1, 1]);
  assert.equal(detail.body.batch.issues[0].stock_number, 'P-2');

  // The immediate response is as minimal as the stored history: an issue on a
  // VIN-bearing row carries only the last six characters, never the full VIN.
  const withVin = await importRows(dealerA, [
    { vin: 'TAILVIN1111ZZZZZZ', year: 2020, make: 'Ok', model: 'Row', photos: ['http://127.0.0.1:9/x.jpg'] },
  ]);
  const photoIssue = withVin.body.issues.find(i => i.code === 'photo_not_localized');
  assert.ok(photoIssue, 'the row produced a warning that identifies it');
  assert.equal(photoIssue.vin_tail, 'ZZZZZZ');
  assert.ok(!withVin.raw.includes('TAILVIN1111ZZZZZZ'), 'the full VIN is not echoed back');
  for (const secret of ['41234', '33333', '29999', 'SECRET-DEALER-NOTE', 'PRIVVIN000000001']) {
    assert.ok(!detail.raw.includes(secret), `history must not contain ${secret}`);
  }
  const list = await api(dealerA.token, 'GET', '/api/inventory/import/batches');
  assert.ok(list.body.batches.some(b => b.id === res.body.batch_id));
  assert.equal(list.body.retention_days, 180);
  assert.ok(!list.raw.includes('SECRET-DEALER-NOTE'));
});

test('photos that cannot be downloaded import the row and are recorded as warnings', async () => {
  const res = await importRows(dealerA, [
    { vin: 'PHOTOVIN00000001', year: 2020, make: 'Jeep', model: 'Wrangler', photos: ['http://127.0.0.1:9/never-fetched.jpg'] },
  ]);
  assert.equal(res.status, 201);
  assert.equal(res.body.created, 1);
  const warning = res.body.issues.find(i => i.code === 'photo_not_localized');
  assert.ok(warning, 'a photo warning is returned');
  assert.equal(warning.severity, 'warning');
  const detail = await api(dealerA.token, 'GET', `/api/inventory/import/batches/${res.body.batch_id}`);
  assert.equal(detail.body.batch.warning_count, 1);
  assert.equal(detail.body.batch.status, 'completed', 'a warning alone is not an error');
});

// --- retry linkage ---

test('a retry is recorded as a new batch linked to the original; unknown or foreign batch ids are rejected', async () => {
  const first = await importRows(dealerA, [{ stock_number: 'R-1', make: 'Missing', model: 'Year' }]);
  assert.equal(first.body.skipped, 1);
  const retry = await importRows(dealerA, [{ vin: 'RETRYVIN00000001', year: 2018, make: 'Missing', model: 'Year' }], { retry_of: first.body.batch_id });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.created, 1);
  const detail = await api(dealerA.token, 'GET', `/api/inventory/import/batches/${retry.body.batch_id}`);
  assert.equal(detail.body.batch.retry_of, first.body.batch_id);
  const original = await api(dealerA.token, 'GET', `/api/inventory/import/batches/${first.body.batch_id}`);
  assert.equal(original.body.batch.skipped, 1, 'the original batch is never modified');

  assert.equal((await importRows(dealerA, [{ vin: 'X', year: 2000, make: 'a', model: 'b' }], { retry_of: 999999 })).status, 400);
  assert.equal((await importRows(dealerB, [{ vin: 'RETRYVIN00000009', year: 2018, make: 'a', model: 'b' }], { retry_of: first.body.batch_id })).status, 400, "another dealership's batch cannot be retried");
  assert.equal((await importRows(dealerA, [{ vin: 'RETRYVIN00000010', year: 2018, make: 'a', model: 'b' }], { retry_of: 'abc' })).status, 400);
  assert.ok(!(await unitByVin(dealerA, 'RETRYVIN00000010')), 'a rejected retry imports nothing');
});

// --- failure handling ---

test('a database failure returns JSON, rolls back every row, records a failed batch, and the server keeps running', async () => {
  const db = openDb();
  try {
    db.exec("CREATE TRIGGER import_test_explode BEFORE INSERT ON units WHEN NEW.make = 'EXPLODE' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
  } finally {
    db.close();
  }
  const before = (await unitsOf(dealerA)).length;
  const res = await importRows(dealerA, [
    { vin: 'FAILVIN000000001', year: 2020, make: 'Fine', model: 'Row' },
    { vin: 'FAILVIN000000002', year: 2020, make: 'EXPLODE', model: 'Row' },
  ]);
  assert.equal(res.status, 500);
  assert.ok(res.body && res.body.error, 'the response is JSON');
  assert.ok(!res.raw.includes('simulated failure'), 'internal error text is not exposed');
  assert.equal((await unitsOf(dealerA)).length, before, 'the good row was rolled back too');
  assert.ok(!(await unitByVin(dealerA, 'FAILVIN000000001')));

  const batch = await api(dealerA.token, 'GET', `/api/inventory/import/batches/${res.body.batch_id}`);
  assert.equal(batch.body.batch.status, 'failed');
  assert.equal(batch.body.batch.created, 0);

  const db2 = openDb();
  try { db2.exec('DROP TRIGGER import_test_explode'); } finally { db2.close(); }
  const after = await importRows(dealerA, [{ vin: 'FAILVIN000000003', year: 2020, make: 'Fine', model: 'Again' }]);
  assert.equal(after.status, 201, 'the server is still serving imports');
});

// --- permissions and tenancy ---

test('import history requires inventory_import and authentication', async () => {
  assert.equal((await api(null, 'GET', '/api/inventory/import/batches')).status, 401);
  assert.equal((await api(viewerToken, 'GET', '/api/inventory/import/batches')).status, 403);
  assert.equal((await api(viewerToken, 'GET', '/api/inventory/import/batches/1')).status, 403);
  assert.equal((await api(dealerA.token, 'GET', '/api/inventory/import/batches')).status, 200);
  assert.equal((await api(viewerToken, 'POST', '/api/inventory/import', { rows: [{ vin: 'V', year: 2000, make: 'a', model: 'b' }] })).status, 403, 'importing still requires the same permission');
});

test('tenant isolation: another dealership cannot list or open a batch, and a normal admin cannot pass dealership_id', async () => {
  const mine = await importRows(dealerA, [{ vin: 'TENANTVIN0000001', year: 2020, make: 'Tesla', model: 'Model 3' }]);
  const bList = await api(dealerB.token, 'GET', '/api/inventory/import/batches');
  assert.ok(!bList.body.batches.some(b => b.id === mine.body.batch_id));
  assert.equal((await api(dealerB.token, 'GET', `/api/inventory/import/batches/${mine.body.batch_id}`)).status, 404);

  const spoof = await api(dealerB.token, 'GET', `/api/inventory/import/batches?dealership_id=${dealerA.dealershipId}`);
  assert.ok(!spoof.body.batches.some(b => b.id === mine.body.batch_id), 'a dealership_id query param is ignored for normal users');
  const spoofDetail = await api(dealerB.token, 'GET', `/api/inventory/import/batches/${mine.body.batch_id}?dealership_id=${dealerA.dealershipId}`);
  assert.equal(spoofDetail.status, 404);

  const asSuper = await api(superAdminToken, 'GET', `/api/inventory/import/batches?dealership_id=${dealerA.dealershipId}`);
  assert.equal(asSuper.status, 200);
  assert.ok(asSuper.body.batches.some(b => b.id === mine.body.batch_id), 'a super admin can inspect a chosen dealership');
});

// --- DealerCenter feed ---

test('a DealerCenter feed import records a batch with the file name and honors the notes and stage protections', async () => {
  const dir = path.join(sftpRoot, 'dc_test', 'incoming');
  fs.mkdirSync(dir, { recursive: true });
  const header = 'VIN,StockNumber,Year,Make,Model,InventoryStatus,VehicleSaleType,VDPUrl,Price';
  fs.writeFileSync(path.join(dir, 'feed.csv'), [
    header,
    'SFTPVIN000000001,F-1,2019,Chevrolet,Malibu,,Retail,https://example.test/vdp/1,12000',
    'SFTPVIN000000002,F-2,2019,Chevrolet,Equinox,Available,Retail,https://example.test/vdp/2,15000',
  ].join('\n'));

  const preview = await api(dealerA.token, 'POST', '/api/inventory/import/dealercenter-sftp/preview', {});
  assert.equal(preview.status, 200);
  const imported = await api(dealerA.token, 'POST', '/api/inventory/import/dealercenter-sftp/import', {});
  assert.equal(imported.status, 201);
  assert.deepEqual([imported.body.created, imported.body.updated], [2, 0]);
  const batch = await api(dealerA.token, 'GET', `/api/inventory/import/batches/${imported.body.batch_id}`);
  assert.equal(batch.body.batch.kind, 'dealercenter_sftp');
  assert.equal(batch.body.batch.file_name, 'feed.csv');

  // The dealer edits the unit, then the same feed is imported again.
  const malibu = await unitByVin(dealerA, 'SFTPVIN000000001');
  await api(dealerA.token, 'PUT', `/api/inventory/${malibu.id}`, { notes: 'My own description of the Malibu.' });
  const db = openDb();
  try { db.prepare("UPDATE units SET stage = 'sold' WHERE id = ?").run(malibu.id); } finally { db.close(); }

  const again = await api(dealerA.token, 'POST', '/api/inventory/import/dealercenter-sftp/import', {});
  assert.deepEqual([again.body.created, again.body.updated], [0, 2]);
  const after = await unitByVin(dealerA, 'SFTPVIN000000001');
  assert.equal(after.notes, 'My own description of the Malibu.', 'the dealer description survives a feed re-import');
  assert.equal(after.stage, 'sold', 'a blank feed status does not reset the stage');
});

// --- limits and hostile values ---

test('a retry is subject to the same 500-row limit as any import, and rejects before anything is written or recorded', async () => {
  const first = await importRows(dealerA, [{ stock_number: 'LIMIT-1', make: 'No', model: 'Year' }]);
  assert.equal(first.body.skipped, 1);
  const batchesBefore = (await api(dealerA.token, 'GET', '/api/inventory/import/batches?limit=100')).body.batches.length;
  const unitsBefore = (await unitsOf(dealerA)).length;

  const rows = Array.from({ length: 501 }, (_, i) => ({ vin: `LIMITVIN${String(i).padStart(9, '0')}`, year: 2020, make: 'Bulk', model: 'Row' }));
  const tooMany = await importRows(dealerA, rows, { retry_of: first.body.batch_id });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /500/);
  assert.equal((await unitsOf(dealerA)).length, unitsBefore, 'nothing was imported');
  assert.equal((await api(dealerA.token, 'GET', '/api/inventory/import/batches?limit=100')).body.batches.length, batchesBefore, 'no batch was recorded');

  const exactly = await importRows(dealerA, rows.slice(0, 500), { retry_of: first.body.batch_id });
  assert.equal(exactly.status, 201);
  assert.equal(exactly.body.created, 500);
});

test('hostile values are stored and returned as plain data, unmodified, in JSON responses', async () => {
  const hostile = { stock_number: '=HYPERLINK("http://evil.example","x")', make: '<img src=x onerror=alert(1)>', model: '@SUM(1)' };
  const res = await importRows(dealerA, [hostile], { source: '<script>alert(1)</script>' });
  assert.equal(res.status, 201);
  assert.match(res.raw, /^\{/, 'a JSON document, not HTML');
  const issue = res.body.issues.find(i => i.code === 'no_vin_no_stock') || res.body.issues[0];
  assert.equal(issue.stock_number, hostile.stock_number, 'the API does not mangle the value; exports and pages neutralize it where it is used');
  const detail = await api(dealerA.token, 'GET', `/api/inventory/import/batches/${res.body.batch_id}`);
  assert.equal(detail.body.batch.source, '<script>alert(1)</script>');
  const page = await fetch(`${baseUrl}/inventory/import/history`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /html/);
});

// --- cleanup paths ---

test('demo cleanup still works, and removes the dealership\'s import history', async () => {
  const demo = await demoDealer();
  const res = await importRows(demo, [{ vin: 'CLEANVIN00000001', year: 2020, make: 'Honda', model: 'Fit' }]);
  assert.equal(res.status, 201);
  assert.equal((await api(demo.token, 'GET', '/api/inventory/import/batches')).body.batches.length, 1);

  const cleared = await api(demo.token, 'POST', '/api/auth/demo-clear');
  assert.equal(cleared.status, 200);
  const db = openDb();
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_batches WHERE dealership_id = ?').get(demo.dealershipId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_batch_issues WHERE dealership_id = ?').get(demo.dealershipId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dealerships WHERE id = ?').get(demo.dealershipId).n, 0, 'the dealership itself was removed');
  } finally {
    db.close();
  }
});
