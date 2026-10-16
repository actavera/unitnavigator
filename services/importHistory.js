'use strict';
// Import history: one record per import attempt, with a bounded list of
// per-row issues. It deliberately stores NO row data beyond a minimal
// identifier (stock number, last six VIN characters, a year/make/model
// label): no prices, costs, minimum price, notes, or full VINs.
//
// Retention is lazy: every new batch prunes that dealership's records older
// than RETENTION_DAYS, so no scheduler is needed.

const RETENTION_DAYS = 180;
const MAX_ISSUES_PER_BATCH = 100;

// No foreign keys on purpose. User, dealership, and demo-cleanup deletes must
// never be blocked by history rows; deletion paths remove them explicitly.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    user_id INTEGER,
    kind TEXT NOT NULL,
    source TEXT,
    file_name TEXT,
    status TEXT NOT NULL,
    total_rows INTEGER DEFAULT 0,
    created INTEGER DEFAULT 0,
    updated INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    warning_count INTEGER DEFAULT 0,
    issues_truncated INTEGER DEFAULT 0,
    retry_of INTEGER,
    failure_message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_import_batches_dealership ON import_batches (dealership_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS import_batch_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    dealership_id INTEGER NOT NULL,
    row_number INTEGER,
    severity TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT,
    stock_number TEXT,
    vin_tail TEXT,
    vehicle TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_import_batch_issues_batch ON import_batch_issues (batch_id);
`;

const KINDS = new Set(['csv', 'dealercenter_sftp']);
const STATUSES = new Set(['completed', 'completed_with_errors', 'failed']);

function short(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function vinTail(vin) {
  return String(vin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-6);
}

function prune(db, dealershipId) {
  const cutoff = `-${RETENTION_DAYS} days`;
  db.prepare(`
    DELETE FROM import_batch_issues
    WHERE dealership_id = ? AND batch_id IN (
      SELECT id FROM import_batches WHERE dealership_id = ? AND created_at < datetime('now', ?)
    )
  `).run(dealershipId, dealershipId, cutoff);
  db.prepare("DELETE FROM import_batches WHERE dealership_id = ? AND created_at < datetime('now', ?)")
    .run(dealershipId, cutoff);
}

// Errors come before warnings so the cap never hides a row that failed.
function capIssues(issues) {
  return [...issues]
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
    .slice(0, MAX_ISSUES_PER_BATCH);
}

function recordBatch(db, {
  dealershipId, userId = null, kind, source = '', fileName = '', status, totalRows = 0,
  created = 0, updated = 0, skipped = 0, issues = [], retryOf = null, failureMessage = '',
}) {
  if (!KINDS.has(kind)) throw new Error(`Unknown import kind: ${kind}`);
  if (!STATUSES.has(status)) throw new Error(`Unknown import status: ${status}`);

  const stored = capIssues(issues);
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;

  const write = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO import_batches (dealership_id, user_id, kind, source, file_name, status, total_rows,
        created, updated, skipped, error_count, warning_count, issues_truncated, retry_of, failure_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dealershipId, userId, kind, short(source, 200), short(fileName, 200), status, totalRows,
      created, updated, skipped, errorCount, warningCount, issues.length > stored.length ? 1 : 0,
      retryOf, short(failureMessage, 300),
    );
    const batchId = Number(info.lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO import_batch_issues (batch_id, dealership_id, row_number, severity, code, message, stock_number, vin_tail, vehicle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const issue of stored) {
      insert.run(
        batchId, dealershipId, Number.isInteger(issue.row_number) ? issue.row_number : null,
        issue.severity === 'error' ? 'error' : 'warning', short(issue.code, 60), short(issue.message, 300),
        short(issue.stock_number, 60), vinTail(issue.vin_tail || issue.vin), short(issue.vehicle, 100),
      );
    }
    prune(db, dealershipId);
    return batchId;
  });
  return write();
}

function listBatches(db, dealershipId, { limit = 25, before = null } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const params = [dealershipId];
  let where = 'b.dealership_id = ?';
  if (Number.isInteger(Number(before)) && Number(before) > 0) {
    where += ' AND b.id < ?';
    params.push(Number(before));
  }
  return db.prepare(`
    SELECT b.id, b.kind, b.source, b.file_name, b.status, b.total_rows, b.created, b.updated, b.skipped,
           b.error_count, b.warning_count, b.issues_truncated, b.retry_of, b.failure_message, b.created_at,
           u.name AS imported_by
    FROM import_batches b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE ${where}
    ORDER BY b.id DESC
    LIMIT ?
  `).all(...params, capped);
}

function getBatch(db, dealershipId, id) {
  const batchId = Number(id);
  if (!Number.isInteger(batchId) || batchId <= 0) return null;
  const batch = db.prepare(`
    SELECT b.id, b.kind, b.source, b.file_name, b.status, b.total_rows, b.created, b.updated, b.skipped,
           b.error_count, b.warning_count, b.issues_truncated, b.retry_of, b.failure_message, b.created_at,
           u.name AS imported_by
    FROM import_batches b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.id = ? AND b.dealership_id = ?
  `).get(batchId, dealershipId);
  if (!batch) return null;
  const issues = db.prepare(`
    SELECT row_number, severity, code, message, stock_number, vin_tail, vehicle
    FROM import_batch_issues
    WHERE batch_id = ? AND dealership_id = ?
    ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END, row_number, id
  `).all(batchId, dealershipId);
  return { ...batch, issues };
}

function batchExists(db, dealershipId, id) {
  const batchId = Number(id);
  if (!Number.isInteger(batchId) || batchId <= 0) return false;
  return Boolean(db.prepare('SELECT 1 FROM import_batches WHERE id = ? AND dealership_id = ?').get(batchId, dealershipId));
}

function deleteForDealership(db, dealershipId) {
  db.prepare('DELETE FROM import_batch_issues WHERE dealership_id = ?').run(dealershipId);
  db.prepare('DELETE FROM import_batches WHERE dealership_id = ?').run(dealershipId);
}

module.exports = {
  RETENTION_DAYS, MAX_ISSUES_PER_BATCH, SCHEMA_SQL,
  recordBatch, listBatches, getBatch, batchExists, deleteForDealership, capIssues, vinTail,
};
