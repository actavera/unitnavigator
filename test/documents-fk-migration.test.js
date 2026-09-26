'use strict';
// Reproduces, in an isolated temp SQLite file, the stale-schema state found in
// the local dev database (documents.deal_id still referencing the long-dropped
// deals_old_unit_fk_migration table) and proves database.js's repair migration
// fixes it, idempotently, without touching any real database.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');

function buildStaleDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE dealerships (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dealership_id INTEGER REFERENCES dealerships(id),
      name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'staff' CHECK(role IN ('super_admin','admin','manager','staff')),
      permissions TEXT DEFAULT NULL, status TEXT DEFAULT 'active' CHECK(status IN ('active','revoked')),
      last_login_at TEXT DEFAULT NULL, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER REFERENCES dealerships(id), first_name TEXT, last_name TEXT);
    -- Full column set matches database.js's own schema so its unrelated
    -- bootstrap steps (platform_sold_units backfill, etc.) run without error
    -- against this fixture; only the documents table below is deliberately corrupted.
    CREATE TABLE units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dealership_id INTEGER REFERENCES dealerships(id),
      vin TEXT NOT NULL,
      stock_number TEXT,
      year INTEGER, make TEXT, model TEXT, trim TEXT, body_style TEXT, color TEXT,
      mileage INTEGER DEFAULT 0,
      stage TEXT DEFAULT 'acquired'
        CHECK(stage IN ('acquired','transport','screening','recon','ready','pending','sold','archived')),
      acquisition_cost REAL DEFAULT 0, transport_cost REAL DEFAULT 0,
      repair_cost REAL DEFAULT 0, repair_items TEXT DEFAULT '[]',
      detail_cost REAL DEFAULT 0, other_cost REAL DEFAULT 0,
      asking_price REAL, minimum_price REAL, sold_price REAL,
      acquisition_source TEXT, acquisition_date TEXT, notes TEXT, photos TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')), sold_at TEXT, archived_at TEXT,
      last_age_check_at TEXT
    );
    CREATE TABLE credit_pulls (id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, customer_id INTEGER);
    -- The already-migrated, correct "deals" table (this part of the historical migration succeeded).
    CREATE TABLE deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dealership_id INTEGER REFERENCES dealerships(id),
      customer_id INTEGER REFERENCES customers(id),
      unit_id INTEGER REFERENCES units(id),
      credit_pull_id INTEGER REFERENCES credit_pulls(id),
      deal_type TEXT CHECK(deal_type IN ('we_finance','bhph','they_finance','cash')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','closed','dead','vehicle_changed')),
      next_follow_up_at TEXT, last_status_check_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), closed_at TEXT
    );
    -- The bug: documents.deal_id still points at the dropped rename-target table.
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dealership_id INTEGER REFERENCES dealerships(id),
      customer_id INTEGER REFERENCES customers(id),
      deal_id INTEGER REFERENCES "deals_old_unit_fk_migration"(id),
      document_type TEXT,
      file_url TEXT,
      status TEXT DEFAULT 'missing' CHECK(status IN ('missing','uploaded','reviewed','rejected')),
      uploaded_at TEXT
    );
    CREATE TABLE esign_envelopes (id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, deal_id INTEGER, provider TEXT, provider_envelope_id TEXT NOT NULL);
    CREATE TABLE activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, entity_type TEXT, entity_id INTEGER, action TEXT NOT NULL, note TEXT, user_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE platform_sold_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, unit_id INTEGER NOT NULL UNIQUE,
      year INTEGER, make TEXT, model TEXT, trim TEXT, mileage INTEGER DEFAULT 0,
      recon_cost REAL DEFAULT 0, final_listing_price REAL, sold_price REAL, market_zip TEXT,
      sold_at TEXT, days_in_inventory INTEGER,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.prepare("INSERT INTO dealerships (id, name) VALUES (1, 'Stale Schema Motors')").run();
  db.prepare("INSERT INTO deals (id, dealership_id, deal_type) VALUES (1, 1, 'cash')").run();
  db.prepare(`
    INSERT INTO documents (id, dealership_id, deal_id, document_type, status)
    VALUES (1, 1, 1, 'title', 'uploaded')
  `).run();
  db.close();
}

function runMigration(dataDir) {
  // Requiring database.js in-process is a require-cache trap (it's a singleton
  // module), so exercise it the same way the real app does: a fresh process.
  execFileSync(process.execPath, ['-e', "require('./database.js')"], {
    cwd: REPO_ROOT,
    env: { ...process.env, UNITNAV_DATA_DIR: dataDir },
    stdio: 'pipe',
  });
}

test('repairs a documents table stuck referencing the dropped deals_old_unit_fk_migration table', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-fk-migration-test-'));
  try {
    const dbPath = path.join(tmpDir, 'unitnavigator.db');
    buildStaleDatabase(dbPath);

    const before = new Database(dbPath, { readonly: true });
    const beforeSchema = before.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'").get().sql;
    before.close();
    assert.ok(beforeSchema.includes('deals_old_unit_fk_migration'), 'fixture must reproduce the stale schema before migration runs');

    runMigration(tmpDir);

    const after = new Database(dbPath, { readonly: true });
    const afterSchema = after.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'").get().sql;
    assert.ok(!afterSchema.includes('deals_old_unit_fk_migration'), 'documents schema must no longer reference the dropped table');
    assert.match(afterSchema, /deal_id INTEGER REFERENCES deals\(id\)/, 'documents.deal_id must reference the live deals table');

    // Data must survive the rebuild.
    const row = after.prepare('SELECT * FROM documents WHERE id = 1').get();
    assert.equal(row.dealership_id, 1);
    assert.equal(row.deal_id, 1);
    assert.equal(row.document_type, 'title');
    assert.equal(row.status, 'uploaded');

    after.close();

    // The bug this migration exists for: DELETE FROM documents used to throw
    // "no such table: main.deals_old_unit_fk_migration" because SQLite could
    // not compile the statement against the corrupted schema.
    const writable = new Database(dbPath);
    assert.doesNotThrow(() => writable.prepare('DELETE FROM documents WHERE dealership_id = ?').run(999));
    writable.close();

    // Idempotency: running it again against an already-fixed database must not error
    // and must leave the schema/data exactly as-is.
    runMigration(tmpDir);
    const second = new Database(dbPath, { readonly: true });
    const secondSchema = second.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'").get().sql;
    assert.equal(secondSchema, afterSchema);
    const stillThere = second.prepare('SELECT * FROM documents WHERE id = 1').get();
    assert.equal(stillThere.deal_id, 1);
    second.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
