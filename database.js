'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'unitnavigator.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS dealerships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER REFERENCES dealerships(id),
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'staff' CHECK(role IN ('super_admin','admin','manager','staff')),
    status TEXT DEFAULT 'active' CHECK(status IN ('active','revoked')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER REFERENCES dealerships(id),
    vin TEXT NOT NULL,
    year INTEGER,
    make TEXT,
    model TEXT,
    trim TEXT,
    body_style TEXT,
    color TEXT,
    mileage INTEGER DEFAULT 0,
    stage TEXT DEFAULT 'acquired'
      CHECK(stage IN ('acquired','transport','screening','recon','ready','pending','sold','archived')),
    acquisition_cost REAL DEFAULT 0,
    transport_cost REAL DEFAULT 0,
    repair_cost REAL DEFAULT 0,
    repair_items TEXT DEFAULT '[]',
    detail_cost REAL DEFAULT 0,
    other_cost REAL DEFAULT 0,
    asking_price REAL,
    minimum_price REAL,
    sold_price REAL,
    acquisition_source TEXT,
    acquisition_date TEXT,
    notes TEXT,
    photos TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    sold_at TEXT,
    archived_at TEXT
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER REFERENCES dealerships(id),
    first_name TEXT,
    last_name TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    previous_address TEXT,
    employer TEXT,
    monthly_income REAL,
    time_at_job TEXT,
    time_at_residence TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS credit_pulls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER REFERENCES dealerships(id),
    customer_id INTEGER REFERENCES customers(id),
    provider TEXT DEFAULT 'mock',
    provider_status TEXT,
    result_summary TEXT,
    score_placeholder INTEGER,
    consent_confirmed INTEGER DEFAULT 0,
    vehicle_interest TEXT,
    notes TEXT,
    pulled_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER REFERENCES dealerships(id),
    customer_id INTEGER REFERENCES customers(id),
    unit_id INTEGER REFERENCES units(id),
    credit_pull_id INTEGER REFERENCES credit_pulls(id),
    deal_type TEXT CHECK(deal_type IN ('we_finance','bhph','they_finance','cash')),
    status TEXT DEFAULT 'pending'
      CHECK(status IN ('pending','closed','dead','vehicle_changed')),
    next_follow_up_at TEXT,
    last_status_check_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER REFERENCES dealerships(id),
    customer_id INTEGER REFERENCES customers(id),
    deal_id INTEGER REFERENCES deals(id),
    document_type TEXT,
    file_url TEXT,
    status TEXT DEFAULT 'missing'
      CHECK(status IN ('missing','uploaded','reviewed','rejected')),
    uploaded_at TEXT
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER,
    entity_type TEXT,
    entity_id INTEGER,
    action TEXT NOT NULL,
    note TEXT,
    user_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const unitSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'units'").get()?.sql || '';
if (unitSchema && !unitSchema.includes("'screening'")) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE units RENAME TO units_old_stage_migration;
    CREATE TABLE units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dealership_id INTEGER REFERENCES dealerships(id),
      vin TEXT NOT NULL,
      year INTEGER,
      make TEXT,
      model TEXT,
      trim TEXT,
      body_style TEXT,
      color TEXT,
      mileage INTEGER DEFAULT 0,
      stage TEXT DEFAULT 'acquired'
        CHECK(stage IN ('acquired','transport','screening','recon','ready','pending','sold','archived')),
      acquisition_cost REAL DEFAULT 0,
      transport_cost REAL DEFAULT 0,
      repair_cost REAL DEFAULT 0,
      repair_items TEXT DEFAULT '[]',
      detail_cost REAL DEFAULT 0,
      other_cost REAL DEFAULT 0,
      asking_price REAL,
      minimum_price REAL,
      sold_price REAL,
      acquisition_source TEXT,
      acquisition_date TEXT,
      notes TEXT,
      photos TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      sold_at TEXT,
      archived_at TEXT
    );
    INSERT INTO units (
      id, dealership_id, vin, year, make, model, trim, body_style, color, mileage, stage,
      acquisition_cost, transport_cost, repair_cost, detail_cost, other_cost, asking_price,
      minimum_price, sold_price, acquisition_source, acquisition_date, notes, photos,
      created_at, sold_at, archived_at
    )
    SELECT
      id, dealership_id, vin, year, make, model, trim, body_style, color, mileage, stage,
      acquisition_cost, transport_cost, repair_cost, detail_cost, other_cost, asking_price,
      minimum_price, sold_price, acquisition_source, acquisition_date, notes, photos,
      created_at, sold_at, archived_at
    FROM units_old_stage_migration;
    DROP TABLE units_old_stage_migration;
    PRAGMA foreign_keys = ON;
  `);
}

const dealsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deals'").get()?.sql || '';
if (dealsSchema.includes('units_old_stage_migration')) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE deals RENAME TO deals_old_unit_fk_migration;
    CREATE TABLE deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dealership_id INTEGER REFERENCES dealerships(id),
      customer_id INTEGER REFERENCES customers(id),
      unit_id INTEGER REFERENCES units(id),
      credit_pull_id INTEGER REFERENCES credit_pulls(id),
      deal_type TEXT CHECK(deal_type IN ('we_finance','bhph','they_finance','cash')),
      status TEXT DEFAULT 'pending'
        CHECK(status IN ('pending','closed','dead','vehicle_changed')),
      next_follow_up_at TEXT,
      last_status_check_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );
    INSERT INTO deals (
      id, dealership_id, customer_id, unit_id, credit_pull_id, deal_type, status,
      next_follow_up_at, last_status_check_at, created_at, closed_at
    )
    SELECT
      id, dealership_id, customer_id, unit_id, credit_pull_id, deal_type, status,
      next_follow_up_at, last_status_check_at, created_at, closed_at
    FROM deals_old_unit_fk_migration;
    DROP TABLE deals_old_unit_fk_migration;
    PRAGMA foreign_keys = ON;
  `);
}

const unitColumns = db.prepare("PRAGMA table_info(units)").all().map(col => col.name);
if (!unitColumns.includes('repair_items')) {
  db.exec("ALTER TABLE units ADD COLUMN repair_items TEXT DEFAULT '[]'");
}
if (!unitColumns.includes('last_age_check_at')) {
  db.exec("ALTER TABLE units ADD COLUMN last_age_check_at TEXT");
}

const dealColumns = db.prepare("PRAGMA table_info(deals)").all().map(col => col.name);
if (!dealColumns.includes('last_status_check_at')) {
  db.exec("ALTER TABLE deals ADD COLUMN last_status_check_at TEXT");
}

const userSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || '';
const userColumns = db.prepare("PRAGMA table_info(users)").all().map(col => col.name);
if (userSchema && (!userSchema.includes("'super_admin'") || !userColumns.includes('status'))) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE users RENAME TO users_old_admin_migration;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dealership_id INTEGER REFERENCES dealerships(id),
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'staff' CHECK(role IN ('super_admin','admin','manager','staff')),
      status TEXT DEFAULT 'active' CHECK(status IN ('active','revoked')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO users (id, dealership_id, name, email, password_hash, role, status, created_at)
    SELECT id, dealership_id, name, email, password_hash,
      CASE WHEN role = 'admin' AND lower(email) = 'admin@unitnavigator.com' THEN 'super_admin' ELSE role END,
      'active',
      created_at
    FROM users_old_admin_migration;
    DROP TABLE users_old_admin_migration;
    PRAGMA foreign_keys = ON;
  `);
}

db.prepare(`
  UPDATE users
  SET role = 'super_admin', status = 'active'
  WHERE lower(email) = 'admin@unitnavigator.com'
`).run();

module.exports = db;
