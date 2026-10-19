'use strict';
// Per-deal customer document checklist. Tracks what a deal needs (ID, pay
// stubs, proof of residence, insurance, lender stipulations, signatures,
// dealer-defined items) and where each item stands. Status only: no files or
// document contents are stored, nothing is sent to anyone, and nothing runs on
// a schedule. Every status change writes an append-only event row and a deal
// activity entry in the same transaction.
//
// Signature items may link an e-sign envelope on the same deal. A completed
// envelope makes the item's effective status "received" (it no longer counts
// as outstanding), but a dealer still approves it. The envelope is never
// modified here.

const STATUSES = ['required', 'received', 'approved', 'rejected', 'waived'];
const OUTSTANDING = new Set(['required', 'rejected']);
const ITEM_TYPES = {
  identification: { label: 'Identification', sensitive: true },
  pay_stubs: { label: 'Pay stubs', sensitive: true },
  proof_of_residence: { label: 'Proof of residence', sensitive: true },
  insurance: { label: 'Insurance', sensitive: false },
  lender_stipulation: { label: 'Lender stipulation', sensitive: false },
  signature: { label: 'Required signatures', sensitive: false },
  custom: { label: 'Other', sensitive: false },
};
const STANDARD_SETS = {
  cash: ['identification', 'insurance'],
  they_finance: ['identification', 'insurance'],
  we_finance: ['identification', 'pay_stubs', 'proof_of_residence', 'insurance', 'signature'],
  bhph: ['identification', 'pay_stubs', 'proof_of_residence', 'insurance', 'signature'],
};
// status -> { next status: who may make that change }. 'deals' = deals_manage,
// 'paperwork' = paperwork_manage. A reason is required where marked.
const TRANSITIONS = {
  required: { received: 'deals', waived: 'paperwork' },
  received: { approved: 'paperwork', rejected: 'paperwork', waived: 'paperwork' },
  rejected: { received: 'deals', waived: 'paperwork' },
  approved: { required: 'paperwork' },
  waived: { required: 'paperwork' },
};
const REASON_REQUIRED = new Set(['waived', 'rejected']);
const REOPEN = 'required';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS deal_checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    deal_id INTEGER NOT NULL,
    item_key TEXT NOT NULL CHECK(item_key IN ('identification','pay_stubs','proof_of_residence','insurance','lender_stipulation','signature','custom')),
    label TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'required' CHECK(status IN ('required','received','approved','rejected','waived')),
    due_date TEXT,
    esign_envelope_id INTEGER,
    note TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    updated_by INTEGER,
    updated_at TEXT NOT NULL,
    removed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_deal_checklist_items_deal ON deal_checklist_items (dealership_id, deal_id);

  CREATE TABLE IF NOT EXISTS deal_checklist_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    deal_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    actor_user_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deal_checklist_events_deal ON deal_checklist_events (dealership_id, deal_id);
`;

// SQL fragment counting a deal's outstanding items. `d` must be the deals
// alias. A signature item whose linked envelope (same deal and dealership) is
// completed is not outstanding.
const OUTSTANDING_COUNT_SQL = `(
  SELECT COUNT(*) FROM deal_checklist_items ci
  LEFT JOIN esign_envelopes ce ON ce.id = ci.esign_envelope_id AND ce.dealership_id = ci.dealership_id AND ce.deal_id = ci.deal_id
  WHERE ci.deal_id = d.id AND ci.dealership_id = d.dealership_id AND ci.removed_at IS NULL
    AND ci.status IN ('required','rejected')
    AND NOT (ci.item_key = 'signature' AND lower(COALESCE(ce.status, '')) = 'completed')
)`;

class ChecklistError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function cleanText(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function parseDueDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const t = Date.parse(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== text) {
    throw new ChecklistError('Due date must be a valid YYYY-MM-DD date.');
  }
  return text;
}

function loadDeal(db, dealershipId, dealId) {
  const id = Number(dealId);
  if (!Number.isInteger(id) || id <= 0) throw new ChecklistError('Deal not found', 404);
  const deal = db.prepare('SELECT id, deal_type, status FROM deals WHERE id = ? AND dealership_id = ?').get(id, dealershipId);
  if (!deal) throw new ChecklistError('Deal not found', 404);
  return deal;
}

function loadItem(db, dealershipId, dealId, itemId) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) throw new ChecklistError('Checklist item not found', 404);
  const item = db.prepare('SELECT * FROM deal_checklist_items WHERE id = ? AND deal_id = ? AND dealership_id = ? AND removed_at IS NULL')
    .get(id, dealId, dealershipId);
  if (!item) throw new ChecklistError('Checklist item not found', 404);
  return item;
}

function envelopeFor(db, dealershipId, dealId, envelopeId) {
  if (envelopeId === undefined || envelopeId === null || envelopeId === '') return null;
  const id = Number(envelopeId);
  const row = Number.isInteger(id) && id > 0
    ? db.prepare('SELECT id FROM esign_envelopes WHERE id = ? AND deal_id = ? AND dealership_id = ?').get(id, dealId, dealershipId)
    : null;
  if (!row) throw new ChecklistError('That e-sign packet does not belong to this deal.');
  return row.id;
}

function logDealActivity(db, dealershipId, dealId, action, note, userId) {
  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
    VALUES (?, 'deal', ?, ?, ?, ?)`).run(dealershipId, dealId, action, note, userId);
}

function insertItem(db, { dealershipId, dealId, itemKey, label, dueDate = null, envelopeId = null, note = null, actorId, stamp }) {
  const info = db.prepare(`INSERT INTO deal_checklist_items
    (dealership_id, deal_id, item_key, label, sensitive, status, due_date, esign_envelope_id, note, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, 'required', ?, ?, ?, ?, ?, ?, ?)`)
    .run(dealershipId, dealId, itemKey, label, ITEM_TYPES[itemKey].sensitive ? 1 : 0, dueDate, envelopeId, note, actorId, stamp, actorId, stamp);
  const id = Number(info.lastInsertRowid);
  db.prepare(`INSERT INTO deal_checklist_events (dealership_id, deal_id, item_id, from_status, to_status, reason, actor_user_id, created_at)
    VALUES (?, ?, ?, NULL, 'required', NULL, ?, ?)`).run(dealershipId, dealId, id, actorId, stamp);
  return id;
}

// Adds the standard items for the deal type. Explicit and idempotent: an item
// type already on the checklist is never added again.
function addStandardItems(db, { dealershipId, dealId, actorId, now = Date.now() }) {
  return db.transaction(() => {
    const deal = loadDeal(db, dealershipId, dealId);
    const wanted = STANDARD_SETS[deal.deal_type] || STANDARD_SETS.cash;
    const existing = new Set(db.prepare('SELECT item_key FROM deal_checklist_items WHERE deal_id = ? AND dealership_id = ? AND removed_at IS NULL')
      .all(deal.id, dealershipId).map(r => r.item_key));
    const stamp = new Date(now).toISOString();
    const added = wanted.filter(key => !existing.has(key));
    added.forEach(itemKey => insertItem(db, { dealershipId, dealId: deal.id, itemKey, label: ITEM_TYPES[itemKey].label, actorId, stamp }));
    if (added.length) logDealActivity(db, dealershipId, deal.id, 'Checklist: standard items added', added.map(k => ITEM_TYPES[k].label).join(', '), actorId);
    return { added: added.length };
  })();
}

function addItem(db, { dealershipId, dealId, actorId, body = {}, now = Date.now() }) {
  return db.transaction(() => {
    const deal = loadDeal(db, dealershipId, dealId);
    const itemKey = String(body.item_key || 'custom');
    if (!ITEM_TYPES[itemKey]) throw new ChecklistError('Choose a valid checklist item type.');
    const label = cleanText(body.label, 80) || ITEM_TYPES[itemKey].label;
    if (itemKey === 'custom' && !cleanText(body.label, 80)) throw new ChecklistError('Give the item a name.');
    const envelopeId = itemKey === 'signature' ? envelopeFor(db, dealershipId, deal.id, body.esign_envelope_id) : null;
    if (itemKey !== 'signature' && body.esign_envelope_id) throw new ChecklistError('Only signature items can link an e-sign packet.');
    const id = insertItem(db, {
      dealershipId, dealId: deal.id, itemKey, label, dueDate: parseDueDate(body.due_date), envelopeId,
      note: cleanText(body.note, 300), actorId, stamp: new Date(now).toISOString(),
    });
    logDealActivity(db, dealershipId, deal.id, 'Checklist: item added', label, actorId);
    return { id };
  })();
}

// can: { deals: bool, paperwork: bool }
function changeStatus(db, { dealershipId, dealId, itemId, actorId, body = {}, can, now = Date.now() }) {
  const to = String(body.status || '');
  if (!STATUSES.includes(to)) throw new ChecklistError('Choose a valid status.');
  return db.transaction(() => {
    const deal = loadDeal(db, dealershipId, dealId);
    const item = loadItem(db, dealershipId, deal.id, itemId);
    const who = (TRANSITIONS[item.status] || {})[to];
    if (!who) throw new ChecklistError(`An item that is ${item.status} cannot be marked ${to}.`, 409);
    if (who === 'paperwork' ? !can.paperwork : !can.deals) {
      throw new ChecklistError(who === 'paperwork' ? 'Approving, rejecting, waiving, or reopening needs paperwork permission.' : 'You do not have access to update this checklist.', 403);
    }
    const reason = cleanText(body.reason, 300);
    if ((REASON_REQUIRED.has(to) || to === REOPEN) && !reason) throw new ChecklistError('Give a reason for this change.');
    const stamp = new Date(now).toISOString();
    db.prepare('UPDATE deal_checklist_items SET status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND dealership_id = ?')
      .run(to, actorId, stamp, item.id, dealershipId);
    db.prepare(`INSERT INTO deal_checklist_events (dealership_id, deal_id, item_id, from_status, to_status, reason, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(dealershipId, deal.id, item.id, item.status, to, reason, actorId, stamp);
    // The label is safe for the timeline; reasons can describe a customer's
    // documents, so they stay in the checklist history only.
    logDealActivity(db, dealershipId, deal.id, 'Checklist updated', `${item.label}: ${item.status} → ${to}`, actorId);
    return { id: item.id, from: item.status, to };
  })();
}

// Only an untouched item (still required, no history beyond its creation)
// can be removed, and removal is soft so nothing recorded is lost.
function removeItem(db, { dealershipId, dealId, itemId, actorId, now = Date.now() }) {
  return db.transaction(() => {
    const deal = loadDeal(db, dealershipId, dealId);
    const item = loadItem(db, dealershipId, deal.id, itemId);
    const events = db.prepare('SELECT COUNT(*) AS n FROM deal_checklist_events WHERE item_id = ? AND dealership_id = ?').get(item.id, dealershipId).n;
    if (item.status !== 'required' || events > 1) throw new ChecklistError('Items with status history cannot be removed. Waive it instead.', 409);
    db.prepare('UPDATE deal_checklist_items SET removed_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND dealership_id = ?')
      .run(new Date(now).toISOString(), actorId, new Date(now).toISOString(), item.id, dealershipId);
    logDealActivity(db, dealershipId, deal.id, 'Checklist: item removed', item.label, actorId);
    return { id: item.id };
  })();
}

function effectiveStatus(item, envelopeStatus) {
  if (item.item_key === 'signature' && String(envelopeStatus || '').toLowerCase() === 'completed' && ['required', 'rejected', 'received'].includes(item.status)) {
    return 'received';
  }
  return item.status;
}

// canSeeSensitive: paperwork_manage or credit_pull. Notes and reasons on
// sensitive items are withheld otherwise; labels and statuses are not private.
function listChecklist(db, { dealershipId, dealId, canSeeSensitive }) {
  const deal = loadDeal(db, dealershipId, dealId);
  const rows = db.prepare(`
    SELECT i.*, e.status AS envelope_status, e.title AS envelope_title
    FROM deal_checklist_items i
    LEFT JOIN esign_envelopes e ON e.id = i.esign_envelope_id AND e.dealership_id = i.dealership_id AND e.deal_id = i.deal_id
    WHERE i.deal_id = ? AND i.dealership_id = ? AND i.removed_at IS NULL
    ORDER BY i.id
  `).all(deal.id, dealershipId);
  const events = db.prepare(`
    SELECT ev.item_id, ev.from_status, ev.to_status, ev.reason, ev.created_at, u.name AS actor_name
    FROM deal_checklist_events ev LEFT JOIN users u ON u.id = ev.actor_user_id AND u.dealership_id = ev.dealership_id
    WHERE ev.deal_id = ? AND ev.dealership_id = ? ORDER BY ev.id
  `).all(deal.id, dealershipId);
  const items = rows.map(row => {
    const hide = row.sensitive && !canSeeSensitive;
    return {
      id: row.id,
      item_key: row.item_key,
      label: row.label,
      sensitive: Boolean(row.sensitive),
      status: row.status,
      effective_status: effectiveStatus(row, row.envelope_status),
      due_date: row.due_date,
      esign_envelope_id: row.esign_envelope_id,
      envelope_status: row.esign_envelope_id ? row.envelope_status || null : null,
      note: hide ? null : row.note,
      note_hidden: Boolean(hide && row.note),
      updated_at: row.updated_at,
      history: events.filter(ev => ev.item_id === row.id).map(ev => ({
        from_status: ev.from_status, to_status: ev.to_status, created_at: ev.created_at, actor_name: ev.actor_name,
        reason: hide ? null : ev.reason,
      })),
    };
  });
  const outstanding = items.filter(i => OUTSTANDING.has(i.effective_status)).length;
  return { deal_id: deal.id, deal_type: deal.deal_type, items, summary: { total: items.length, outstanding } };
}

function outstandingCount(db, dealershipId, dealId) {
  return db.prepare(`SELECT ${OUTSTANDING_COUNT_SQL} AS n FROM deals d WHERE d.id = ? AND d.dealership_id = ?`).get(dealId, dealershipId)?.n || 0;
}

function deleteForDeals(db, dealershipId, dealIds) {
  const items = db.prepare('DELETE FROM deal_checklist_items WHERE deal_id = ? AND dealership_id = ?');
  const events = db.prepare('DELETE FROM deal_checklist_events WHERE deal_id = ? AND dealership_id = ?');
  dealIds.forEach(id => { events.run(id, dealershipId); items.run(id, dealershipId); });
}

function deleteForDealership(db, dealershipId) {
  db.prepare('DELETE FROM deal_checklist_events WHERE dealership_id = ?').run(dealershipId);
  db.prepare('DELETE FROM deal_checklist_items WHERE dealership_id = ?').run(dealershipId);
}

module.exports = {
  SCHEMA_SQL, STATUSES, ITEM_TYPES, STANDARD_SETS, OUTSTANDING_COUNT_SQL, ChecklistError,
  addStandardItems, addItem, changeStatus, removeItem, listChecklist, effectiveStatus, outstandingCount,
  deleteForDeals, deleteForDealership,
};
