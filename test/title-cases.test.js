'use strict';
// Service-level coverage for title, plate, and registration cases
// (services/titleCases.js) and their automatic creation on a retail close.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const titles = require('../services/titleCases');
const truth = require('../services/inventoryTruth');
const checklist = require('../services/dealChecklist');
const { closeDeal } = require('../services/dealClose');

const NOW = Date.parse('2026-10-19T12:00:00Z');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dealerships (id INTEGER PRIMARY KEY, name TEXT, zip TEXT, inventory_review_interval_days INTEGER DEFAULT 30);
    CREATE TABLE users (id INTEGER PRIMARY KEY, dealership_id INTEGER, name TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE customers (id INTEGER PRIMARY KEY, dealership_id INTEGER, first_name TEXT, last_name TEXT);
    CREATE TABLE units (id INTEGER PRIMARY KEY, dealership_id INTEGER, vin TEXT, stage TEXT DEFAULT 'ready', year INTEGER, make TEXT, model TEXT, trim TEXT, stock_number TEXT,
      mileage INTEGER, repair_cost REAL, asking_price REAL, sold_price REAL, sold_at TEXT, archived_at TEXT, created_at TEXT, last_age_check_at TEXT, assigned_user_id INTEGER);
    CREATE TABLE platform_sold_units (id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, unit_id INTEGER UNIQUE, year INTEGER, make TEXT, model TEXT, trim TEXT,
      mileage INTEGER, recon_cost REAL, final_listing_price REAL, sold_price REAL, market_zip TEXT, sold_at TEXT, days_in_inventory INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE deals (id INTEGER PRIMARY KEY, dealership_id INTEGER, customer_id INTEGER, unit_id INTEGER, deal_type TEXT, status TEXT DEFAULT 'pending', closed_at TEXT, last_status_check_at TEXT);
    CREATE TABLE esign_envelopes (id INTEGER PRIMARY KEY, dealership_id INTEGER, deal_id INTEGER, status TEXT, title TEXT);
    CREATE TABLE activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, entity_type TEXT, entity_id INTEGER, action TEXT, note TEXT, user_id INTEGER, created_at TEXT);
  `);
  for (const sql of [truth.SCHEMA_SQL, checklist.SCHEMA_SQL, titles.SCHEMA_SQL]) db.exec(sql);
  db.prepare("INSERT INTO dealerships (id, name) VALUES (1, 'A'), (2, 'B')").run();
  db.prepare("INSERT INTO users (id, dealership_id, name, status) VALUES (10, 1, 'Ann', 'active'), (11, 1, 'Rev', 'revoked'), (20, 2, 'Bob', 'active')").run();
  db.prepare("INSERT INTO customers (id, dealership_id, first_name, last_name) VALUES (1, 1, 'Casey', 'Buyer'), (2, 2, 'Other', 'Buyer')").run();
  db.prepare("INSERT INTO units (id, dealership_id, vin, year, make, model, created_at) VALUES (100, 1, 'V1', 2020, 'Kia', 'Soul', '2026-09-01'), (101, 1, 'V2', 2019, 'Ford', 'Escape', '2026-09-01')").run();
  db.prepare("INSERT INTO deals (id, dealership_id, customer_id, unit_id, deal_type, status) VALUES (1, 1, 1, 100, 'cash', 'pending'), (2, 1, 1, 101, 'cash', 'closed'), (3, 1, 1, NULL, 'cash', 'pending'), (9, 2, 2, NULL, 'cash', 'closed')").run();
  return db;
}

test('closing a deal with a retail-sold disposition opens one case, atomically', () => {
  const db = freshDb();
  const result = closeDeal(db, { dealershipId: 1, dealId: 1, actorId: 10, now: NOW });
  assert.ok(result.title_case_id);
  const row = db.prepare('SELECT * FROM title_cases WHERE deal_id = 1').get();
  assert.deepEqual([row.unit_id, row.customer_id, row.status, row.title_status, row.plate_status], [100, 1, 'not_started', 'not_started', 'not_started']);
  assert.equal(titles.createForDeal(db, { dealershipId: 1, dealId: 1, actorId: 10 }).created, false, 'idempotent');
  closeDeal(db, { dealershipId: 1, dealId: 3, actorId: 10, now: NOW });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM title_cases WHERE deal_id = 3').get().n, 0, 'no vehicle, no retail disposition, no case');

  db.prepare("UPDATE deals SET status = 'pending' WHERE id = 2").run();
  db.exec("CREATE TRIGGER fail_case BEFORE INSERT ON title_cases WHEN NEW.deal_id = 2 BEGIN SELECT RAISE(ABORT, 'forced'); END;");
  assert.throws(() => closeDeal(db, { dealershipId: 1, dealId: 2, actorId: 10, now: NOW }));
  assert.equal(db.prepare('SELECT status FROM deals WHERE id = 2').get().status, 'pending', 'deal unchanged');
  assert.equal(db.prepare('SELECT stage FROM units WHERE id = 101').get().stage, 'ready', 'no disposition either');
});

test('manual creation only for closed deals in the same dealership', () => {
  const db = freshDb();
  assert.equal(titles.createForDeal(db, { dealershipId: 1, dealId: 2, actorId: 10 }).created, true);
  assert.throws(() => titles.createForDeal(db, { dealershipId: 1, dealId: 1, actorId: 10 }), e => e.statusCode === 409, 'pending deal');
  assert.throws(() => titles.createForDeal(db, { dealershipId: 1, dealId: 9, actorId: 10 }), e => e.statusCode === 404, 'other dealership');
});

test('updates validate, record append-only history, and assign only active same-dealership employees', () => {
  const db = freshDb();
  const { id } = titles.createForDeal(db, { dealershipId: 1, dealId: 2, actorId: 10, now: NOW });
  for (const body of [{ status: 'lost' }, { temp_tag_expires_on: '2026-02-30' }, { assigned_user_id: 11 }, { assigned_user_id: 20 }, { assigned_user_id: 'x' }]) {
    assert.throws(() => titles.updateCase(db, { dealershipId: 1, caseId: id, actorId: 10, body, now: NOW }), e => e.statusCode === 400, JSON.stringify(body));
  }
  const r = titles.updateCase(db, { dealershipId: 1, caseId: id, actorId: 10, now: NOW, body: { status: 'submitted', title_status: 'submitted', temp_tag_number: ' T-123 ', temp_tag_expires_on: '2026-11-01', assigned_user_id: 10, note: 'n' } });
  assert.deepEqual(r.changed.sort(), ['assigned_user_id', 'note', 'status', 'temp_tag_expires_on', 'temp_tag_number', 'title_status']);
  assert.deepEqual(titles.updateCase(db, { dealershipId: 1, caseId: id, actorId: 10, now: NOW, body: { status: 'submitted' } }).changed, [], 'no-op adds no history');
  titles.updateCase(db, { dealershipId: 1, caseId: id, actorId: 10, now: NOW, body: { status: 'completed' } });
  const row = db.prepare('SELECT * FROM title_cases WHERE id = ?').get(id);
  assert.equal(row.temp_tag_number, 'T-123');
  assert.equal(row.completed_on, '2026-10-19', 'completion date defaults to today');
  const events = db.prepare('SELECT field, from_value, to_value, actor_user_id FROM title_case_events WHERE case_id = ? ORDER BY id').all(id);
  assert.equal(events[0].field, 'created');
  assert.ok(events.some(e => e.field === 'status' && e.from_value === 'submitted' && e.to_value === 'completed' && e.actor_user_id === 10));
  assert.throws(() => titles.updateCase(db, { dealershipId: 2, caseId: id, actorId: 20, body: { status: 'on_hold' } }), e => e.statusCode === 404, 'tenant scoped');
});

test('urgency uses dealer-entered dates only', () => {
  const at = fields => titles.urgency({ status: 'submitted', blocking_issue: null, temp_tag_expires_on: null, ...fields }, NOW);
  assert.deepEqual(at({}), { level: null, days_to_tag_expiry: null }, 'no dates, no urgency');
  assert.equal(at({ temp_tag_expires_on: '2026-11-15' }).level, null);
  assert.deepEqual(at({ temp_tag_expires_on: '2026-10-24' }), { level: 'due', days_to_tag_expiry: 5 });
  assert.deepEqual(at({ temp_tag_expires_on: '2026-10-17' }), { level: 'overdue', days_to_tag_expiry: -2 });
  assert.equal(at({ status: 'on_hold' }).level, 'due');
  assert.equal(at({ blocking_issue: 'Lien release missing' }).level, 'due');
  assert.equal(at({ status: 'completed', temp_tag_expires_on: '2026-01-01' }).level, null, 'completed cases never alert');
});

test('lists filter by urgency and assignee; cleanup helpers are scoped', () => {
  const db = freshDb();
  const a = titles.createForDeal(db, { dealershipId: 1, dealId: 2, actorId: 10 }).id;
  closeDeal(db, { dealershipId: 1, dealId: 1, actorId: 10, now: NOW });
  const b = db.prepare('SELECT id FROM title_cases WHERE deal_id = 1').get().id;
  titles.createForDeal(db, { dealershipId: 2, dealId: 9, actorId: 20 });
  titles.updateCase(db, { dealershipId: 1, caseId: a, actorId: 10, now: NOW, body: { temp_tag_expires_on: '2026-10-10', assigned_user_id: 10 } });
  const list = filter => titles.listCases(db, { dealershipId: 1, filter, now: NOW }).map(c => c.id);
  assert.deepEqual(list('open').sort(), [a, b].sort());
  assert.deepEqual(list('overdue'), [a]);
  assert.deepEqual(list('due'), [a]);
  assert.deepEqual(titles.listCases(db, { dealershipId: 1, assignee: '10', now: NOW }).map(c => c.id), [a]);
  assert.deepEqual(titles.listCases(db, { dealershipId: 1, assignee: 'none', now: NOW }).map(c => c.id), [b]);
  assert.equal(titles.listCases(db, { dealershipId: 1, filter: 'all', now: NOW }).length, 2, 'never includes another dealership');
  titles.deleteForDeals(db, 1, [2]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM title_case_events WHERE case_id = ?').get(a).n, 0);
  titles.deleteForDealership(db, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM title_cases WHERE dealership_id = 1').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM title_cases WHERE dealership_id = 2').get().n, 1);
});
