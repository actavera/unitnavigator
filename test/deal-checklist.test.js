'use strict';
// Service-level coverage for the deal document checklist (services/dealChecklist.js)
// and the shared deal close (services/dealClose.js), on an in-memory database.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const checklist = require('../services/dealChecklist');
const truth = require('../services/inventoryTruth');
const { closeDeal, checklistWarning } = require('../services/dealClose');

const NOW = Date.parse('2026-10-19T12:00:00Z');
const BOTH = { deals: true, paperwork: true };

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dealerships (id INTEGER PRIMARY KEY, name TEXT, zip TEXT, inventory_review_interval_days INTEGER DEFAULT 30);
    CREATE TABLE users (id INTEGER PRIMARY KEY, dealership_id INTEGER, name TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE units (id INTEGER PRIMARY KEY, dealership_id INTEGER, vin TEXT, stage TEXT DEFAULT 'ready', year INTEGER, make TEXT, model TEXT, trim TEXT,
      mileage INTEGER, repair_cost REAL, asking_price REAL, sold_price REAL, sold_at TEXT, archived_at TEXT, created_at TEXT, last_age_check_at TEXT, assigned_user_id INTEGER);
    CREATE TABLE platform_sold_units (id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, unit_id INTEGER UNIQUE, year INTEGER, make TEXT, model TEXT, trim TEXT,
      mileage INTEGER, recon_cost REAL, final_listing_price REAL, sold_price REAL, market_zip TEXT, sold_at TEXT, days_in_inventory INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE deals (id INTEGER PRIMARY KEY, dealership_id INTEGER, customer_id INTEGER, unit_id INTEGER, deal_type TEXT, status TEXT DEFAULT 'pending',
      closed_at TEXT, last_status_check_at TEXT, created_at TEXT);
    CREATE TABLE esign_envelopes (id INTEGER PRIMARY KEY, dealership_id INTEGER, deal_id INTEGER, provider_envelope_id TEXT, title TEXT, status TEXT);
    CREATE TABLE activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, entity_type TEXT, entity_id INTEGER, action TEXT, note TEXT, user_id INTEGER, created_at TEXT);
  `);
  db.exec(truth.SCHEMA_SQL);
  db.exec(checklist.SCHEMA_SQL);
  db.prepare("INSERT INTO dealerships (id, name) VALUES (1, 'A'), (2, 'B')").run();
  db.prepare("INSERT INTO users (id, dealership_id, name) VALUES (10, 1, 'Ann'), (20, 2, 'Bob')").run();
  db.prepare("INSERT INTO deals (id, dealership_id, deal_type) VALUES (1, 1, 'cash'), (2, 1, 'we_finance'), (3, 1, 'bhph'), (4, 1, 'they_finance'), (9, 2, 'cash')").run();
  return db;
}

const keys = (db, dealId) => checklist.listChecklist(db, { dealershipId: 1, dealId, canSeeSensitive: true }).items.map(i => i.item_key);
const set = (db, dealId, itemId, status, reason, can = BOTH) => checklist.changeStatus(db, { dealershipId: 1, dealId, itemId, actorId: 10, body: { status, reason }, can, now: NOW });

test('standard sets match the deal type; creation is explicit and idempotent', () => {
  const db = freshDb();
  assert.deepEqual(keys(db, 1), [], 'deals start with no checklist');
  for (const id of [1, 2, 3, 4]) checklist.addStandardItems(db, { dealershipId: 1, dealId: id, actorId: 10, now: NOW });
  assert.deepEqual(keys(db, 1), ['identification', 'insurance']);
  assert.deepEqual(keys(db, 4), ['identification', 'insurance']);
  const finance = ['identification', 'pay_stubs', 'proof_of_residence', 'insurance', 'signature'];
  assert.deepEqual(keys(db, 2), finance);
  assert.deepEqual(keys(db, 3), finance);
  assert.equal(checklist.addStandardItems(db, { dealershipId: 1, dealId: 2, actorId: 10, now: NOW }).added, 0);
  assert.deepEqual(keys(db, 2), finance, 'no duplicates');
  assert.throws(() => checklist.addStandardItems(db, { dealershipId: 1, dealId: 9, actorId: 10 }), e => e.statusCode === 404, 'tenant scoped');
});

test('custom items and lender stipulations; validation', () => {
  const db = freshDb();
  checklist.addItem(db, { dealershipId: 1, dealId: 1, actorId: 10, body: { item_key: 'lender_stipulation', label: 'Two references', due_date: '2026-10-25' } });
  checklist.addItem(db, { dealershipId: 1, dealId: 1, actorId: 10, body: { label: 'Spare key' } });
  const items = checklist.listChecklist(db, { dealershipId: 1, dealId: 1, canSeeSensitive: true }).items;
  assert.deepEqual(items.map(i => [i.item_key, i.label, i.status]), [['lender_stipulation', 'Two references', 'required'], ['custom', 'Spare key', 'required']]);
  assert.equal(items[0].due_date, '2026-10-25');
  for (const body of [{ item_key: 'bogus', label: 'x' }, { item_key: 'custom' }, { label: 'x', due_date: '2026-02-30' }, { item_key: 'insurance', esign_envelope_id: 1 }]) {
    assert.throws(() => checklist.addItem(db, { dealershipId: 1, dealId: 1, actorId: 10, body }), e => e.statusCode === 400, JSON.stringify(body));
  }
});

test('state machine: allowed and refused transitions, reasons, and permission split', () => {
  const db = freshDb();
  checklist.addStandardItems(db, { dealershipId: 1, dealId: 1, actorId: 10, now: NOW });
  const [id] = checklist.listChecklist(db, { dealershipId: 1, dealId: 1, canSeeSensitive: true }).items.map(i => i.id);
  const dealsOnly = { deals: true, paperwork: false };
  const paperOnly = { deals: false, paperwork: true };

  assert.throws(() => set(db, 1, id, 'approved', null), e => e.statusCode === 409, 'cannot approve before received');
  assert.throws(() => set(db, 1, id, 'received', null, paperOnly), e => e.statusCode === 403, 'received needs deals_manage');
  set(db, 1, id, 'received', null, dealsOnly);
  assert.throws(() => set(db, 1, id, 'approved', null, dealsOnly), e => e.statusCode === 403, 'approve needs paperwork_manage');
  assert.throws(() => set(db, 1, id, 'rejected', '', paperOnly), e => e.statusCode === 400, 'reject needs a reason');
  set(db, 1, id, 'rejected', 'Blurry copy', paperOnly);
  set(db, 1, id, 'received', null, dealsOnly);
  set(db, 1, id, 'approved', null, paperOnly);
  assert.throws(() => set(db, 1, id, 'waived', 'x', paperOnly), e => e.statusCode === 409, 'approved cannot be waived directly');
  assert.throws(() => set(db, 1, id, 'required', null, paperOnly), e => e.statusCode === 400, 'reopen needs a reason');
  assert.throws(() => set(db, 1, id, 'required', 'Expired', dealsOnly), e => e.statusCode === 403, 'reopen needs paperwork_manage');
  set(db, 1, id, 'required', 'Expired', paperOnly);
  assert.throws(() => set(db, 1, id, 'waived', '', paperOnly), e => e.statusCode === 400);
  set(db, 1, id, 'waived', 'Repeat customer', paperOnly);
  assert.throws(() => set(db, 1, id, 'bogus', 'x'), e => e.statusCode === 400);

  const events = db.prepare('SELECT from_status, to_status FROM deal_checklist_events WHERE item_id = ? ORDER BY id').all(id).map(e => `${e.from_status}>${e.to_status}`);
  assert.deepEqual(events, ['null>required', 'required>received', 'received>rejected', 'rejected>received', 'received>approved', 'approved>required', 'required>waived']);
  assert.ok(db.prepare("SELECT 1 FROM activity_logs WHERE entity_type = 'deal' AND action = 'Checklist updated'").get());
  assert.ok(!db.prepare("SELECT 1 FROM activity_logs WHERE note LIKE '%Blurry%' OR note LIKE '%Repeat customer%'").get(), 'reasons stay out of the timeline');
});

test('a failed history write rolls back the status change', () => {
  const db = freshDb();
  checklist.addStandardItems(db, { dealershipId: 1, dealId: 1, actorId: 10, now: NOW });
  const id = checklist.listChecklist(db, { dealershipId: 1, dealId: 1, canSeeSensitive: true }).items[0].id;
  db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON deal_checklist_events BEGIN SELECT RAISE(ABORT, 'forced'); END;");
  assert.throws(() => set(db, 1, id, 'received', null));
  assert.equal(db.prepare('SELECT status FROM deal_checklist_items WHERE id = ?').get(id).status, 'required');
});

test('sensitive notes and reasons are withheld without paperwork/credit access; labels and statuses are not', () => {
  const db = freshDb();
  checklist.addItem(db, { dealershipId: 1, dealId: 1, actorId: 10, body: { item_key: 'pay_stubs', note: 'Employer sends weekly' } });
  checklist.addItem(db, { dealershipId: 1, dealId: 1, actorId: 10, body: { item_key: 'insurance', note: 'Agent calling back' } });
  const [pay] = checklist.listChecklist(db, { dealershipId: 1, dealId: 1, canSeeSensitive: true }).items;
  set(db, 1, pay.id, 'received', null);
  set(db, 1, pay.id, 'rejected', 'Wrong month');
  const hidden = checklist.listChecklist(db, { dealershipId: 1, dealId: 1, canSeeSensitive: false });
  assert.equal(hidden.items[0].label, 'Pay stubs');
  assert.equal(hidden.items[0].status, 'rejected');
  assert.equal(hidden.items[0].note, null);
  assert.equal(hidden.items[0].note_hidden, true);
  assert.ok(hidden.items[0].history.every(h => h.reason === null));
  assert.ok(!JSON.stringify(hidden).includes('Wrong month') && !JSON.stringify(hidden).includes('Employer sends'));
  assert.equal(hidden.items[1].note, 'Agent calling back', 'non-sensitive notes stay visible');
});

test('a completed e-sign packet makes a signature item effectively received without changing the envelope', () => {
  const db = freshDb();
  db.prepare("INSERT INTO esign_envelopes (id, dealership_id, deal_id, provider_envelope_id, status) VALUES (5, 1, 2, 'x', 'pending'), (6, 1, 1, 'y', 'completed'), (7, 2, 9, 'z', 'completed')").run();
  checklist.addItem(db, { dealershipId: 1, dealId: 2, actorId: 10, body: { item_key: 'signature', esign_envelope_id: 5 } });
  assert.throws(() => checklist.addItem(db, { dealershipId: 1, dealId: 2, actorId: 10, body: { item_key: 'signature', esign_envelope_id: 6 } }), e => e.statusCode === 400, 'other deal');
  assert.throws(() => checklist.addItem(db, { dealershipId: 1, dealId: 2, actorId: 10, body: { item_key: 'signature', esign_envelope_id: 7 } }), e => e.statusCode === 400, 'other dealership');
  const before = checklist.listChecklist(db, { dealershipId: 1, dealId: 2, canSeeSensitive: true });
  assert.equal(before.summary.outstanding, 1);
  assert.equal(checklist.outstandingCount(db, 1, 2), 1);
  db.prepare("UPDATE esign_envelopes SET status = 'completed' WHERE id = 5").run();
  const after = checklist.listChecklist(db, { dealershipId: 1, dealId: 2, canSeeSensitive: true });
  assert.equal(after.items[0].status, 'required');
  assert.equal(after.items[0].effective_status, 'received');
  assert.equal(after.summary.outstanding, 0);
  assert.equal(checklist.outstandingCount(db, 1, 2), 0, 'SQL count agrees');
  assert.equal(db.prepare('SELECT status FROM esign_envelopes WHERE id = 5').get().status, 'completed', 'envelope untouched');
  assert.throws(() => set(db, 2, after.items[0].id, 'approved', null), e => e.statusCode === 409, 'approval still needs a dealer to mark it received first');
});

test('outstanding counts required and rejected only; removal is soft and only for untouched items', () => {
  const db = freshDb();
  checklist.addStandardItems(db, { dealershipId: 1, dealId: 2, actorId: 10, now: NOW });
  const items = checklist.listChecklist(db, { dealershipId: 1, dealId: 2, canSeeSensitive: true }).items;
  set(db, 2, items[0].id, 'received', null);
  set(db, 2, items[1].id, 'received', null);
  set(db, 2, items[1].id, 'rejected', 'Old');
  set(db, 2, items[2].id, 'waived', 'N/A');
  assert.equal(checklist.outstandingCount(db, 1, 2), 3, 'pay stubs (rejected), insurance, signature');
  assert.throws(() => checklist.removeItem(db, { dealershipId: 1, dealId: 2, itemId: items[0].id, actorId: 10 }), e => e.statusCode === 409);
  checklist.removeItem(db, { dealershipId: 1, dealId: 2, itemId: items[3].id, actorId: 10 });
  assert.equal(checklist.outstandingCount(db, 1, 2), 2);
  assert.ok(db.prepare('SELECT removed_at FROM deal_checklist_items WHERE id = ?').get(items[3].id).removed_at, 'kept, marked removed');
  assert.throws(() => set(db, 2, items[3].id, 'received', null), e => e.statusCode === 404);
});

test('shared deal close: retail-sold disposition with no price, atomic, warning only', () => {
  const db = freshDb();
  db.prepare("INSERT INTO units (id, dealership_id, vin, stage, created_at) VALUES (100, 1, 'V1', 'ready', '2026-09-01'), (101, 1, 'V2', 'ready', '2026-09-01')").run();
  db.prepare('UPDATE deals SET unit_id = 100 WHERE id = 2').run();
  db.prepare('UPDATE deals SET unit_id = 101 WHERE id = 3').run();
  checklist.addStandardItems(db, { dealershipId: 1, dealId: 2, actorId: 10, now: NOW });
  const result = closeDeal(db, { dealershipId: 1, dealId: 2, actorId: 10, now: NOW });
  assert.equal(result.outstanding_checklist_items, 5);
  assert.match(checklistWarning(5), /5 checklist items are still outstanding/);
  assert.equal(checklistWarning(0), null);
  assert.equal(db.prepare('SELECT status FROM deals WHERE id = 2').get().status, 'closed');
  assert.deepEqual(db.prepare('SELECT stage, sold_price FROM units WHERE id = 100').get(), { stage: 'sold', sold_price: null });
  assert.equal(db.prepare('SELECT outcome FROM unit_dispositions WHERE unit_id = 100').get().outcome, 'retail_sold');

  db.exec("CREATE TRIGGER fail_disp BEFORE INSERT ON unit_dispositions WHEN NEW.unit_id = 101 BEGIN SELECT RAISE(ABORT, 'forced'); END;");
  assert.throws(() => closeDeal(db, { dealershipId: 1, dealId: 3, actorId: 10, now: NOW }));
  assert.equal(db.prepare('SELECT status FROM deals WHERE id = 3').get().status, 'pending', 'deal unchanged');
  assert.equal(db.prepare('SELECT stage FROM units WHERE id = 101').get().stage, 'ready', 'unit unchanged');
  assert.equal(closeDeal(db, { dealershipId: 2, dealId: 2, actorId: 20 }), null, 'tenant scoped');
});

test('cleanup helpers remove checklist rows for the given deals or dealership only', () => {
  const db = freshDb();
  for (const id of [1, 2]) checklist.addStandardItems(db, { dealershipId: 1, dealId: id, actorId: 10, now: NOW });
  checklist.addStandardItems(db, { dealershipId: 2, dealId: 9, actorId: 20, now: NOW });
  checklist.deleteForDeals(db, 1, [1]);
  const count = (table, where) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
  assert.equal(count('deal_checklist_items', 'deal_id = 1'), 0);
  assert.equal(count('deal_checklist_events', 'deal_id = 1'), 0);
  assert.ok(count('deal_checklist_items', 'deal_id = 2') > 0);
  checklist.deleteForDealership(db, 1);
  assert.equal(count('deal_checklist_items', 'dealership_id = 1') + count('deal_checklist_events', 'dealership_id = 1'), 0);
  assert.ok(count('deal_checklist_items', 'dealership_id = 2') > 0, 'other dealership untouched');
});
