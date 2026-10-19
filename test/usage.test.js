'use strict';
// Service-level coverage for usage metering, export audit, and add-on
// entitlements (services/usage.js), plus permission-version compatibility
// for the dedicated contacts_export permission.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const usage = require('../services/usage');
const { parsePermissions } = require('../middleware/auth');

const NOW = Date.parse('2026-10-19T12:00:00Z');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, dealership_id INTEGER, name TEXT);
    CREATE TABLE communication_messages (id INTEGER PRIMARY KEY, dealership_id INTEGER, channel TEXT, status TEXT, created_at TEXT);`);
  db.exec(usage.SCHEMA_SQL);
  db.prepare("INSERT INTO users (id, dealership_id, name) VALUES (10, 1, 'Ann'), (20, 2, 'Bob')").run();
  return db;
}

test('metered() records each provider attempt, never a missing-key skip, and passes results and errors through', async () => {
  const db = freshDb();
  const ctx = { dealershipId: 1, userId: 10, feature: 'listing_description' };
  assert.equal(await usage.metered(db, ctx, async x => `ok:${x}`)('a'), 'ok:a');
  await assert.rejects(usage.metered(db, ctx, async () => { throw new Error('provider down'); })(), /provider down/);
  await assert.rejects(usage.metered(db, ctx, async () => { throw Object.assign(new Error('no key'), { code: 'missing_openai_key' }); })(), /no key/);
  assert.deepEqual(db.prepare('SELECT outcome FROM ai_usage ORDER BY id').all().map(r => r.outcome), ['ok', 'error']);
});

test('usage summary covers this month only and is dealership-scoped', () => {
  const db = freshDb();
  usage.recordAi(db, { dealershipId: 1, userId: 10, feature: 'follow_up_rewrite', outcome: 'ok', now: NOW });
  usage.recordAi(db, { dealershipId: 1, userId: 10, feature: 'follow_up_rewrite', outcome: 'error', now: NOW });
  usage.recordAi(db, { dealershipId: 1, userId: 10, feature: 'follow_up_rewrite', outcome: 'ok', now: Date.parse('2026-09-30T12:00:00Z') });
  usage.recordAi(db, { dealershipId: 2, userId: 20, feature: 'listing_bulk', outcome: 'ok', now: NOW });
  db.prepare("INSERT INTO communication_messages (dealership_id, channel, status, created_at) VALUES (1, 'sms', 'sent', '2026-10-05T00:00:00Z'), (1, 'sms', 'failed', '2026-10-06T00:00:00Z')").run();
  usage.recordExport(db, { dealershipId: 1, userId: 10, exportType: 'contacts', rowCount: 42, now: NOW });
  const s = usage.usageSummary(db, { dealershipId: 1, now: NOW });
  assert.deepEqual(s.ai.map(r => [r.feature, r.attempts, r.failures]), [['follow_up_rewrite', 2, 1]]);
  assert.deepEqual(s.messaging.map(r => [r.channel, r.status, r.count]), [['sms', 'failed', 1], ['sms', 'sent', 1]]);
  assert.deepEqual(s.exports.map(e => [e.export_type, e.row_count, e.user_name]), [['contacts', 42, 'Ann']]);
  assert.equal(s.entitlements.length, 4);
  assert.ok(s.entitlements.every(e => !e.active), 'no add-ons by default');
});

test('entitlements: validated, date-windowed, and every change recorded', () => {
  const db = freshDb();
  assert.throws(() => usage.setEntitlement(db, { dealershipId: 1, feature: 'ai_everything', actorId: 1, body: { enabled: true } }), e => e.statusCode === 400);
  assert.throws(() => usage.setEntitlement(db, { dealershipId: 1, feature: 'market_pricing', actorId: 1, body: { enabled: true, starts_on: '2026-11-01', ends_on: '2026-10-01' } }), e => e.statusCode === 400);
  usage.setEntitlement(db, { dealershipId: 1, feature: 'market_pricing', actorId: 1, body: { enabled: true, starts_on: '2026-10-01', ends_on: '2026-10-31', note: 'Trial' }, now: NOW });
  assert.equal(usage.hasEntitlement(db, 1, 'market_pricing', NOW), true);
  assert.equal(usage.hasEntitlement(db, 1, 'market_pricing', Date.parse('2026-11-02T00:00:00Z')), false, 'expires by date');
  assert.equal(usage.hasEntitlement(db, 2, 'market_pricing', NOW), false, 'per dealership');
  usage.setEntitlement(db, { dealershipId: 1, feature: 'market_pricing', actorId: 1, body: { enabled: false }, now: NOW });
  assert.equal(usage.hasEntitlement(db, 1, 'market_pricing', NOW), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entitlement_events WHERE dealership_id = 1').get().n, 2);
});

test('contacts_export: legacy permission rows keep export through reports_view; saved (v2) lists are exact', () => {
  assert.ok(parsePermissions(null, 'staff').includes('contacts_export'), 'legacy staff default keeps export');
  assert.ok(parsePermissions(JSON.stringify(['reports_view']), 'staff', 1).includes('contacts_export'));
  assert.ok(!parsePermissions(JSON.stringify(['deals_view']), 'staff', 1).includes('contacts_export'), 'never granted without reports_view');
  assert.ok(!parsePermissions(null, 'staff', 2).includes('contacts_export'), 'new staff default excludes export');
  assert.ok(!parsePermissions(JSON.stringify(['reports_view']), 'staff', 2).includes('contacts_export'));
  assert.ok(parsePermissions(JSON.stringify(['contacts_export']), 'staff', 2).includes('contacts_export'));
  assert.ok(parsePermissions(null, 'manager', 2).includes('contacts_export'));
});
