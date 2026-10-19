'use strict';
// Title, plate, and registration tracking: one case per sold deal. A case
// records who is responsible, where the title, registration, and plate stand,
// the temporary tag, key dates, a blocking issue, and an internal note, with
// append-only history of every material change.
//
// Due and overdue states come only from dates the dealer entered (mainly the
// temporary-tag expiration). Nothing here encodes a state's legal deadlines,
// contacts the DMV or the customer, stores documents, or calls AI.
const inventoryTruth = require('./inventoryTruth');

const STATES = ['not_started', 'documents_needed', 'ready_to_submit', 'submitted', 'processing', 'received', 'delivered', 'completed', 'on_hold'];
const STATUS_FIELDS = ['status', 'title_status', 'registration_status', 'plate_status'];
const DATE_FIELDS = ['temp_tag_expires_on', 'submitted_on', 'received_on', 'delivered_on', 'completed_on'];
const TEXT_FIELDS = { temp_tag_number: 30, blocking_issue: 200, note: 500 };
const DUE_SOON_DAYS = 7;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS title_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    deal_id INTEGER NOT NULL,
    unit_id INTEGER,
    customer_id INTEGER,
    assigned_user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'not_started',
    title_status TEXT NOT NULL DEFAULT 'not_started',
    registration_status TEXT NOT NULL DEFAULT 'not_started',
    plate_status TEXT NOT NULL DEFAULT 'not_started',
    temp_tag_number TEXT,
    temp_tag_expires_on TEXT,
    submitted_on TEXT,
    received_on TEXT,
    delivered_on TEXT,
    completed_on TEXT,
    blocking_issue TEXT,
    note TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    updated_by INTEGER,
    updated_at TEXT NOT NULL,
    UNIQUE (dealership_id, deal_id)
  );
  CREATE INDEX IF NOT EXISTS idx_title_cases_dealership ON title_cases (dealership_id, status);

  CREATE TABLE IF NOT EXISTS title_case_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    case_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    actor_user_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_title_case_events_case ON title_case_events (dealership_id, case_id);
`;

class TitleCaseError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function cleanText(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function parseDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const t = Date.parse(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== text) {
    throw new TitleCaseError(`${field.replace(/_/g, ' ')} must be a valid YYYY-MM-DD date.`);
  }
  return text;
}

function todayIn(now) { return new Date(now).toISOString().slice(0, 10); }
function daysUntil(dateText, now) { return Math.round((Date.parse(`${dateText}T00:00:00Z`) - Date.parse(`${todayIn(now)}T00:00:00Z`)) / 86400000); }

// Urgency from dealer-entered dates and fields only.
//   overdue: temporary tag expiration date has passed
//   due:     tag expires within 7 days, or the case is blocked/on hold
function urgency(row, now = Date.now()) {
  if (row.status === 'completed') return { level: null, days_to_tag_expiry: null };
  const days = row.temp_tag_expires_on ? daysUntil(row.temp_tag_expires_on, now) : null;
  if (days !== null && days < 0) return { level: 'overdue', days_to_tag_expiry: days };
  if ((days !== null && days <= DUE_SOON_DAYS) || row.status === 'on_hold' || row.blocking_issue) return { level: 'due', days_to_tag_expiry: days };
  return { level: null, days_to_tag_expiry: days };
}

function logEvent(db, dealershipId, caseId, field, from, to, actorId, stamp) {
  db.prepare(`INSERT INTO title_case_events (dealership_id, case_id, field, from_value, to_value, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(dealershipId, caseId, field, from == null ? null : String(from), to == null ? null : String(to), actorId, stamp);
}

function logDealActivity(db, dealershipId, dealId, action, note, userId) {
  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id) VALUES (?, 'deal', ?, ?, ?, ?)`)
    .run(dealershipId, dealId, action, note, userId);
}

// Creates the case for a closed deal (idempotent: returns the existing one).
// Used automatically when a deal closes with a retail-sold disposition, and
// manually for sales recorded before this feature.
function createForDeal(db, { dealershipId, dealId, actorId, now = Date.now(), requireClosed = true }) {
  return db.transaction(() => {
    const deal = db.prepare('SELECT id, unit_id, customer_id, status FROM deals WHERE id = ? AND dealership_id = ?').get(Number(dealId), dealershipId);
    if (!deal) throw new TitleCaseError('Deal not found', 404);
    if (requireClosed && deal.status !== 'closed') throw new TitleCaseError('Title and registration cases are for closed (sold) deals.', 409);
    const existing = db.prepare('SELECT id FROM title_cases WHERE dealership_id = ? AND deal_id = ?').get(dealershipId, deal.id);
    if (existing) return { id: existing.id, created: false };
    const stamp = new Date(now).toISOString();
    const id = Number(db.prepare(`INSERT INTO title_cases (dealership_id, deal_id, unit_id, customer_id, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(dealershipId, deal.id, deal.unit_id, deal.customer_id, actorId, stamp, actorId, stamp).lastInsertRowid);
    logEvent(db, dealershipId, id, 'created', null, 'not_started', actorId, stamp);
    logDealActivity(db, dealershipId, deal.id, 'Title & registration case opened', null, actorId);
    return { id, created: true };
  })();
}

function loadCase(db, dealershipId, caseId) {
  const id = Number(caseId);
  const row = Number.isInteger(id) && id > 0 ? db.prepare('SELECT * FROM title_cases WHERE id = ? AND dealership_id = ?').get(id, dealershipId) : null;
  if (!row) throw new TitleCaseError('Title case not found', 404);
  return row;
}

// Applies only the fields present in `body`; every real change is recorded.
function updateCase(db, { dealershipId, caseId, actorId, body = {}, now = Date.now() }) {
  return db.transaction(() => {
    const current = loadCase(db, dealershipId, caseId);
    const next = {};
    for (const field of STATUS_FIELDS) {
      if (!(field in body)) continue;
      if (!STATES.includes(body[field])) throw new TitleCaseError(`Choose a valid ${field.replace(/_/g, ' ')}.`);
      next[field] = body[field];
    }
    for (const field of DATE_FIELDS) if (field in body) next[field] = parseDate(body[field], field);
    for (const [field, max] of Object.entries(TEXT_FIELDS)) if (field in body) next[field] = cleanText(body[field], max);
    if ('assigned_user_id' in body) {
      if (body.assigned_user_id === null || body.assigned_user_id === '') next.assigned_user_id = null;
      else {
        const employee = inventoryTruth.activeEmployee(db, dealershipId, body.assigned_user_id);
        if (!employee) throw new TitleCaseError('Choose an active employee of this dealership.');
        next.assigned_user_id = employee.id;
      }
    }
    if (next.status === 'completed' && !('completed_on' in next) && !current.completed_on) next.completed_on = todayIn(now);

    const changed = Object.keys(next).filter(f => (current[f] ?? null) !== (next[f] ?? null));
    if (!changed.length) return { id: current.id, changed: [] };
    const stamp = new Date(now).toISOString();
    db.prepare(`UPDATE title_cases SET ${changed.map(f => `${f} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ? AND dealership_id = ?`)
      .run(...changed.map(f => next[f]), actorId, stamp, current.id, dealershipId);
    changed.forEach(f => logEvent(db, dealershipId, current.id, f, current[f], next[f], actorId, stamp));
    if (changed.includes('status')) logDealActivity(db, dealershipId, current.deal_id, 'Title & registration status', `${current.status} → ${next.status}`, actorId);
    return { id: current.id, changed };
  })();
}

const LIST_SELECT = `
  SELECT t.*, u.name AS assignee_name,
         c.first_name, c.last_name,
         v.year, v.make, v.model, v.stock_number
  FROM title_cases t
  LEFT JOIN users u ON u.id = t.assigned_user_id AND u.dealership_id = t.dealership_id AND u.status = 'active'
  LEFT JOIN customers c ON c.id = t.customer_id AND c.dealership_id = t.dealership_id
  LEFT JOIN units v ON v.id = t.unit_id AND v.dealership_id = t.dealership_id
`;

function shape(row, now) {
  return {
    ...row,
    customer_name: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown customer',
    vehicle: [row.year, row.make, row.model].filter(Boolean).join(' ') || 'No vehicle',
    assignee_name: row.assignee_name || null,
    ...urgency(row, now),
  };
}

// filter: open (default), due (due or overdue), overdue, completed, all.
function listCases(db, { dealershipId, filter = 'open', assignee, now = Date.now() }) {
  const rows = db.prepare(`${LIST_SELECT} WHERE t.dealership_id = ? ORDER BY t.temp_tag_expires_on IS NULL, t.temp_tag_expires_on, t.id`).all(dealershipId)
    .map(row => shape(row, now));
  return rows.filter(c => {
    if (assignee !== undefined && assignee !== '' && String(c.assigned_user_id ?? '') !== String(assignee === 'none' ? '' : assignee)) return false;
    if (filter === 'all') return true;
    if (filter === 'completed') return c.status === 'completed';
    if (c.status === 'completed') return false;
    if (filter === 'due') return Boolean(c.level);
    if (filter === 'overdue') return c.level === 'overdue';
    return true;
  });
}

function caseForDeal(db, { dealershipId, dealId, now = Date.now() }) {
  const deal = db.prepare('SELECT id, status FROM deals WHERE id = ? AND dealership_id = ?').get(Number(dealId), dealershipId);
  if (!deal) throw new TitleCaseError('Deal not found', 404);
  const row = db.prepare(`${LIST_SELECT} WHERE t.dealership_id = ? AND t.deal_id = ?`).get(dealershipId, deal.id);
  if (!row) return { deal_status: deal.status, case: null };
  const history = db.prepare(`SELECT e.field, e.from_value, e.to_value, e.created_at, u.name AS actor_name FROM title_case_events e
    LEFT JOIN users u ON u.id = e.actor_user_id AND u.dealership_id = e.dealership_id
    WHERE e.dealership_id = ? AND e.case_id = ? ORDER BY e.id DESC LIMIT 30`).all(dealershipId, row.id);
  return { deal_status: deal.status, case: { ...shape(row, now), history } };
}

function deleteForDeals(db, dealershipId, dealIds) {
  const ids = db.prepare('SELECT id FROM title_cases WHERE dealership_id = ? AND deal_id = ?');
  const events = db.prepare('DELETE FROM title_case_events WHERE dealership_id = ? AND case_id = ?');
  const cases = db.prepare('DELETE FROM title_cases WHERE dealership_id = ? AND deal_id = ?');
  dealIds.forEach(dealId => {
    const row = ids.get(dealershipId, dealId);
    if (row) events.run(dealershipId, row.id);
    cases.run(dealershipId, dealId);
  });
}

function deleteForDealership(db, dealershipId) {
  db.prepare('DELETE FROM title_case_events WHERE dealership_id = ?').run(dealershipId);
  db.prepare('DELETE FROM title_cases WHERE dealership_id = ?').run(dealershipId);
}

module.exports = {
  SCHEMA_SQL, STATES, DUE_SOON_DAYS, TitleCaseError, urgency,
  createForDeal, updateCase, listCases, caseForDeal, deleteForDeals, deleteForDealership,
};
