'use strict';
// Proves the pilot-phase pricing policy: a dealership's price suggestion is
// built only from its own sold-unit history, never another dealership's.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { suggestedRetailPrice } = require('../services/pricing');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE platform_sold_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dealership_id INTEGER,
      unit_id INTEGER,
      year INTEGER, make TEXT, model TEXT, trim TEXT, mileage INTEGER,
      sold_price REAL
    );
  `);
  return db;
}

function insertSold(db, { dealershipId, unitId, price, mileage = 40000 }) {
  db.prepare(`
    INSERT INTO platform_sold_units (dealership_id, unit_id, year, make, model, trim, mileage, sold_price)
    VALUES (?, ?, 2020, 'Honda', 'Accord', 'EX', ?, ?)
  `).run(dealershipId, unitId, mileage, price);
}

const REQUEST = { year: 2020, make: 'Honda', model: 'Accord', trim: 'EX', mileage: 40000 };

test("Dealer A's price suggestion is unaffected by Dealer B's sold data", () => {
  const db = makeDb();
  const DEALER_A = 1;
  const DEALER_B = 2;

  // Dealer B has plenty of sold comps; Dealer A has none yet.
  for (let i = 0; i < 10; i += 1) {
    insertSold(db, { dealershipId: DEALER_B, unitId: 100 + i, price: 22000 + i * 100 });
  }

  const beforeA = suggestedRetailPrice(db, { ...REQUEST, dealership_id: DEALER_A });
  assert.notEqual(beforeA.source, 'internal_sold', 'Dealer A must not get comps sourced from Dealer B');
  assert.equal(beforeA.comparable_count, 0);

  // Now give Dealer A its own comps and confirm the suggestion is built from
  // those, not shifted at all by Dealer B's (still-present) data.
  for (let i = 0; i < 4; i += 1) {
    insertSold(db, { dealershipId: DEALER_A, unitId: 200 + i, price: 19000 + i * 50 });
  }
  const withOwnData = suggestedRetailPrice(db, { ...REQUEST, dealership_id: DEALER_A });
  assert.equal(withOwnData.source, 'internal_sold');
  assert.equal(withOwnData.comparable_count, 4, 'must count only Dealer A\'s own 4 comps, not Dealer B\'s 10');

  // Adding MORE of Dealer B's data afterward must not move Dealer A's number at all.
  for (let i = 0; i < 10; i += 1) {
    insertSold(db, { dealershipId: DEALER_B, unitId: 300 + i, price: 5000 }); // wildly different price, would skew a pooled result
  }
  const afterMoreB = suggestedRetailPrice(db, { ...REQUEST, dealership_id: DEALER_A });
  assert.deepEqual(afterMoreB, withOwnData, "Dealer A's suggestion must be identical before and after Dealer B gets more sold data");
});

test('Dealer B, meanwhile, does get its own comps-based suggestion from its own data', () => {
  const db = makeDb();
  const DEALER_B = 2;
  for (let i = 0; i < 5; i += 1) {
    insertSold(db, { dealershipId: DEALER_B, unitId: 400 + i, price: 21000 });
  }
  const suggestion = suggestedRetailPrice(db, { ...REQUEST, dealership_id: DEALER_B });
  assert.equal(suggestion.source, 'internal_sold');
  assert.equal(suggestion.comparable_count, 5);
});
