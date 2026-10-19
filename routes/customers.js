'use strict';
const router = require('express').Router();
const db = require('../database');
const dealChecklist = require('../services/dealChecklist');
const reminders = require('../services/reminders');
const titleCases = require('../services/titleCases');
const { requireAuth, requirePermission, hasPermission } = require('../middleware/auth');

// Client records hold personal and financial data, so access is tiered by the
// permissions a person already has for the work that needs it:
//   basic    (deals_view, deals_manage, paperwork_manage, credit_pull):
//            name, phone, email, and deal/vehicle history;
//   identity (paperwork_manage, credit_pull): also address, ID number,
//            employer, and monthly income;
//   credit   (credit_pull): also credit pulls, scores, and credit status.
// Anything outside a person's tier is never selected, returned, searched, or
// filtered on, so it can neither be read nor probed through search results.
const BASIC_PERMISSIONS = ['deals_view', 'deals_manage', 'paperwork_manage', 'credit_pull'];

function customerAccess(user) {
  return {
    basic: BASIC_PERMISSIONS.some(permission => hasPermission(user, permission)),
    identity: hasPermission(user, 'paperwork_manage') || hasPermission(user, 'credit_pull'),
    credit: hasPermission(user, 'credit_pull'),
  };
}

function requireCustomerAccess(req, res, next) {
  req.customerAccess = customerAccess(req.user);
  if (!req.customerAccess.basic) return res.status(403).json({ error: 'You do not have access to client records' });
  next();
}

function safeLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(10, Math.min(100, Math.floor(n)));
}

function searchTerm(q) {
  const cleaned = String(q || '').trim();
  return cleaned ? `%${cleaned}%` : null;
}

function customerSelect(access) {
  const identityColumns = access.identity ? 'c.address, c.id_number, c.employer, c.monthly_income,' : '';
  const creditColumns = access.credit ? `
      MAX(cp.pulled_at) AS last_credit_at,
      (
        SELECT cp2.provider_status
        FROM credit_pulls cp2
        WHERE cp2.customer_id = c.id AND cp2.dealership_id = c.dealership_id
        ORDER BY cp2.pulled_at DESC
        LIMIT 1
      ) AS last_credit_status,
      (
        SELECT cp3.score_placeholder
        FROM credit_pulls cp3
        WHERE cp3.customer_id = c.id AND cp3.dealership_id = c.dealership_id
        ORDER BY cp3.pulled_at DESC
        LIMIT 1
      ) AS last_score,
      COUNT(DISTINCT cp.id) AS credit_count,` : '';
  const creditJoin = access.credit ? 'LEFT JOIN credit_pulls cp ON cp.customer_id = c.id AND cp.dealership_id = c.dealership_id' : '';
  return `
    SELECT
      c.id,
      c.first_name,
      c.last_name,
      c.phone,
      c.email,
      ${identityColumns}
      c.created_at,${creditColumns}
      COUNT(DISTINCT d.id) AS deal_count,
      MAX(d.created_at) AS last_deal_at,
      (
        SELECT d2.status
        FROM deals d2
        WHERE d2.customer_id = c.id AND d2.dealership_id = c.dealership_id
        ORDER BY COALESCE(d2.closed_at, d2.created_at) DESC
        LIMIT 1
      ) AS last_deal_status,
      (
        SELECT d3.deal_type
        FROM deals d3
        WHERE d3.customer_id = c.id AND d3.dealership_id = c.dealership_id
        ORDER BY COALESCE(d3.closed_at, d3.created_at) DESC
        LIMIT 1
      ) AS last_deal_type,
      (
        SELECT TRIM(COALESCE(u.year, '') || ' ' || COALESCE(u.make, '') || ' ' || COALESCE(u.model, ''))
        FROM deals d4
        LEFT JOIN units u ON u.id = d4.unit_id AND u.dealership_id = d4.dealership_id
        WHERE d4.customer_id = c.id AND d4.dealership_id = c.dealership_id
        ORDER BY COALESCE(d4.closed_at, d4.created_at) DESC
        LIMIT 1
      ) AS last_vehicle,
      (
        SELECT u2.vin
        FROM deals d5
        LEFT JOIN units u2 ON u2.id = d5.unit_id AND u2.dealership_id = d5.dealership_id
        WHERE d5.customer_id = c.id AND d5.dealership_id = c.dealership_id
        ORDER BY COALESCE(d5.closed_at, d5.created_at) DESC
        LIMIT 1
      ) AS last_vin
    FROM customers c
    ${creditJoin}
    LEFT JOIN deals d ON d.customer_id = c.id AND d.dealership_id = c.dealership_id
    LEFT JOIN units u_search ON u_search.id = d.unit_id AND u_search.dealership_id = c.dealership_id
    WHERE c.dealership_id = ?
  `;
}

function enrich(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unnamed Client';
  const out = {
    ...row,
    name,
    deal_count: Number(row.deal_count || 0),
    last_vehicle: row.last_vehicle && row.last_vehicle.trim() ? row.last_vehicle.trim() : null,
  };
  // Only present for people allowed to see credit data; never defaulted to 0.
  if ('credit_count' in row) out.credit_count = Number(row.credit_count || 0);
  return out;
}

router.get('/', requireAuth, requireCustomerAccess, (req, res) => {
  const access = req.customerAccess;
  const { q, credit, deal, sort } = req.query;
  const limit = safeLimit(req.query.limit);
  let sql = customerSelect(access);
  const params = [req.user.dealership_id];
  const term = searchTerm(q);

  if (term) {
    // Search only the columns this person is allowed to see.
    const columns = [
      'c.first_name', 'c.last_name', "(c.first_name || ' ' || c.last_name)", 'c.phone', 'c.email',
      'u_search.make', 'u_search.model', 'u_search.vin',
    ];
    if (access.identity) columns.push('c.address', 'c.id_number', 'c.employer');
    if (access.credit) columns.push('cp.vehicle_interest', 'cp.result_summary');
    sql += ` AND (${columns.map(column => `${column} LIKE ?`).join(' OR ')})`;
    columns.forEach(() => params.push(term));
  }

  // Filtering or sorting on credit data would reveal it, so both apply only
  // to people with credit access and are ignored for everyone else.
  if (access.credit && credit && credit !== 'all') {
    if (credit === 'none') {
      sql += ' AND cp.id IS NULL';
    } else {
      sql += ' AND cp.provider_status = ?';
      params.push(credit);
    }
  }

  if (deal && deal !== 'all') {
    if (deal === 'none') {
      sql += ' AND d.id IS NULL';
    } else {
      sql += ' AND d.status = ?';
      params.push(deal);
    }
  }

  sql += ' GROUP BY c.id';

  if (sort === 'name') {
    sql += ' ORDER BY c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE';
  } else if (sort === 'credit' && access.credit) {
    sql += ' ORDER BY CASE WHEN last_credit_at IS NULL THEN 1 ELSE 0 END, last_credit_at DESC, c.created_at DESC';
  } else if (sort === 'deal') {
    sql += ' ORDER BY CASE WHEN last_deal_at IS NULL THEN 1 ELSE 0 END, last_deal_at DESC, c.created_at DESC';
  } else if (access.credit) {
    sql += ' ORDER BY MAX(COALESCE(cp.pulled_at, d.created_at, c.created_at)) DESC, c.created_at DESC';
  } else {
    sql += ' ORDER BY MAX(COALESCE(d.created_at, c.created_at)) DESC, c.created_at DESC';
  }

  sql += ' LIMIT ?';
  params.push(limit);

  const customers = db.prepare(sql).all(...params).map(enrich);
  res.json({ customers });
});

router.get('/:id', requireAuth, requireCustomerAccess, (req, res) => {
  const access = req.customerAccess;
  const identityColumns = access.identity ? ', address, id_number, employer, monthly_income' : '';
  const customer = db.prepare(`
    SELECT id, first_name, last_name, phone, email, created_at${identityColumns}
    FROM customers WHERE id = ? AND dealership_id = ?
  `).get(req.params.id, req.user.dealership_id);
  if (!customer) return res.status(404).json({ error: 'Client not found' });

  const deals = db.prepare(`
    SELECT d.id, d.status, d.deal_type, d.next_follow_up_at, d.created_at, d.closed_at,
           u.year, u.make, u.model, u.vin
    FROM deals d
    LEFT JOIN units u ON u.id = d.unit_id AND u.dealership_id = d.dealership_id
    WHERE d.customer_id = ? AND d.dealership_id = ?
    ORDER BY d.created_at DESC
  `).all(req.params.id, req.user.dealership_id).map(row => ({
    ...row,
    vehicle: [row.year, row.make, row.model].filter(Boolean).join(' ') || null,
  }));

  const payload = { customer: enrich(customer), deals };
  if (access.credit) {
    payload.credit_pulls = db.prepare(`
      SELECT id, provider_status, score_placeholder, vehicle_interest, result_summary, notes, pulled_at
      FROM credit_pulls
      WHERE customer_id = ? AND dealership_id = ?
      ORDER BY pulled_at DESC
    `).all(req.params.id, req.user.dealership_id);
  }
  res.json(payload);
});

router.delete('/:id', ...requirePermission('deals_manage'), (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!customer) return res.status(404).json({ error: 'Client not found' });

  const closedDeal = db.prepare(`
    SELECT id FROM deals
    WHERE customer_id = ? AND dealership_id = ? AND status = 'closed'
    LIMIT 1
  `).get(req.params.id, req.user.dealership_id);
  if (closedDeal) {
    return res.status(400).json({ error: 'This client has a closed deal. Keep the record for deal history instead of deleting it.' });
  }

  const signedPacket = db.prepare(`
    SELECT ee.id
    FROM esign_envelopes ee
    JOIN deals d ON d.id = ee.deal_id
    WHERE d.customer_id = ? AND ee.dealership_id = ?
    LIMIT 1
  `).get(req.params.id, req.user.dealership_id);
  if (signedPacket) {
    return res.status(400).json({ error: 'This client has an e-sign packet. Keep the record for paperwork history instead of deleting it.' });
  }

  const tx = db.transaction(() => {
    const dealIds = db.prepare('SELECT id FROM deals WHERE customer_id = ? AND dealership_id = ?')
      .all(req.params.id, req.user.dealership_id)
      .map(row => row.id);

    dealChecklist.deleteForDeals(db, req.user.dealership_id, dealIds);
    reminders.deleteForDeals(db, req.user.dealership_id, dealIds);
    titleCases.deleteForDeals(db, req.user.dealership_id, dealIds);
    reminders.deleteForCustomer(db, req.user.dealership_id, Number(req.params.id));
    dealIds.forEach(id => {
      db.prepare('DELETE FROM documents WHERE deal_id = ? AND dealership_id = ?').run(id, req.user.dealership_id);
      db.prepare('DELETE FROM activity_logs WHERE entity_type = ? AND entity_id = ? AND dealership_id = ?')
        .run('deal', id, req.user.dealership_id);
    });

    db.prepare('DELETE FROM documents WHERE customer_id = ? AND dealership_id = ?').run(req.params.id, req.user.dealership_id);
    db.prepare('DELETE FROM deals WHERE customer_id = ? AND dealership_id = ?').run(req.params.id, req.user.dealership_id);
    db.prepare('DELETE FROM credit_pulls WHERE customer_id = ? AND dealership_id = ?').run(req.params.id, req.user.dealership_id);
    db.prepare('DELETE FROM activity_logs WHERE entity_type = ? AND entity_id = ? AND dealership_id = ?')
      .run('customer', req.params.id, req.user.dealership_id);
    db.prepare('DELETE FROM customers WHERE id = ? AND dealership_id = ?').run(req.params.id, req.user.dealership_id);
  });

  tx();
  res.json({ ok: true });
});

module.exports = router;
