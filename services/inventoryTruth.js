'use strict';
// Inventory truth: who is responsible for an active unit, when it is due for
// review, when an ignored review escalates, and what ultimately happened to
// it. Everything here is deterministic and dealership-scoped; nothing runs on
// a schedule, and nothing is sent to anyone. Due and escalated states are
// computed from existing data whenever the dashboard or priorities load.
//
// Assignment and disposition changes are append-only history tables, so a
// correction never erases what was recorded before. `activity_logs` keeps the
// human-readable timeline; amounts and internal notes stay out of it.

const DEFAULT_REVIEW_INTERVAL_DAYS = 30;
const MIN_REVIEW_INTERVAL_DAYS = 7;
const MAX_REVIEW_INTERVAL_DAYS = 90;

const DISPOSITIONS = {
  retail_sold: 'Retail sold',
  wholesale: 'Wholesale',
  traded_to_dealer: 'Traded to another dealer',
  auction: 'Sent to auction',
  junked_salvaged: 'Junked or salvaged',
  returned_to_seller: 'Returned to seller',
  duplicate_error: 'Duplicate or entered in error',
};
// Outcomes where an amount/value makes sense. A duplicate or mistaken entry
// never has one.
const AMOUNT_OUTCOMES = new Set(['retail_sold', 'wholesale', 'traded_to_dealer', 'auction', 'junked_salvaged', 'returned_to_seller']);
const TERMINAL_STAGES = new Set(['sold', 'archived']);
const MAX_AMOUNT = 10_000_000;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS unit_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    unit_id INTEGER NOT NULL,
    previous_user_id INTEGER,
    new_user_id INTEGER,
    actor_user_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_unit_assignments_unit ON unit_assignments (dealership_id, unit_id);

  CREATE TABLE IF NOT EXISTS unit_dispositions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    unit_id INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('retail_sold','wholesale','traded_to_dealer','auction','junked_salvaged','returned_to_seller','duplicate_error')),
    disposition_date TEXT NOT NULL,
    amount REAL,
    destination TEXT,
    note TEXT,
    previous_stage TEXT,
    actor_user_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    superseded_at TEXT,
    superseded_by INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_unit_dispositions_unit ON unit_dispositions (dealership_id, unit_id);
`;

class InventoryTruthError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function cleanText(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function validInterval(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_REVIEW_INTERVAL_DAYS && n <= MAX_REVIEW_INTERVAL_DAYS;
}

function reviewInterval(db, dealershipId) {
  const row = db.prepare('SELECT inventory_review_interval_days AS days FROM dealerships WHERE id = ?').get(dealershipId);
  return row && validInterval(row.days) ? row.days : DEFAULT_REVIEW_INTERVAL_DAYS;
}

function parseTime(value) {
  if (!value) return NaN;
  const text = String(value);
  // SQLite datetime('now') values have no zone marker; they are UTC.
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) || !/\d\d:\d\d/.test(text) ? text : `${text.replace(' ', 'T')}Z`).getTime();
}

function wholeDaysSince(value, now) {
  const t = parseTime(value);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86400000));
}

// A unit is due once a full interval has passed since its most recent
// verification (or since it was created, if never verified). It escalates once
// the due review has been ignored for another full interval.
function reviewState(unit, intervalDays, now = Date.now()) {
  const interval = validInterval(intervalDays) ? intervalDays : DEFAULT_REVIEW_INTERVAL_DAYS;
  const base = unit.last_age_check_at || unit.created_at;
  const daysSinceReview = wholeDaysSince(base, now);
  const active = !TERMINAL_STAGES.has(unit.stage);
  const due = active && daysSinceReview >= interval;
  const baseTime = parseTime(base);
  return {
    review_interval_days: interval,
    days_since_review: daysSinceReview,
    due,
    escalated: due && daysSinceReview >= interval * 2,
    overdue_days: due ? daysSinceReview - interval : 0,
    next_review_at: active && Number.isFinite(baseTime) ? new Date(baseTime + interval * 86400000).toISOString() : null,
  };
}

function loadUnit(db, dealershipId, unitId) {
  const id = Number(unitId);
  if (!Number.isInteger(id) || id <= 0) throw new InventoryTruthError('Unit not found', 404);
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?').get(id, dealershipId);
  if (!unit) throw new InventoryTruthError('Unit not found', 404);
  return unit;
}

function activeEmployee(db, dealershipId, userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare("SELECT id, name FROM users WHERE id = ? AND dealership_id = ? AND status = 'active'").get(id, dealershipId) || null;
}

function assignableUsers(db, dealershipId) {
  return db.prepare("SELECT id, name FROM users WHERE dealership_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE, id").all(dealershipId);
}

function logUnitActivity(db, dealershipId, unitId, action, note, userId) {
  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
    VALUES (?, 'unit', ?, ?, ?, ?)`).run(dealershipId, unitId, action, note, userId);
}

function nameOf(db, dealershipId, userId) {
  if (!userId) return 'Unassigned';
  const row = db.prepare('SELECT name FROM users WHERE id = ? AND dealership_id = ?').get(userId, dealershipId);
  return row ? row.name : 'Former employee';
}

// userId null/undefined/'' unassigns. Only an active employee of the same
// dealership can be assigned, and only to an active (not sold/archived) unit.
function assignUnit(db, { dealershipId, unitId, userId, actorId }) {
  return db.transaction(() => {
    const unit = loadUnit(db, dealershipId, unitId);
    const unassign = userId === null || userId === undefined || userId === '';
    let target = null;
    if (!unassign) {
      if (TERMINAL_STAGES.has(unit.stage)) throw new InventoryTruthError('Sold or archived units cannot be assigned.', 409);
      target = activeEmployee(db, dealershipId, userId);
      if (!target) throw new InventoryTruthError('Choose an active employee of this dealership.', 400);
    }
    const newUserId = target ? target.id : null;
    const previousUserId = unit.assigned_user_id || null;
    if (previousUserId === newUserId) return { changed: false, assigned_user_id: newUserId };

    db.prepare('UPDATE units SET assigned_user_id = ? WHERE id = ? AND dealership_id = ?').run(newUserId, unit.id, dealershipId);
    db.prepare(`INSERT INTO unit_assignments (dealership_id, unit_id, previous_user_id, new_user_id, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(dealershipId, unit.id, previousUserId, newUserId, actorId, new Date().toISOString());
    logUnitActivity(db, dealershipId, unit.id, newUserId ? 'Assigned' : 'Unassigned',
      `${nameOf(db, dealershipId, previousUserId)} → ${target ? target.name : 'Unassigned'}`, actorId);
    return { changed: true, assigned_user_id: newUserId };
  })();
}

// Records that someone confirmed the unit's current status. Resets the review
// clock. If the review had escalated, the resolution is logged as well.
function recordVerification(db, { dealershipId, unit, actorId, now = Date.now(), action = 'Inventory verified', note }) {
  const state = reviewState(unit, reviewInterval(db, dealershipId), now);
  const stamp = new Date(now).toISOString();
  db.prepare('UPDATE units SET last_age_check_at = ? WHERE id = ? AND dealership_id = ?').run(stamp, unit.id, dealershipId);
  logUnitActivity(db, dealershipId, unit.id, action, note, actorId);
  if (state.escalated) {
    logUnitActivity(db, dealershipId, unit.id, 'Escalation resolved', `Review was ${state.overdue_days} days overdue`, actorId);
  }
  return state;
}

function verifyUnit(db, { dealershipId, unitId, actorId, now = Date.now(), stageLabel = s => s }) {
  return db.transaction(() => {
    const unit = loadUnit(db, dealershipId, unitId);
    if (TERMINAL_STAGES.has(unit.stage)) throw new InventoryTruthError('Sold or archived units do not need review.', 409);
    const state = recordVerification(db, { dealershipId, unit, actorId, now, note: `Status confirmed: ${stageLabel(unit.stage)}` });
    return { verified_at: new Date(now).toISOString(), was_escalated: state.escalated };
  })();
}

function parseDispositionDate(value, now) {
  if (value === undefined || value === null || value === '') return new Date(now).toISOString().slice(0, 10);
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new InventoryTruthError('Disposition date must be YYYY-MM-DD.');
  const t = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== text) throw new InventoryTruthError('Disposition date is not a valid date.');
  if (t > now + 86400000) throw new InventoryTruthError('Disposition date cannot be in the future.');
  return text;
}

function parseAmount(value, outcome) {
  if (value === undefined || value === null || value === '') return null;
  if (!AMOUNT_OUTCOMES.has(outcome)) throw new InventoryTruthError('This outcome does not take an amount.');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) throw new InventoryTruthError('Amount must be a number between 0 and 10,000,000.');
  return Math.round(n * 100) / 100;
}

// Pricing comparables (platform_sold_units) are captured only from retail
// sales that have a price. Moved here from routes/inventory.js unchanged so the
// disposition flow can keep comparables in step with the unit.
function capturePlatformSoldUnit(db, unit) {
  if (!unit || unit.stage !== 'sold' || !(Number(unit.sold_price) > 0)) return;
  const dealer = db.prepare('SELECT zip FROM dealerships WHERE id = ?').get(unit.dealership_id) || {};
  const daysInInventory = unit.created_at && unit.sold_at
    ? Math.max(0, Math.round((parseTime(unit.sold_at) - parseTime(unit.created_at)) / 86400000))
    : null;
  db.prepare(`
    INSERT INTO platform_sold_units (
      dealership_id, unit_id, year, make, model, trim, mileage, recon_cost,
      final_listing_price, sold_price, market_zip, sold_at, days_in_inventory, updated_at
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(unit_id) DO UPDATE SET
      dealership_id = excluded.dealership_id,
      year = excluded.year,
      make = excluded.make,
      model = excluded.model,
      trim = excluded.trim,
      mileage = excluded.mileage,
      recon_cost = excluded.recon_cost,
      final_listing_price = excluded.final_listing_price,
      sold_price = excluded.sold_price,
      market_zip = excluded.market_zip,
      sold_at = excluded.sold_at,
      days_in_inventory = excluded.days_in_inventory,
      updated_at = datetime('now')
  `).run(
    unit.dealership_id, unit.id, unit.year, unit.make, unit.model, unit.trim, unit.mileage || 0,
    unit.repair_cost || 0, unit.asking_price || null, unit.sold_price || null, dealer.zip || null,
    unit.sold_at || new Date().toISOString(), Number.isFinite(daysInInventory) ? daysInInventory : null,
  );
}

// Keeps the comparable record exactly in step with the unit: present for a
// priced retail sale, absent otherwise.
function syncPlatformSold(db, dealershipId, unitId) {
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?').get(unitId, dealershipId);
  if (unit && unit.stage === 'sold' && Number(unit.sold_price) > 0) capturePlatformSoldUnit(db, unit);
  else db.prepare('DELETE FROM platform_sold_units WHERE unit_id = ? AND dealership_id = ?').run(unitId, dealershipId);
}

function hasTruthHistory(db, dealershipId, unitId) {
  return Boolean(
    db.prepare('SELECT 1 FROM unit_assignments WHERE dealership_id = ? AND unit_id = ? LIMIT 1').get(dealershipId, unitId)
    || db.prepare('SELECT 1 FROM unit_dispositions WHERE dealership_id = ? AND unit_id = ? LIMIT 1').get(dealershipId, unitId),
  );
}

function activeDisposition(db, dealershipId, unitId) {
  return db.prepare(`SELECT * FROM unit_dispositions
    WHERE dealership_id = ? AND unit_id = ? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(dealershipId, unitId) || null;
}

// Retail sold uses the existing `sold` stage; every other outcome uses the
// existing non-public `archived` stage. Nothing is deleted. A new disposition
// on an already-disposed unit is a correction: the previous record is marked
// superseded, never changed or removed.
function recordDisposition(db, { dealershipId, unitId, actorId, body = {}, canPrice, now = Date.now() }) {
  const outcome = String(body.outcome || '');
  if (!DISPOSITIONS[outcome]) throw new InventoryTruthError('Choose a valid disposition outcome.');
  return db.transaction(() => {
    const unit = loadUnit(db, dealershipId, unitId);
    // Retail sold, and changing anything about a unit already marked sold,
    // stay behind the existing sold/pricing permission.
    if ((outcome === 'retail_sold' || unit.stage === 'sold') && !canPrice) {
      throw new InventoryTruthError('You do not have access to mark inventory sold or change a sale.', 403);
    }
    const date = parseDispositionDate(body.disposition_date, now);
    const amount = parseAmount(body.amount, outcome);
    const destination = cleanText(body.destination, 120);
    const note = cleanText(body.note, 500);
    const stamp = new Date(now).toISOString();

    const current = activeDisposition(db, dealershipId, unit.id);
    const info = db.prepare(`INSERT INTO unit_dispositions
      (dealership_id, unit_id, outcome, disposition_date, amount, destination, note, previous_stage, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(dealershipId, unit.id, outcome, date, amount, destination, note, unit.stage, actorId, stamp);
    const id = Number(info.lastInsertRowid);
    if (current) {
      db.prepare('UPDATE unit_dispositions SET superseded_at = ?, superseded_by = ? WHERE id = ? AND dealership_id = ?')
        .run(stamp, id, current.id, dealershipId);
    }

    // The unit's terminal fields always mirror the latest disposition, so a
    // correction replaces stale sale or archive values instead of keeping them.
    if (outcome === 'retail_sold') {
      db.prepare(`UPDATE units SET stage = 'sold', sold_at = ?, sold_price = ?, archived_at = NULL
        WHERE id = ? AND dealership_id = ?`).run(`${date}T00:00:00.000Z`, amount, unit.id, dealershipId);
    } else {
      db.prepare(`UPDATE units SET stage = 'archived', archived_at = ?, sold_at = NULL, sold_price = NULL
        WHERE id = ? AND dealership_id = ?`).run(`${date}T00:00:00.000Z`, unit.id, dealershipId);
    }
    syncPlatformSold(db, dealershipId, unit.id);
    logUnitActivity(db, dealershipId, unit.id, current ? 'Disposition corrected' : 'Disposition recorded',
      [DISPOSITIONS[outcome], destination ? `to ${destination}` : null, date].filter(Boolean).join(' · '), actorId);
    return { id, outcome, superseded: current ? current.id : null };
  })();
}

// Moving a disposed unit back into active inventory (for example, a sale that
// unwound). Terminal fields are cleared and any pricing comparable removed. If
// a structured disposition exists it is marked superseded (kept, never
// deleted); units sold or archived before dispositions existed get no
// fabricated history. Returns whether a disposition was reversed.
function reverseDisposition(db, { dealershipId, unitId, actorId, now = Date.now() }) {
  const current = activeDisposition(db, dealershipId, unitId);
  db.prepare('UPDATE units SET sold_at = NULL, sold_price = NULL, archived_at = NULL WHERE id = ? AND dealership_id = ?').run(unitId, dealershipId);
  db.prepare('DELETE FROM platform_sold_units WHERE unit_id = ? AND dealership_id = ?').run(unitId, dealershipId);
  if (!current) return false;
  db.prepare('UPDATE unit_dispositions SET superseded_at = ? WHERE id = ? AND dealership_id = ?').run(new Date(now).toISOString(), current.id, dealershipId);
  logUnitActivity(db, dealershipId, unitId, 'Disposition reversed', `${DISPOSITIONS[current.outcome] || current.outcome} reversed; vehicle returned to inventory`, actorId);
  return true;
}

// History for the unit detail page. Amounts are pricing data: they are only
// returned to users who may see pricing.
function unitHistory(db, { dealershipId, unitId, canPrice }) {
  const dispositions = db.prepare(`
    SELECT d.id, d.outcome, d.disposition_date, d.amount, d.destination, d.note, d.previous_stage,
           d.created_at, d.superseded_at, d.superseded_by, u.name AS actor_name
    FROM unit_dispositions d LEFT JOIN users u ON u.id = d.actor_user_id AND u.dealership_id = d.dealership_id
    WHERE d.dealership_id = ? AND d.unit_id = ? ORDER BY d.id DESC
  `).all(dealershipId, unitId).map(row => {
    const out = { ...row, outcome_label: DISPOSITIONS[row.outcome] || row.outcome };
    if (!canPrice) delete out.amount;
    return out;
  });
  const assignments = db.prepare(`
    SELECT a.id, a.previous_user_id, a.new_user_id, a.created_at,
           p.name AS previous_name, n.name AS new_name, act.name AS actor_name
    FROM unit_assignments a
    LEFT JOIN users p ON p.id = a.previous_user_id AND p.dealership_id = a.dealership_id
    LEFT JOIN users n ON n.id = a.new_user_id AND n.dealership_id = a.dealership_id
    LEFT JOIN users act ON act.id = a.actor_user_id AND act.dealership_id = a.dealership_id
    WHERE a.dealership_id = ? AND a.unit_id = ? ORDER BY a.id DESC LIMIT 50
  `).all(dealershipId, unitId);
  return { dispositions, assignments };
}

module.exports = {
  SCHEMA_SQL, DISPOSITIONS, DEFAULT_REVIEW_INTERVAL_DAYS, MIN_REVIEW_INTERVAL_DAYS, MAX_REVIEW_INTERVAL_DAYS,
  InventoryTruthError, validInterval, reviewInterval, reviewState, assignableUsers, activeEmployee,
  assignUnit, verifyUnit, recordVerification, recordDisposition, reverseDisposition, unitHistory,
  capturePlatformSoldUnit, syncPlatformSold, hasTruthHistory, activeDisposition, TERMINAL_STAGES,
};
