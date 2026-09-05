'use strict';
const router = require('express').Router();
const db = require('../database');
const { requireAuth, requirePermission, hasPermission } = require('../middleware/auth');

const UNIT_STAGES = new Set(['acquired','transport','screening','recon','ready','pending','sold','archived']);
const DEAL_ACTIONS = new Set(['still_pending','dead','vehicle_changed','closed']);
const USER_ACTIONS = new Set(['keep_active','revoke']);

function daysOld(value) {
  if (!value) return 0;
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

function vehicleName(row) {
  return [row.year, row.make, row.model].filter(Boolean).join(' ') || 'Untitled Unit';
}

function customerName(row) {
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown Customer';
}

function dueDeal(row) {
  const age = daysOld(row.created_at);
  if (age < 3) return false;
  if (!row.last_status_check_at) return true;
  return daysOld(row.last_status_check_at) >= 3;
}

function unitMilestone(row) {
  const age = daysOld(row.created_at);
  if (age < 30) return 0;
  const milestone = Math.floor(age / 30) * 30;
  if (!row.last_age_check_at) return milestone;
  const checkedMilestone = Math.floor(daysOld(row.last_age_check_at) / 30) * 30;
  return milestone > checkedMilestone ? milestone : 0;
}

function getDealAlerts(dealershipId) {
  return db.prepare(`
    SELECT d.*, c.first_name, c.last_name, c.phone, c.email, u.year, u.make, u.model, u.vin
    FROM deals d
    LEFT JOIN customers c ON c.id = d.customer_id
    LEFT JOIN units u ON u.id = d.unit_id
    WHERE d.dealership_id = ? AND d.status = 'pending'
    ORDER BY d.created_at ASC
  `).all(dealershipId)
    .filter(dueDeal)
    .map(row => ({
      id: row.id,
      type: 'deal',
      age_days: daysOld(row.created_at),
      customer_name: customerName(row),
      phone: row.phone,
      email: row.email,
      vehicle: vehicleName(row),
      unit_id: row.unit_id,
      created_at: row.created_at,
    }));
}

function getUnitAlerts(dealershipId) {
  return db.prepare(`
    SELECT * FROM units
    WHERE dealership_id = ? AND stage NOT IN ('sold','archived')
    ORDER BY created_at ASC
  `).all(dealershipId)
    .map(row => ({ row, milestone: unitMilestone(row) }))
    .filter(item => item.milestone > 0)
    .map(({ row, milestone }) => ({
      id: row.id,
      type: 'unit',
      age_days: daysOld(row.created_at),
      milestone,
      vehicle: vehicleName(row),
      vin: row.vin,
      stage: row.stage,
      created_at: row.created_at,
    }));
}

function getStaleUserAlerts(req) {
  if (!hasPermission(req.user, 'users_manage')) return [];
  return db.prepare(`
    SELECT id, name, email, role, last_login_at, created_at
    FROM users
    WHERE dealership_id = ?
      AND status = 'active'
      AND id != ?
      AND datetime(COALESCE(last_login_at, created_at)) <= datetime('now', '-30 days')
    ORDER BY COALESCE(last_login_at, created_at) ASC
    LIMIT 10
  `).all(req.user.dealership_id, req.user.id).map(row => ({
    id: row.id,
    type: 'user',
    name: row.name,
    email: row.email,
    role: row.role,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    age_days: daysOld(row.last_login_at || row.created_at),
  }));
}

router.get('/', ...requirePermission('reports_view'), (req, res) => {
  const dealershipId = req.user.dealership_id;
  const dealAlerts = getDealAlerts(dealershipId);
  const unitAlerts = getUnitAlerts(dealershipId);
  const staleUserAlerts = getStaleUserAlerts(req);

  const unitsMissingPhotos = db.prepare(`
    SELECT COUNT(*) AS count FROM units
    WHERE dealership_id = ? AND stage NOT IN ('sold','archived')
      AND (photos IS NULL OR photos = '' OR photos = '[]')
  `).get(dealershipId).count || 0;

  const missingAcquisitionCost = db.prepare(`
    SELECT COUNT(*) AS count FROM units
    WHERE dealership_id = ? AND stage NOT IN ('sold','archived')
      AND (acquisition_cost IS NULL OR acquisition_cost <= 0)
  `).get(dealershipId).count || 0;

  const paperworkIncomplete = db.prepare(`
    SELECT COUNT(*) AS count FROM deals d
    WHERE d.dealership_id = ? AND d.status = 'pending'
      AND EXISTS (
        SELECT 1 FROM documents docs
        WHERE docs.deal_id = d.id AND docs.status = 'missing'
      )
  `).get(dealershipId).count || 0;

  res.json({
    metrics: {
      deals_need_follow_up: dealAlerts.length,
      units_missing_photos: unitsMissingPhotos,
      missing_acquisition_cost: missingAcquisitionCost,
      paperwork_incomplete: paperworkIncomplete,
      stale_user_logins: staleUserAlerts.length,
    },
    alerts: [...dealAlerts, ...unitAlerts, ...staleUserAlerts],
  });
});

router.post('/user-alert/:id/action', ...requirePermission('users_manage'), (req, res) => {
  const { action } = req.body;
  if (!USER_ACTIONS.has(action)) return res.status(400).json({ error: 'Invalid user action' });
  if (Number(req.params.id) === Number(req.user.id)) {
    return res.status(400).json({ error: 'You cannot change your own login from this alert' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (action === 'revoke') {
    db.prepare("UPDATE users SET status = 'revoked' WHERE id = ? AND dealership_id = ?")
      .run(req.params.id, req.user.dealership_id);
  } else {
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ? AND dealership_id = ?")
      .run(req.params.id, req.user.dealership_id);
  }

  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
    VALUES (?, 'user', ?, ?, ?, ?)`)
    .run(req.user.dealership_id, req.params.id, 'Stale user alert resolved', action, req.user.id);

  res.json({ ok: true });
});

router.post('/deal-alert/:id/action', ...requirePermission('deals_manage'), (req, res) => {
  const { action } = req.body;
  if (!DEAL_ACTIONS.has(action)) return res.status(400).json({ error: 'Invalid deal action' });

  const deal = db.prepare('SELECT * FROM deals WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  const now = new Date().toISOString();
  let status = deal.status;
  let closedAt = deal.closed_at;
  if (action === 'dead') status = 'dead';
  if (action === 'vehicle_changed') status = 'vehicle_changed';
  if (action === 'closed') {
    status = 'closed';
    closedAt = now;
    if (deal.unit_id) {
      db.prepare("UPDATE units SET stage = 'sold', sold_at = COALESCE(sold_at, ?) WHERE id = ? AND dealership_id = ?")
        .run(now, deal.unit_id, req.user.dealership_id);
    }
  }

  db.prepare(`
    UPDATE deals SET status = ?, closed_at = ?, last_status_check_at = ?
    WHERE id = ? AND dealership_id = ?
  `).run(status, closedAt, now, req.params.id, req.user.dealership_id);

  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
    VALUES (?, 'deal', ?, ?, ?, ?)`)
    .run(req.user.dealership_id, req.params.id, 'Deal alert resolved', action, req.user.id);

  res.json({ ok: true });
});

router.post('/unit-alert/:id/action', requireAuth, (req, res) => {
  if (!hasPermission(req.user, 'inventory_edit')) {
    return res.status(403).json({ error: 'You do not have access to update inventory alerts' });
  }
  if ((req.body?.stage === 'sold' || req.body?.sold_price) && !hasPermission(req.user, 'inventory_pricing')) {
    return res.status(403).json({ error: 'You do not have access to mark inventory sold' });
  }

  const { stage, customer_id, sold_price } = req.body;
  if (stage && !UNIT_STAGES.has(stage)) return res.status(400).json({ error: 'Invalid inventory stage' });

  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const now = new Date().toISOString();
  const targetStage = stage || unit.stage;
  const soldAt = targetStage === 'sold' ? now : unit.sold_at;

  db.prepare(`
    UPDATE units SET stage = ?, sold_at = ?, sold_price = COALESCE(?, sold_price), last_age_check_at = ?
    WHERE id = ? AND dealership_id = ?
  `).run(targetStage, soldAt, sold_price || null, now, req.params.id, req.user.dealership_id);

  if (targetStage === 'sold' && customer_id) {
    const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND dealership_id = ?')
      .get(customer_id, req.user.dealership_id);
    if (customer) {
      const existing = db.prepare(`
        SELECT id FROM deals
        WHERE unit_id = ? AND customer_id = ? AND dealership_id = ? AND status != 'dead'
        LIMIT 1
      `).get(req.params.id, customer_id, req.user.dealership_id);
      if (existing) {
        db.prepare("UPDATE deals SET status = 'closed', closed_at = COALESCE(closed_at, ?), last_status_check_at = ? WHERE id = ?")
          .run(now, now, existing.id);
      } else {
        db.prepare(`
          INSERT INTO deals (dealership_id, customer_id, unit_id, deal_type, status, last_status_check_at, closed_at)
          VALUES (?, ?, ?, 'cash', 'closed', ?, ?)
        `).run(req.user.dealership_id, customer_id, req.params.id, now, now);
      }
    }
  }

  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
    VALUES (?, 'unit', ?, ?, ?, ?)`)
    .run(req.user.dealership_id, req.params.id, 'Inventory age alert resolved', targetStage, req.user.id);

  res.json({ ok: true });
});

router.post('/unit-alerts/dismiss', requireAuth, (req, res) => {
  if (!hasPermission(req.user, 'inventory_edit')) {
    return res.status(403).json({ error: 'You do not have access to update inventory alerts' });
  }

  const now = new Date().toISOString();
  const unitAlerts = getUnitAlerts(req.user.dealership_id);
  const dismiss = db.transaction((alerts) => {
    const update = db.prepare(`
      UPDATE units SET last_age_check_at = ?
      WHERE id = ? AND dealership_id = ? AND stage NOT IN ('sold','archived')
    `);
    const log = db.prepare(`
      INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
      VALUES (?, 'unit', ?, 'Inventory age alert dismissed', ?, ?)
    `);
    alerts.forEach(alert => {
      update.run(now, alert.id, req.user.dealership_id);
      log.run(req.user.dealership_id, alert.id, `Reviewed at ${alert.milestone} day milestone`, req.user.id);
    });
  });
  dismiss(unitAlerts);

  res.json({ ok: true, dismissed: unitAlerts.length });
});

module.exports = router;
