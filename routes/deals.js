'use strict';
const router = require('express').Router();
const db = require('../database');
const { safeText, safePhone } = require('../services/csv');
const { buildFollowUpDraft, FollowUpError } = require('../services/followUpDraft');
const { requireAuth, requirePermission, hasPermission } = require('../middleware/auth');
const dealChecklist = require('../services/dealChecklist');
const { closeDeal, checklistWarning } = require('../services/dealClose');

const VALID_STATUSES = new Set(['pending', 'closed', 'dead', 'vehicle_changed']);
const VALID_DEAL_TYPES = new Set(['we_finance', 'bhph', 'they_finance', 'cash']);

function labelDealType(type) {
  return {
    we_finance: 'We Finance',
    bhph: 'BHPH',
    they_finance: 'They Finance',
    cash: 'Cash',
  }[type] || 'Deal';
}

function dealerEmail(req) {
  return req.user?.email || '';
}

function dealSelect() {
  return `
    SELECT
      d.*,
      c.first_name, c.last_name, c.phone, c.email,
      u.year, u.make, u.model, u.vin,
      -- Outstanding checklist items (required or rejected; a signature item
      -- with a completed e-sign packet is not outstanding).
      ${dealChecklist.OUTSTANDING_COUNT_SQL} AS missing_docs,
      (
        SELECT a.action FROM activity_logs a
        WHERE a.entity_type = 'deal' AND a.entity_id = d.id
        ORDER BY a.created_at DESC LIMIT 1
      ) AS last_activity
    FROM deals d
    LEFT JOIN customers c ON c.id = d.customer_id
    LEFT JOIN units u ON u.id = d.unit_id
    WHERE d.dealership_id = ?
  `;
}

function enrichDeal(row) {
  const customer_name = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown Customer';
  const vehicle = [row.year, row.make, row.model].filter(Boolean).join(' ') || 'No vehicle selected';
  return {
    ...row,
    customer_name,
    vehicle,
    deal_type_label: labelDealType(row.deal_type),
    missing_docs: Number(row.missing_docs || 0),
    last_activity: row.last_activity || (row.closed_at ? 'Closed' : 'Deal started'),
  };
}

function logDeal(req, id, action, note) {
  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
    VALUES (?, 'deal', ?, ?, ?, ?)`).run(req.user.dealership_id, id, action, note || null, req.user.id);
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: 'New', last_name: 'Customer' };
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts.at(-1) };
}

router.get('/', ...requirePermission('deals_view'), (req, res) => {
  const { status, q } = req.query;
  let sql = dealSelect();
  const params = [req.user.dealership_id];

  if (status && status !== 'all') {
    sql += ' AND d.status = ?';
    params.push(status);
  } else {
    sql += " AND d.status != 'dead'";
  }

  if (q) {
    sql += ` AND (
      c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?
      OR u.make LIKE ? OR u.model LIKE ? OR u.vin LIKE ?
    )`;
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like);
  }

  sql += ` ORDER BY
    CASE WHEN d.next_follow_up_at IS NULL THEN 1 ELSE 0 END,
    d.next_follow_up_at ASC,
    d.created_at DESC`;

  const deals = db.prepare(sql).all(...params).map(enrichDeal);
  res.json({ deals });
});

router.post('/', ...requirePermission('deals_manage'), (req, res) => {
  const body = req.body || {};
  const dealType = VALID_DEAL_TYPES.has(body.deal_type) ? body.deal_type : 'they_finance';
  const customerBody = body.customer || {};
  let customerId = Number(body.customer_id) || null;
  const unitId = Number(body.unit_id) || null;

  if (customerId) {
    const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND dealership_id = ?')
      .get(customerId, req.user.dealership_id);
    if (!customer) return res.status(400).json({ error: 'Selected customer was not found for this dealership' });
  } else {
    const { first_name, last_name } = splitName(customerBody.name);
    const info = db.prepare(`
      INSERT INTO customers (dealership_id, first_name, last_name, phone, email, address, id_number)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.dealership_id,
      first_name,
      last_name,
      customerBody.phone || null,
      customerBody.email || null,
      customerBody.address || null,
      customerBody.id_number || customerBody.idNumber || null
    );
    customerId = info.lastInsertRowid;
  }

  if (unitId) {
    const unit = db.prepare('SELECT id FROM units WHERE id = ? AND dealership_id = ?')
      .get(unitId, req.user.dealership_id);
    if (!unit) return res.status(400).json({ error: 'Selected vehicle was not found for this dealership' });
  }

  const nextFollowUp = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const deal = db.prepare(`
    INSERT INTO deals (dealership_id, customer_id, unit_id, deal_type, status, next_follow_up_at, last_status_check_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(req.user.dealership_id, customerId, unitId || null, dealType, nextFollowUp, new Date().toISOString());

  if (unitId) {
    db.prepare(`
      UPDATE units
      SET stage = 'pending'
      WHERE id = ? AND dealership_id = ? AND stage NOT IN ('sold','archived')
    `).run(unitId, req.user.dealership_id);
  }

  logDeal(req, deal.lastInsertRowid, 'Deal started', body.source || 'Started from paperwork builder');
  const created = db.prepare(`${dealSelect()} AND d.id = ?`).get(req.user.dealership_id, deal.lastInsertRowid);
  res.status(201).json({ deal: enrichDeal(created) });
});

router.get('/export/contacts.csv', ...requirePermission('reports_view'), (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT
      COALESCE(c.first_name, '') AS first_name,
      COALESCE(c.last_name, '') AS last_name,
      COALESCE(c.email, '') AS email,
      COALESCE(c.phone, '') AS phone,
      COALESCE(d.status, '') AS deal_status,
      COALESCE(d.deal_type, '') AS deal_type
    FROM customers c
    LEFT JOIN deals d ON d.customer_id = c.id AND d.dealership_id = c.dealership_id
    WHERE c.dealership_id = ?
    ORDER BY c.last_name, c.first_name
  `).all(req.user.dealership_id);

  // Every cell is always quoted (unchanged), and text that a spreadsheet would
  // run as a formula is neutralized first. Phone numbers keep a legitimate
  // leading "+" (see safePhone).
  const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [
    ['First Name', 'Last Name', 'Email', 'Phone', 'Deal Status', 'Deal Type'].map(quote).join(','),
    ...rows.map(row => [
      safeText(row.first_name), safeText(row.last_name), safeText(row.email),
      safePhone(row.phone), safeText(row.deal_status), safeText(row.deal_type),
    ].map(quote).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="unit-navigator-contacts.csv"');
  res.send(`\uFEFF${csv}`);
});

// Follow-up DRAFT for a pending deal: text only. This route reads data and
// returns a suggestion; it sends nothing and writes nothing (no deal,
// customer, price, task, workflow, or activity-log change). AI is used only
// when the caller explicitly sets `ai: true`; otherwise the draft comes from a
// deterministic template.
router.post('/:id/follow-up-draft', ...requirePermission('deals_manage'), async (req, res) => {
  try {
    const body = req.body || {};
    res.json(await buildFollowUpDraft({
      db, dealershipId: req.user.dealership_id, userId: req.user.id, dealId: req.params.id,
      channel: body.channel, useAi: body.ai === true,
    }));
  } catch (err) {
    if (err instanceof FollowUpError) return res.status(err.statusCode).json({ error: err.message });
    console.error('[follow-up-draft] unexpected error:', err.message);
    res.status(500).json({ error: 'Could not prepare a follow-up draft' });
  }
});

router.post('/:id/email-reminder', ...requirePermission('deals_manage'), (req, res) => {
  const deal = db.prepare(`${dealSelect()} AND d.id = ?`).get(req.user.dealership_id, req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  const enriched = enrichDeal(deal);
  const subject = `Deal follow-up: ${enriched.customer_name}`;
  const body = [
    `${enriched.customer_name} needs follow-up.`,
    `Vehicle: ${enriched.vehicle}`,
    `Deal type: ${enriched.deal_type_label}`,
    `Next follow-up: ${enriched.next_follow_up_at || 'Not set'}`,
    `Missing docs: ${enriched.missing_docs}`,
    '',
    'Generated by Unit Navigator.',
  ].join('\n');
  const mailto = `mailto:${encodeURIComponent(dealerEmail(req))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  logDeal(req, req.params.id, 'Reminder email prepared', `Mailto generated for ${dealerEmail(req)}`);
  res.json({
    ok: true,
    mailto,
    message: 'Email provider is not configured yet. Opening this link lets the dealer send the reminder from their mail app.',
  });
});

router.patch('/:id/status', ...requirePermission('deals_manage'), (req, res) => {
  const { status } = req.body || {};
  if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid deal status' });

  const deal = db.prepare('SELECT * FROM deals WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  // Closing uses the shared close (deal + retail-sold disposition for its
  // active vehicle, atomically), the same as the dashboard deal alert.
  let result = null;
  try {
    db.transaction(() => {
      if (status === 'closed' && deal.status !== 'closed') {
        result = closeDeal(db, { dealershipId: req.user.dealership_id, dealId: deal.id, actorId: req.user.id });
      } else {
        const closedAt = status === 'closed' ? deal.closed_at : null;
        db.prepare('UPDATE deals SET status = ?, closed_at = ? WHERE id = ? AND dealership_id = ?')
          .run(status, closedAt, deal.id, req.user.dealership_id);
      }
      logDeal(req, deal.id, 'Deal status changed', `${deal.status} -> ${status}`);
    })();
  } catch (err) {
    console.error('Deal status change failed', err);
    return res.status(500).json({ error: 'Could not update the deal. Nothing was changed.' });
  }

  const updated = db.prepare(`${dealSelect()} AND d.id = ?`).get(req.user.dealership_id, deal.id);
  const warning = result ? checklistWarning(result.outstanding_checklist_items) : null;
  res.json({ deal: enrichDeal(updated), ...(warning ? { warning } : {}) });
});

router.patch('/:id/follow-up', ...requirePermission('deals_manage'), (req, res) => {
  const { next_follow_up_at } = req.body;
  const deal = db.prepare('SELECT * FROM deals WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  db.prepare('UPDATE deals SET next_follow_up_at = ? WHERE id = ? AND dealership_id = ?')
    .run(next_follow_up_at || null, req.params.id, req.user.dealership_id);

  logDeal(req, req.params.id, 'Follow-up changed', next_follow_up_at || 'Follow-up cleared');
  const updated = db.prepare(`${dealSelect()} AND d.id = ?`).get(req.user.dealership_id, req.params.id);
  res.json({ deal: enrichDeal(updated) });
});

// ── Customer document checklist ───────────────────────────────────────────
// Status tracking only: no files are stored and nothing is sent. Labels and
// statuses are visible with deals_view; notes and reasons on sensitive items
// need paperwork_manage or credit_pull.
function checklistError(res, err) {
  if (err instanceof dealChecklist.ChecklistError) return res.status(err.statusCode).json({ error: err.message });
  console.error('Checklist request failed', err);
  return res.status(500).json({ error: 'Could not update the checklist' });
}

function checklistFor(req) {
  return dealChecklist.listChecklist(db, {
    dealershipId: req.user.dealership_id,
    dealId: req.params.id,
    canSeeSensitive: hasPermission(req.user, 'paperwork_manage') || hasPermission(req.user, 'credit_pull'),
  });
}

router.get('/:id/checklist', ...requirePermission('deals_view'), (req, res) => {
  try { res.json(checklistFor(req)); } catch (err) { checklistError(res, err); }
});

router.post('/:id/checklist/standard', ...requirePermission('deals_manage'), (req, res) => {
  try {
    const result = dealChecklist.addStandardItems(db, { dealershipId: req.user.dealership_id, dealId: req.params.id, actorId: req.user.id });
    res.json({ ...result, ...checklistFor(req) });
  } catch (err) { checklistError(res, err); }
});

router.post('/:id/checklist', ...requirePermission('deals_manage'), (req, res) => {
  try {
    const result = dealChecklist.addItem(db, { dealershipId: req.user.dealership_id, dealId: req.params.id, actorId: req.user.id, body: req.body || {} });
    res.status(201).json({ ...result, ...checklistFor(req) });
  } catch (err) { checklistError(res, err); }
});

router.patch('/:id/checklist/:itemId', requireAuth, (req, res) => {
  const can = { deals: hasPermission(req.user, 'deals_manage'), paperwork: hasPermission(req.user, 'paperwork_manage') };
  if (!can.deals && !can.paperwork) return res.status(403).json({ error: 'You do not have access to update this checklist.' });
  try {
    const result = dealChecklist.changeStatus(db, {
      dealershipId: req.user.dealership_id, dealId: req.params.id, itemId: req.params.itemId, actorId: req.user.id, body: req.body || {}, can,
    });
    res.json({ ...result, ...checklistFor(req) });
  } catch (err) { checklistError(res, err); }
});

router.delete('/:id/checklist/:itemId', ...requirePermission('deals_manage'), (req, res) => {
  try {
    dealChecklist.removeItem(db, { dealershipId: req.user.dealership_id, dealId: req.params.id, itemId: req.params.itemId, actorId: req.user.id });
    res.json(checklistFor(req));
  } catch (err) { checklistError(res, err); }
});

router.delete('/:id', ...requirePermission('deals_manage'), (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  db.transaction(() => {
    dealChecklist.deleteForDeals(db, req.user.dealership_id, [deal.id]);
    db.prepare('DELETE FROM documents WHERE deal_id = ? AND dealership_id = ?').run(deal.id, req.user.dealership_id);
    db.prepare('DELETE FROM activity_logs WHERE entity_type = ? AND entity_id = ? AND dealership_id = ?')
      .run('deal', deal.id, req.user.dealership_id);
    db.prepare('DELETE FROM deals WHERE id = ? AND dealership_id = ?').run(deal.id, req.user.dealership_id);
  })();

  res.json({ ok: true });
});

module.exports = router;
