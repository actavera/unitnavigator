'use strict';
// Proves the inventory-truth migration is additive and idempotent on a
// database that predates it: existing dealerships get the 30-day interval,
// existing units stay unassigned, existing last_age_check_at values survive,
// and nothing needs a manual step. Runs database.js in a fresh process against
// a throwaway data directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');

function runMigration(dataDir) {
  execFileSync(process.execPath, ['-e', "require('./database.js')"], {
    cwd: REPO_ROOT,
    env: { ...process.env, UNITNAV_DATA_DIR: dataDir },
    stdio: 'pipe',
  });
}

test('upgrades a pre-feature database (inventory truth and deal checklist) without touching existing data, idempotently', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-truth-migration-'));
  try {
    runMigration(dataDir);
    const dbPath = path.join(dataDir, 'unitnavigator.db');

    // Turn it into a database from before this feature: no new columns or tables.
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE unit_assignments;
      DROP TABLE unit_dispositions;
      DROP TABLE deal_checklist_items;
      DROP TABLE deal_checklist_events;
      DROP TABLE communication_consents;
      DROP TABLE communication_messages;
      DROP TABLE deal_reminder_state;
      DROP TABLE title_cases;
      DROP TABLE title_case_events;
      ALTER TABLE units DROP COLUMN assigned_user_id;
      ALTER TABLE dealerships DROP COLUMN inventory_review_interval_days;
    `);
    const dealershipId = Number(legacy.prepare("INSERT INTO dealerships (name, status) VALUES ('Legacy Motors', 'active')").run().lastInsertRowid);
    const unitId = Number(legacy.prepare(`INSERT INTO units (dealership_id, vin, stage, created_at, last_age_check_at)
      VALUES (?, 'LEGACYVIN00000001', 'ready', '2026-01-01 00:00:00', '2026-09-20T10:00:00.000Z')`).run(dealershipId).lastInsertRowid);
    legacy.close();

    runMigration(dataDir);
    runMigration(dataDir);

    const db = new Database(dbPath, { readonly: true });
    try {
      assert.ok(db.prepare('PRAGMA table_info(units)').all().some(c => c.name === 'assigned_user_id'));
      assert.equal(db.prepare('SELECT inventory_review_interval_days AS d FROM dealerships WHERE id = ?').get(dealershipId).d, 30);
      assert.deepEqual(db.prepare('SELECT reminders_email_enabled AS e, reminders_sms_enabled AS s FROM dealerships WHERE id = ?').get(dealershipId), { e: 0, s: 0 }, 'existing dealerships start with reminders off');
      const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(unitId);
      assert.equal(unit.assigned_user_id, null);
      assert.equal(unit.last_age_check_at, '2026-09-20T10:00:00.000Z');
      assert.equal(unit.stage, 'ready');
      for (const table of ['unit_assignments', 'unit_dispositions', 'deal_checklist_items', 'deal_checklist_events', 'communication_consents', 'communication_messages', 'deal_reminder_state', 'title_cases', 'title_case_events']) {
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} exists`);
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
