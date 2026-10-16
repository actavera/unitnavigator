'use strict';
// Service-level coverage for import history: what is recorded, what is
// deliberately NOT recorded, the issue cap, retention, and tenant scoping.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const history = require('../services/importHistory');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);`);
  db.exec(history.SCHEMA_SQL);
  db.prepare("INSERT INTO users (id, name) VALUES (7, 'Pat Importer')").run();
  return db;
}

const record = (db, overrides = {}) => history.recordBatch(db, {
  dealershipId: 1, userId: 7, kind: 'csv', source: 'CSV import', status: 'completed', totalRows: 3,
  created: 2, updated: 1, skipped: 0, issues: [], ...overrides,
});

test('records a batch with counts, who ran it, and a status', () => {
  const db = makeDb();
  const id = record(db, { status: 'completed_with_errors', skipped: 1, issues: [{ row_number: 3, severity: 'error', code: 'missing_identity', message: 'Missing VIN or year/make/model' }] });
  const batch = history.getBatch(db, 1, id);
  assert.equal(batch.imported_by, 'Pat Importer');
  assert.deepEqual([batch.created, batch.updated, batch.skipped, batch.total_rows], [2, 1, 1, 3]);
  assert.equal(batch.status, 'completed_with_errors');
  assert.equal(batch.error_count, 1);
  assert.equal(batch.issues.length, 1);
});

test('only a minimal identifier is stored for an issue: stock number, last six VIN characters, and a vehicle label', () => {
  const db = makeDb();
  const id = record(db, {
    issues: [{
      row_number: 2, severity: 'error', code: 'missing_identity', message: 'x',
      stock_number: 'A-100', vin_tail: '1HGCM82633A004352', vehicle: '2003 Honda Accord',
      // Anything extra a caller might pass must be ignored, never stored.
      asking_price: 18999, acquisition_cost: 12000, minimum_price: 9000, notes: 'private', vin: '1HGCM82633A004352',
    }],
  });
  const issue = history.getBatch(db, 1, id).issues[0];
  assert.deepEqual(Object.keys(issue).sort(), ['code', 'message', 'row_number', 'severity', 'stock_number', 'vehicle', 'vin_tail']);
  assert.equal(issue.vin_tail, '004352');
  assert.equal(issue.stock_number, 'A-100');
  const raw = JSON.stringify(db.prepare('SELECT * FROM import_batch_issues').all()) + JSON.stringify(db.prepare('SELECT * FROM import_batches').all());
  for (const secret of ['18999', '12000', '9000', 'private', '1HGCM82633A004352']) {
    assert.ok(!raw.includes(secret), `${secret} must never be stored`);
  }
});

test('the issue cap keeps errors before warnings and still counts everything', () => {
  const db = makeDb();
  const issues = [];
  for (let i = 1; i <= 80; i += 1) issues.push({ row_number: i, severity: 'warning', code: 'photo_not_localized', message: 'w' });
  for (let i = 81; i <= 150; i += 1) issues.push({ row_number: i, severity: 'error', code: 'missing_identity', message: 'e' });
  const id = record(db, { status: 'completed_with_errors', skipped: 70, issues });

  const batch = history.getBatch(db, 1, id);
  assert.equal(batch.issues.length, history.MAX_ISSUES_PER_BATCH);
  assert.equal(batch.error_count, 70);
  assert.equal(batch.warning_count, 80);
  assert.equal(batch.issues_truncated, 1);
  assert.equal(batch.issues.filter(i => i.severity === 'error').length, 70, 'no failed row is dropped in favor of a warning');
  assert.equal(batch.issues.filter(i => i.severity === 'warning').length, 30);
  assert.equal(history.capIssues(issues).length, history.MAX_ISSUES_PER_BATCH);
});

test('batches older than the retention window are pruned for that dealership only, on the next write', () => {
  const db = makeDb();
  const old = record(db, { issues: [{ row_number: 1, severity: 'error', code: 'c', message: 'm' }] });
  const otherOld = record(db, { dealershipId: 2 });
  const recent = record(db);
  db.prepare("UPDATE import_batches SET created_at = datetime('now', '-181 days') WHERE id IN (?, ?)").run(old, otherOld);

  record(db); // a new write for dealership 1 prunes dealership 1 only
  assert.equal(history.getBatch(db, 1, old), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_batch_issues WHERE batch_id = ?').get(old).n, 0, 'its issues go with it');
  assert.ok(history.getBatch(db, 1, recent), 'recent history is kept');
  assert.ok(db.prepare('SELECT 1 FROM import_batches WHERE id = ?').get(otherOld), 'another dealership is not touched by this prune');
  assert.equal(history.RETENTION_DAYS, 180);

  db.prepare("UPDATE import_batches SET created_at = datetime('now', '-179 days') WHERE id = ?").run(recent);
  record(db);
  assert.ok(history.getBatch(db, 1, recent), 'a batch just inside the window survives');
});

test('lists are newest first, paged, scoped to the dealership, and detail is tenant-isolated', () => {
  const db = makeDb();
  const a1 = record(db);
  const a2 = record(db);
  const b1 = record(db, { dealershipId: 2 });

  assert.deepEqual(history.listBatches(db, 1).map(b => b.id), [a2, a1]);
  assert.deepEqual(history.listBatches(db, 2).map(b => b.id), [b1]);
  assert.deepEqual(history.listBatches(db, 1, { before: a2 }).map(b => b.id), [a1]);
  assert.equal(history.listBatches(db, 1, { limit: 1 }).length, 1);
  assert.equal(history.listBatches(db, 1, { limit: 100000 }).length, 2, 'the limit is capped');

  assert.equal(history.getBatch(db, 1, b1), null, "dealership 1 cannot read dealership 2's batch");
  assert.equal(history.getBatch(db, 2, a1), null);
  assert.equal(history.batchExists(db, 1, a1), true);
  assert.equal(history.batchExists(db, 1, b1), false);
  for (const bad of ['abc', -1, 0, null, undefined, 1.5, '1 OR 1=1']) {
    assert.equal(history.getBatch(db, 1, bad), null, String(bad));
    assert.equal(history.batchExists(db, 1, bad), false, String(bad));
  }
});

test('invalid kinds and statuses are rejected, and deleting a dealership removes its history', () => {
  const db = makeDb();
  assert.throws(() => record(db, { kind: 'nope' }), /Unknown import kind/);
  assert.throws(() => record(db, { status: 'nope' }), /Unknown import status/);

  const id = record(db, { issues: [{ row_number: 1, severity: 'error', code: 'c', message: 'm' }] });
  const other = record(db, { dealershipId: 2 });
  history.deleteForDealership(db, 1);
  assert.equal(history.getBatch(db, 1, id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_batch_issues WHERE dealership_id = 1').get().n, 0);
  assert.ok(history.getBatch(db, 2, other));
});

test('the schema has no foreign keys, so user and dealership deletes can never be blocked by history', () => {
  const db = makeDb();
  db.pragma('foreign_keys = ON');
  const id = record(db, { userId: 7 });
  db.prepare('DELETE FROM users WHERE id = 7').run(); // would throw if user_id were a foreign key
  assert.equal(history.getBatch(db, 1, id).imported_by, null, 'history survives the user being deleted');
  assert.deepEqual(db.prepare("PRAGMA foreign_key_list('import_batches')").all(), []);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_list('import_batch_issues')").all(), []);
});
