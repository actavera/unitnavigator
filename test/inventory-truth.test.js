'use strict';
// Service-level coverage for inventory assignment, review scheduling,
// escalation, and structured disposition (services/inventoryTruth.js), on an
// in-memory database with the same tables the service touches.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const truth = require('../services/inventoryTruth');

const DAY = 86400000;
const NOW = Date.parse('2026-10-17T12:00:00Z');
const daysAgo = n => new Date(NOW - n * DAY).toISOString();

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dealerships (id INTEGER PRIMARY KEY, name TEXT, zip TEXT, inventory_review_interval_days INTEGER DEFAULT 30);
    CREATE TABLE users (id INTEGER PRIMARY KEY, dealership_id INTEGER, name TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE units (
      id INTEGER PRIMARY KEY, dealership_id INTEGER, vin TEXT, stage TEXT DEFAULT 'ready',
      year INTEGER, make TEXT, model TEXT, trim TEXT, mileage INTEGER, repair_cost REAL, asking_price REAL,
      sold_price REAL, sold_at TEXT, archived_at TEXT, created_at TEXT, last_age_check_at TEXT, assigned_user_id INTEGER
    );
    CREATE TABLE platform_sold_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, unit_id INTEGER NOT NULL UNIQUE,
      year INTEGER, make TEXT, model TEXT, trim TEXT, mileage INTEGER DEFAULT 0, recon_cost REAL DEFAULT 0,
      final_listing_price REAL, sold_price REAL, market_zip TEXT, sold_at TEXT, days_in_inventory INTEGER,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, entity_type TEXT, entity_id INTEGER, action TEXT, note TEXT, user_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
  `);
  db.exec(truth.SCHEMA_SQL);
  db.prepare("INSERT INTO dealerships (id, name) VALUES (1, 'A Motors'), (2, 'B Motors')").run();
  db.prepare("INSERT INTO users (id, dealership_id, name, status) VALUES (10, 1, 'Ann', 'active'), (11, 1, 'Ray Revoked', 'revoked'), (20, 2, 'Bob Other', 'active')").run();
  return db;
}

function addUnit(db, { id, dealership = 1, stage = 'ready', created = 0, checked = null }) {
  db.prepare('INSERT INTO units (id, dealership_id, vin, stage, created_at, last_age_check_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, dealership, `VIN${id}`, stage, daysAgo(created), checked === null ? null : daysAgo(checked));
  return db.prepare('SELECT * FROM units WHERE id = ?').get(id);
}

const logs = (db, unitId) => db.prepare("SELECT action, note FROM activity_logs WHERE entity_type = 'unit' AND entity_id = ? ORDER BY id").all(unitId);

// --- review schedule ---

test('default interval is 30 days and matches the previous aging behavior', () => {
  const db = freshDb();
  assert.equal(truth.reviewInterval(db, 1), 30);
  assert.equal(truth.reviewState(addUnit(db, { id: 1, created: 29 }), 30, NOW).due, false);
  assert.equal(truth.reviewState(addUnit(db, { id: 2, created: 30 }), 30, NOW).due, true);
});

test('a custom interval is honoured; out-of-range or missing values fall back to 30', () => {
  const db = freshDb();
  db.prepare('UPDATE dealerships SET inventory_review_interval_days = 7 WHERE id = 1').run();
  assert.equal(truth.reviewInterval(db, 1), 7);
  assert.equal(truth.reviewState(addUnit(db, { id: 1, created: 8 }), 7, NOW).due, true);
  for (const bad of [null, 0, 6, 91, 14.5, 'x']) {
    db.prepare('UPDATE dealerships SET inventory_review_interval_days = ? WHERE id = 1').run(bad);
    assert.equal(truth.reviewInterval(db, 1), 30, `interval ${bad} must fall back`);
  }
  assert.equal(truth.validInterval(7) && truth.validInterval(90), true);
  assert.equal(truth.validInterval(6) || truth.validInterval(91), false);
});

test('reviews recur: due counts from the most recent verification, not creation', () => {
  const db = freshDb();
  const recentlyChecked = addUnit(db, { id: 1, created: 200, checked: 10 });
  assert.equal(truth.reviewState(recentlyChecked, 30, NOW).due, false, 'checked 10 days ago is not due');
  const checkedLongAgo = addUnit(db, { id: 2, created: 200, checked: 31 });
  assert.equal(truth.reviewState(checkedLongAgo, 30, NOW).due, true, 'a later interval comes due again');
});

test('existing last_age_check_at data keeps working (SQLite and ISO timestamps)', () => {
  const sqliteStyle = { stage: 'ready', created_at: '2026-01-01 00:00:00', last_age_check_at: '2026-10-10 12:00:00' };
  assert.equal(truth.reviewState(sqliteStyle, 30, NOW).days_since_review, 7);
  const isoStyle = { stage: 'ready', created_at: '2026-01-01T00:00:00.000Z', last_age_check_at: '2026-09-01T12:00:00.000Z' };
  assert.equal(truth.reviewState(isoStyle, 30, NOW).due, true);
});

test('escalation is deterministic: ignored for another full interval', () => {
  const db = freshDb();
  const at = n => truth.reviewState(addUnit(db, { id: 100 + n, created: n }), 30, NOW);
  assert.deepEqual([at(29).escalated, at(30).escalated, at(59).escalated, at(60).escalated], [false, false, false, true]);
  assert.equal(at(45).overdue_days, 15);
  assert.equal(truth.reviewState(addUnit(db, { id: 9, created: 20 }), 10, NOW).escalated, true, 'uses the configured interval');
});

test('sold and archived units never come due', () => {
  const db = freshDb();
  assert.equal(truth.reviewState(addUnit(db, { id: 1, stage: 'sold', created: 400 }), 30, NOW).due, false);
  assert.equal(truth.reviewState(addUnit(db, { id: 2, stage: 'archived', created: 400 }), 30, NOW).due, false);
});

test('confirming current status resets the clock and logs escalation resolution only when escalated', () => {
  const db = freshDb();
  addUnit(db, { id: 1, created: 70 });
  const result = truth.verifyUnit(db, { dealershipId: 1, unitId: 1, actorId: 10, now: NOW });
  assert.equal(result.was_escalated, true);
  const after = db.prepare('SELECT * FROM units WHERE id = 1').get();
  assert.equal(truth.reviewState(after, 30, NOW).due, false);
  assert.deepEqual(logs(db, 1).map(l => l.action), ['Inventory verified', 'Escalation resolved']);

  addUnit(db, { id: 2, created: 35 });
  truth.verifyUnit(db, { dealershipId: 1, unitId: 2, actorId: 10, now: NOW });
  assert.deepEqual(logs(db, 2).map(l => l.action), ['Inventory verified']);

  addUnit(db, { id: 3, stage: 'sold', created: 90 });
  assert.throws(() => truth.verifyUnit(db, { dealershipId: 1, unitId: 3, actorId: 10, now: NOW }), e => e.statusCode === 409);
  assert.throws(() => truth.verifyUnit(db, { dealershipId: 2, unitId: 1, actorId: 20, now: NOW }), e => e.statusCode === 404, 'another dealership cannot verify');
});

// --- assignment ---

test('assigns an active employee of the same dealership and records history', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  assert.equal(truth.assignUnit(db, { dealershipId: 1, unitId: 1, userId: 10, actorId: 10 }).changed, true);
  assert.equal(db.prepare('SELECT assigned_user_id FROM units WHERE id = 1').get().assigned_user_id, 10);
  assert.equal(truth.assignUnit(db, { dealershipId: 1, unitId: 1, userId: 10, actorId: 10 }).changed, false, 'no-op reassignment adds no history');
  truth.assignUnit(db, { dealershipId: 1, unitId: 1, userId: null, actorId: 10 });
  const history = db.prepare('SELECT previous_user_id, new_user_id, actor_user_id, created_at FROM unit_assignments WHERE unit_id = 1 ORDER BY id').all();
  assert.deepEqual(history.map(h => [h.previous_user_id, h.new_user_id, h.actor_user_id]), [[null, 10, 10], [10, null, 10]]);
  assert.ok(history.every(h => h.created_at));
  assert.deepEqual(logs(db, 1).map(l => `${l.action}: ${l.note}`), ['Assigned: Unassigned → Ann', 'Unassigned: Ann → Unassigned']);
});

test('rejects revoked, other-dealership, unknown, and malformed assignment targets', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  for (const userId of [11, 20, 999, 'abc', -1, 1.5]) {
    assert.throws(() => truth.assignUnit(db, { dealershipId: 1, unitId: 1, userId, actorId: 10 }), e => e.statusCode === 400, `target ${userId}`);
  }
  assert.equal(db.prepare('SELECT assigned_user_id FROM units WHERE id = 1').get().assigned_user_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unit_assignments').get().n, 0);
  assert.throws(() => truth.assignUnit(db, { dealershipId: 2, unitId: 1, userId: 20, actorId: 20 }), e => e.statusCode === 404, 'cannot assign another dealership\'s unit');
  addUnit(db, { id: 2, stage: 'archived' });
  assert.throws(() => truth.assignUnit(db, { dealershipId: 1, unitId: 2, userId: 10, actorId: 10 }), e => e.statusCode === 409);
  assert.deepEqual(truth.assignableUsers(db, 1).map(u => u.id), [10], 'only active same-dealership users are offered');
});

// --- disposition ---

const OUTCOMES = Object.keys(truth.DISPOSITIONS);

test('every outcome is recorded with structured fields; retail sold uses sold, others archive', () => {
  const db = freshDb();
  OUTCOMES.forEach((outcome, i) => {
    const id = 200 + i;
    addUnit(db, { id, created: 40 });
    const body = { outcome, disposition_date: '2026-10-15', destination: outcome === 'duplicate_error' ? undefined : 'Dest Co', note: 'internal' };
    if (outcome !== 'duplicate_error') body.amount = 1234.567;
    truth.recordDisposition(db, { dealershipId: 1, unitId: id, actorId: 10, body, canPrice: true, now: NOW });
    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(id);
    const row = db.prepare('SELECT * FROM unit_dispositions WHERE unit_id = ?').get(id);
    assert.equal(unit.stage, outcome === 'retail_sold' ? 'sold' : 'archived', outcome);
    assert.equal(row.outcome, outcome);
    assert.equal(row.disposition_date, '2026-10-15');
    assert.equal(row.amount, outcome === 'duplicate_error' ? null : 1234.57);
    assert.equal(row.actor_user_id, 10);
    assert.equal(row.previous_stage, 'ready');
    assert.ok(row.created_at);
    if (outcome === 'retail_sold') assert.equal(unit.sold_price, 1234.57);
    assert.ok(db.prepare('SELECT 1 FROM units WHERE id = ?').get(id), 'never deleted');
    assert.equal(truth.reviewState(unit, 30, NOW).due, false, 'disposed units never alert');
  });
});

test('validates outcome, date, amount, and text inputs', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  const bad = [
    { outcome: 'stolen' },
    { outcome: 'wholesale', disposition_date: '2026-13-01' },
    { outcome: 'wholesale', disposition_date: '2030-01-01' },
    { outcome: 'wholesale', amount: -5 },
    { outcome: 'wholesale', amount: 'lots' },
    { outcome: 'duplicate_error', amount: 100 },
  ];
  for (const body of bad) {
    assert.throws(() => truth.recordDisposition(db, { dealershipId: 1, unitId: 1, actorId: 10, body, canPrice: true, now: NOW }), e => e.statusCode === 400, JSON.stringify(body));
  }
  assert.equal(db.prepare('SELECT stage FROM units WHERE id = 1').get().stage, 'ready', 'rejected input changes nothing');
  truth.recordDisposition(db, { dealershipId: 1, unitId: 1, actorId: 10, body: { outcome: 'auction', destination: 'x'.repeat(500) }, canPrice: false, now: NOW });
  assert.equal(db.prepare('SELECT destination FROM unit_dispositions').get().destination.length, 120);
});

test('retail sold, or changing an already-sold unit, requires pricing permission', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  assert.throws(() => truth.recordDisposition(db, { dealershipId: 1, unitId: 1, actorId: 10, body: { outcome: 'retail_sold', amount: 5000 }, canPrice: false, now: NOW }), e => e.statusCode === 403);
  truth.recordDisposition(db, { dealershipId: 1, unitId: 1, actorId: 10, body: { outcome: 'wholesale', amount: 3000 }, canPrice: false, now: NOW });
  addUnit(db, { id: 2, stage: 'sold' });
  assert.throws(() => truth.recordDisposition(db, { dealershipId: 1, unitId: 2, actorId: 10, body: { outcome: 'wholesale' }, canPrice: false, now: NOW }), e => e.statusCode === 403);
  assert.throws(() => truth.recordDisposition(db, { dealershipId: 2, unitId: 1, actorId: 20, body: { outcome: 'auction' }, canPrice: true, now: NOW }), e => e.statusCode === 404, 'other dealership');
});

test('a correction supersedes but preserves the earlier disposition', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  const first = truth.recordDisposition(db, { dealershipId: 1, unitId: 1, actorId: 10, body: { outcome: 'auction', destination: 'Manheim' }, canPrice: true, now: NOW });
  const second = truth.recordDisposition(db, { dealershipId: 1, unitId: 1, actorId: 10, body: { outcome: 'retail_sold', amount: 9000 }, canPrice: true, now: NOW + 1000 });
  assert.equal(second.superseded, first.id);
  const rows = db.prepare('SELECT id, outcome, superseded_at, superseded_by FROM unit_dispositions ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].outcome, 'auction');
  assert.equal(rows[0].superseded_by, second.id);
  assert.ok(rows[0].superseded_at);
  assert.equal(rows[1].superseded_at, null);
  assert.equal(db.prepare('SELECT stage, archived_at FROM units WHERE id = 1').get().stage, 'sold');
  assert.deepEqual(logs(db, 1).map(l => l.action), ['Disposition recorded', 'Disposition corrected']);
  assert.ok(logs(db, 1).every(l => !/9000|9,000/.test(l.note)), 'amounts never go into the activity timeline');
});

test('history hides amounts from users without pricing permission', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  truth.recordDisposition(db, { dealershipId: 1, unitId: 1, actorId: 10, body: { outcome: 'wholesale', amount: 4100 }, canPrice: true, now: NOW });
  assert.equal(truth.unitHistory(db, { dealershipId: 1, unitId: 1, canPrice: true }).dispositions[0].amount, 4100);
  assert.ok(!('amount' in truth.unitHistory(db, { dealershipId: 1, unitId: 1, canPrice: false }).dispositions[0]));
  assert.equal(truth.unitHistory(db, { dealershipId: 2, unitId: 1, canPrice: true }).dispositions.length, 0, 'tenant scoped');
});

// --- authoritative corrections and pricing comparables ---

const unitRow = (db, id) => db.prepare('SELECT stage, sold_at, sold_price, archived_at FROM units WHERE id = ?').get(id);
const comparable = (db, id) => db.prepare('SELECT sold_price, sold_at FROM platform_sold_units WHERE unit_id = ?').get(id);
const dispose = (db, id, body, at = NOW) => truth.recordDisposition(db, { dealershipId: 1, unitId: id, actorId: 10, body, canPrice: true, now: at });

test('wholesale -> retail sold: sale fields set from the disposition, archive cleared, comparable created', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  dispose(db, 1, { outcome: 'wholesale', amount: 7000, disposition_date: '2026-10-01' });
  assert.deepEqual(unitRow(db, 1), { stage: 'archived', sold_at: null, sold_price: null, archived_at: '2026-10-01T00:00:00.000Z' });
  assert.equal(comparable(db, 1), undefined);
  dispose(db, 1, { outcome: 'retail_sold', amount: 12500, disposition_date: '2026-10-05' }, NOW + 1000);
  assert.deepEqual(unitRow(db, 1), { stage: 'sold', sold_at: '2026-10-05T00:00:00.000Z', sold_price: 12500, archived_at: null });
  assert.deepEqual(comparable(db, 1), { sold_price: 12500, sold_at: '2026-10-05T00:00:00.000Z' });
});

test('retail sold -> wholesale: stale sale fields cleared and the comparable removed', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  dispose(db, 1, { outcome: 'retail_sold', amount: 15000, disposition_date: '2026-10-02' });
  assert.ok(comparable(db, 1));
  dispose(db, 1, { outcome: 'wholesale', amount: 8000, disposition_date: '2026-10-06' }, NOW + 1000);
  assert.deepEqual(unitRow(db, 1), { stage: 'archived', sold_at: null, sold_price: null, archived_at: '2026-10-06T00:00:00.000Z' });
  assert.equal(comparable(db, 1), undefined, 'a corrected non-sale leaves pricing comparables');
});

test('retail sold -> retail sold with a different amount and date updates the sale and the comparable', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  dispose(db, 1, { outcome: 'retail_sold', amount: 15000, disposition_date: '2026-10-02' });
  dispose(db, 1, { outcome: 'retail_sold', amount: 14250, disposition_date: '2026-10-03' }, NOW + 1000);
  assert.deepEqual(unitRow(db, 1), { stage: 'sold', sold_at: '2026-10-03T00:00:00.000Z', sold_price: 14250, archived_at: null });
  assert.deepEqual(comparable(db, 1), { sold_price: 14250, sold_at: '2026-10-03T00:00:00.000Z' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM platform_sold_units').get().n, 1);
});

test('retail sold -> retail sold with no amount clears the price and removes the comparable', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  dispose(db, 1, { outcome: 'retail_sold', amount: 15000, disposition_date: '2026-10-02' });
  dispose(db, 1, { outcome: 'retail_sold', disposition_date: '2026-10-04' }, NOW + 1000);
  assert.deepEqual(unitRow(db, 1), { stage: 'sold', sold_at: '2026-10-04T00:00:00.000Z', sold_price: null, archived_at: null });
  assert.equal(comparable(db, 1), undefined);
});

test('every earlier disposition is retained and superseded in order', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  const a = dispose(db, 1, { outcome: 'auction' });
  const b = dispose(db, 1, { outcome: 'retail_sold', amount: 9000 }, NOW + 1000);
  const c = dispose(db, 1, { outcome: 'wholesale' }, NOW + 2000);
  const rows = db.prepare('SELECT id, superseded_by, superseded_at FROM unit_dispositions ORDER BY id').all();
  assert.deepEqual(rows.map(r => [r.id, r.superseded_by]), [[a.id, b.id], [b.id, c.id], [c.id, null]]);
  assert.ok(rows[0].superseded_at && rows[1].superseded_at && !rows[2].superseded_at);
});

test('reversing a disposition returns the unit with history kept and comparables removed; legacy units are untouched', () => {
  const db = freshDb();
  addUnit(db, { id: 1 });
  dispose(db, 1, { outcome: 'retail_sold', amount: 9900 });
  assert.equal(truth.reverseDisposition(db, { dealershipId: 1, unitId: 1, actorId: 10, now: NOW + 1000 }), true);
  const row = db.prepare('SELECT * FROM unit_dispositions WHERE unit_id = 1').get();
  assert.ok(row.superseded_at, 'kept and marked superseded');
  assert.deepEqual([unitRow(db, 1).sold_at, unitRow(db, 1).sold_price, unitRow(db, 1).archived_at], [null, null, null]);
  assert.equal(comparable(db, 1), undefined);
  assert.equal(truth.activeDisposition(db, 1, 1), null);

});

test('reopening legacy sold and archived units clears stale terminal fields without fabricating history', () => {
  const db = freshDb();
  addUnit(db, { id: 2, stage: 'sold' });
  db.prepare("UPDATE units SET sold_price = 5000, sold_at = '2026-01-01' WHERE id = 2").run();
  truth.capturePlatformSoldUnit(db, db.prepare('SELECT * FROM units WHERE id = 2').get());
  assert.ok(comparable(db, 2), 'legacy comparable exists before reopening');
  assert.equal(truth.reverseDisposition(db, { dealershipId: 1, unitId: 2, actorId: 10 }), false);
  assert.deepEqual([unitRow(db, 2).sold_at, unitRow(db, 2).sold_price, unitRow(db, 2).archived_at], [null, null, null]);
  assert.equal(comparable(db, 2), undefined, 'legacy comparable removed');

  addUnit(db, { id: 3, stage: 'archived' });
  db.prepare("UPDATE units SET archived_at = '2026-02-01T00:00:00.000Z' WHERE id = 3").run();
  truth.reverseDisposition(db, { dealershipId: 1, unitId: 3, actorId: 10 });
  assert.equal(unitRow(db, 3).archived_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unit_dispositions').get().n, 0, 'no disposition rows fabricated');
  assert.equal(logs(db, 2).length + logs(db, 3).length, 0, 'no reversal logged when nothing was reversed');
});
