'use strict';
// Internal usage visibility and add-on entitlements. Nothing here bills,
// charges, or limits anyone: it records AI provider attempts and exports, and
// stores which paid add-ons a dealership has been granted. The current AI
// features, the simple showroom, and base operations are part of the base
// product and are never gated by entitlements.

// Paid add-ons that do not exist yet; entitlements are ready for them.
const ADDON_FEATURES = {
  social_publishing: 'Social publishing',
  credit_addons: '700Credit product add-ons',
  market_pricing: 'Live market pricing',
  bhph_servicing: 'BHPH servicing',
};
const AI_FEATURES = ['listing_description', 'listing_bulk', 'priority_guidance', 'follow_up_rewrite'];

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    user_id INTEGER,
    feature TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('ok','error')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_dealership ON ai_usage (dealership_id, created_at);

  CREATE TABLE IF NOT EXISTS export_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    user_id INTEGER,
    export_type TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    filters TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_export_audit_dealership ON export_audit (dealership_id, created_at);

  CREATE TABLE IF NOT EXISTS dealership_entitlements (
    dealership_id INTEGER NOT NULL,
    feature TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    starts_on TEXT,
    ends_on TEXT,
    note TEXT,
    updated_by INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (dealership_id, feature)
  );

  CREATE TABLE IF NOT EXISTS entitlement_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    feature TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    starts_on TEXT,
    ends_on TEXT,
    note TEXT,
    actor_user_id INTEGER,
    created_at TEXT NOT NULL
  );
`;

class UsageError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function recordAi(db, { dealershipId, userId, feature, outcome, now = Date.now() }) {
  db.prepare('INSERT INTO ai_usage (dealership_id, user_id, feature, outcome, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(dealershipId, userId || null, feature, outcome, new Date(now).toISOString());
}

// Wraps a provider-calling function so each real attempt is recorded. A
// missing key means no provider was contacted, so nothing is recorded.
function metered(db, { dealershipId, userId, feature }, fn) {
  return async (...args) => {
    try {
      const result = await fn(...args);
      recordAi(db, { dealershipId, userId, feature, outcome: 'ok' });
      return result;
    } catch (err) {
      if (err && err.code !== 'missing_openai_key') recordAi(db, { dealershipId, userId, feature, outcome: 'error' });
      throw err;
    }
  };
}

function recordExport(db, { dealershipId, userId, exportType, rowCount, filters = null, now = Date.now() }) {
  db.prepare('INSERT INTO export_audit (dealership_id, user_id, export_type, row_count, filters, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(dealershipId, userId || null, exportType, rowCount, filters ? JSON.stringify(filters).slice(0, 300) : null, new Date(now).toISOString());
}

function monthStart(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// Dealership-level summary for dealership admins: this month's AI attempts
// and message sends, plus recent exports (who, what, how many rows).
function usageSummary(db, { dealershipId, now = Date.now() }) {
  const since = monthStart(now);
  const ai = db.prepare(`SELECT feature, COUNT(*) AS attempts, SUM(outcome = 'error') AS failures
    FROM ai_usage WHERE dealership_id = ? AND created_at >= ? GROUP BY feature ORDER BY feature`).all(dealershipId, since);
  const messaging = db.prepare(`SELECT channel, status, COUNT(*) AS count FROM communication_messages
    WHERE dealership_id = ? AND created_at >= ? GROUP BY channel, status ORDER BY channel, status`).all(dealershipId, since);
  const exports = db.prepare(`SELECT e.export_type, e.row_count, e.filters, e.created_at, u.name AS user_name
    FROM export_audit e LEFT JOIN users u ON u.id = e.user_id AND u.dealership_id = e.dealership_id
    WHERE e.dealership_id = ? ORDER BY e.id DESC LIMIT 50`).all(dealershipId);
  return { since, ai, messaging, exports, entitlements: listEntitlements(db, dealershipId, now) };
}

function parseDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const t = Date.parse(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== text) {
    throw new UsageError(`${field} must be a valid YYYY-MM-DD date.`);
  }
  return text;
}

function isActive(row, now) {
  if (!row || !row.enabled) return false;
  const today = new Date(now).toISOString().slice(0, 10);
  return (!row.starts_on || row.starts_on <= today) && (!row.ends_on || row.ends_on >= today);
}

function hasEntitlement(db, dealershipId, feature, now = Date.now()) {
  return isActive(db.prepare('SELECT * FROM dealership_entitlements WHERE dealership_id = ? AND feature = ?').get(dealershipId, feature), now);
}

function listEntitlements(db, dealershipId, now = Date.now()) {
  const rows = Object.fromEntries(db.prepare('SELECT * FROM dealership_entitlements WHERE dealership_id = ?').all(dealershipId).map(r => [r.feature, r]));
  return Object.entries(ADDON_FEATURES).map(([feature, label]) => {
    const row = rows[feature];
    return { feature, label, enabled: Boolean(row && row.enabled), starts_on: row?.starts_on || null, ends_on: row?.ends_on || null, note: row?.note || null, active: isActive(row, now) };
  });
}

// Platform-admin only (enforced by the route). Every change is recorded.
function setEntitlement(db, { dealershipId, feature, actorId, body = {}, now = Date.now() }) {
  if (!ADDON_FEATURES[feature]) throw new UsageError('Unknown add-on.');
  const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1' ? 1 : 0;
  const startsOn = parseDate(body.starts_on, 'Start date');
  const endsOn = parseDate(body.ends_on, 'End date');
  if (startsOn && endsOn && endsOn < startsOn) throw new UsageError('End date must be on or after the start date.');
  const note = body.note ? String(body.note).replace(/\s+/g, ' ').trim().slice(0, 200) : null;
  const stamp = new Date(now).toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO dealership_entitlements (dealership_id, feature, enabled, starts_on, ends_on, note, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dealership_id, feature) DO UPDATE SET enabled = excluded.enabled, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
        note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(dealershipId, feature, enabled, startsOn, endsOn, note, actorId, stamp);
    db.prepare(`INSERT INTO entitlement_events (dealership_id, feature, enabled, starts_on, ends_on, note, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(dealershipId, feature, enabled, startsOn, endsOn, note, actorId, stamp);
  })();
  return listEntitlements(db, dealershipId, now);
}

function deleteForDealership(db, dealershipId) {
  for (const t of ['ai_usage', 'export_audit', 'dealership_entitlements', 'entitlement_events']) {
    db.prepare(`DELETE FROM ${t} WHERE dealership_id = ?`).run(dealershipId);
  }
}

module.exports = {
  SCHEMA_SQL, ADDON_FEATURES, AI_FEATURES, UsageError,
  recordAi, metered, recordExport, usageSummary, hasEntitlement, listEntitlements, setEntitlement, deleteForDealership,
};
