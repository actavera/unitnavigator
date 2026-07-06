'use strict';
const router = require('express').Router();
const db = require('../database');
const { requireAuth } = require('../middleware/auth');

function safeLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(10, Math.min(100, Math.floor(n)));
}

function searchTerm(q) {
  const cleaned = String(q || '').trim();
  return cleaned ? `%${cleaned}%` : null;
}

function customerSelect() {
  return `
    SELECT
      c.id,
      c.first_name,
      c.last_name,
      c.phone,
      c.email,
      c.address,
      c.id_number,
      c.employer,
      c.monthly_income,
      c.created_at,
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
      COUNT(DISTINCT cp.id) AS credit_count,
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
        LEFT JOIN units u ON u.id = d4.unit_id
        WHERE d4.customer_id = c.id AND d4.dealership_id = c.dealership_id
        ORDER BY COALESCE(d4.closed_at, d4.created_at) DESC
        LIMIT 1
      ) AS last_vehicle,
      (
        SELECT u2.vin
        FROM deals d5
        LEFT JOIN units u2 ON u2.id = d5.unit_id
        WHERE d5.customer_id = c.id AND d5.dealership_id = c.dealership_id
        ORDER BY COALESCE(d5.closed_at, d5.created_at) DESC
        LIMIT 1
      ) AS last_vin
    FROM customers c
    LEFT JOIN credit_pulls cp ON cp.customer_id = c.id AND cp.dealership_id = c.dealership_id
    LEFT JOIN deals d ON d.customer_id = c.id AND d.dealership_id = c.dealership_id
    LEFT JOIN units u_search ON u_search.id = d.unit_id AND u_search.dealership_id = c.dealership_id
    WHERE c.dealership_id = ?
  `;
}

function enrich(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unnamed Client';
  return {
    ...row,
    name,
    credit_count: Number(row.credit_count || 0),
    deal_count: Number(row.deal_count || 0),
    last_vehicle: row.last_vehicle && row.last_vehicle.trim() ? row.last_vehicle.trim() : null,
  };
}

router.get('/', requireAuth, (req, res) => {
  const { q, credit, deal, sort } = req.query;
  const limit = safeLimit(req.query.limit);
  let sql = customerSelect();
  const params = [req.user.dealership_id];
  const term = searchTerm(q);

  if (term) {
    sql += ` AND (
      c.first_name LIKE ? OR c.last_name LIKE ? OR
      (c.first_name || ' ' || c.last_name) LIKE ? OR
      c.phone LIKE ? OR c.email LIKE ? OR c.address LIKE ? OR
      c.id_number LIKE ? OR c.employer LIKE ? OR cp.vehicle_interest LIKE ? OR cp.result_summary LIKE ? OR
      u_search.make LIKE ? OR u_search.model LIKE ? OR u_search.vin LIKE ?
    )`;
    params.push(term, term, term, term, term, term, term, term, term, term, term, term, term);
  }

  if (credit && credit !== 'all') {
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
  } else if (sort === 'credit') {
    sql += ' ORDER BY CASE WHEN last_credit_at IS NULL THEN 1 ELSE 0 END, last_credit_at DESC, c.created_at DESC';
  } else if (sort === 'deal') {
    sql += ' ORDER BY CASE WHEN last_deal_at IS NULL THEN 1 ELSE 0 END, last_deal_at DESC, c.created_at DESC';
  } else {
    sql += ' ORDER BY MAX(COALESCE(cp.pulled_at, d.created_at, c.created_at)) DESC, c.created_at DESC';
  }

  sql += ' LIMIT ?';
  params.push(limit);

  const customers = db.prepare(sql).all(...params).map(enrich);
  res.json({ customers });
});

router.get('/:id', requireAuth, (req, res) => {
  const customer = db.prepare(`
    SELECT * FROM customers WHERE id = ? AND dealership_id = ?
  `).get(req.params.id, req.user.dealership_id);
  if (!customer) return res.status(404).json({ error: 'Client not found' });

  const credit_pulls = db.prepare(`
    SELECT * FROM credit_pulls
    WHERE customer_id = ? AND dealership_id = ?
    ORDER BY pulled_at DESC
  `).all(req.params.id, req.user.dealership_id);

  const deals = db.prepare(`
    SELECT d.*, u.year, u.make, u.model, u.vin
    FROM deals d
    LEFT JOIN units u ON u.id = d.unit_id
    WHERE d.customer_id = ? AND d.dealership_id = ?
    ORDER BY d.created_at DESC
  `).all(req.params.id, req.user.dealership_id).map(row => ({
    ...row,
    vehicle: [row.year, row.make, row.model].filter(Boolean).join(' ') || null,
  }));

  res.json({ customer: enrich(customer), credit_pulls, deals });
});

module.exports = router;
