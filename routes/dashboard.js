'use strict';
const router = require('express').Router();
const db = require('../database');
const { requireAuth, requirePermission, hasPermission } = require('../middleware/auth');
const { generateBatchGuidance } = require('../services/priorityGuidance');
const inventoryTruth = require('../services/inventoryTruth');
const dealChecklist = require('../services/dealChecklist');
const { closeDeal, checklistWarning } = require('../services/dealClose');
const titleCases = require('../services/titleCases');
const usage = require('../services/usage');

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

function getDealAlerts(dealershipId) {
  return db.prepare(`
    SELECT d.*, c.first_name, c.last_name, c.phone, c.email, u.year, u.make, u.model, u.vin,
      ${dealChecklist.OUTSTANDING_COUNT_SQL} AS checklist_outstanding,
      (SELECT escalated_at FROM deal_reminder_state rs WHERE rs.dealership_id = d.dealership_id AND rs.deal_id = d.id) AS reminders_escalated_at
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
      checklist_outstanding: Number(row.checklist_outstanding || 0),
      reminders_escalated: Boolean(row.reminders_escalated_at) && Number(row.checklist_outstanding || 0) > 0,
    }));
}

// Inventory review alerts. Due and escalated states come from the
// dealership's review interval (default 30 days) and each unit's most recent
// verification, or its creation date when never verified. Deterministic: no
// scheduler and no AI decide what is overdue. Sold and archived units never
// alert.
function getUnitAlerts(dealershipId, now = Date.now()) {
  const interval = inventoryTruth.reviewInterval(db, dealershipId);
  return db.prepare(`
    SELECT u.*, a.name AS assignee_name
    FROM units u
    LEFT JOIN users a ON a.id = u.assigned_user_id AND a.dealership_id = u.dealership_id AND a.status = 'active'
    WHERE u.dealership_id = ? AND u.stage NOT IN ('sold','archived')
    ORDER BY u.created_at ASC
  `).all(dealershipId)
    .map(row => ({ row, review: inventoryTruth.reviewState(row, interval, now) }))
    .filter(item => item.review.due)
    .map(({ row, review }) => {
      const age = daysOld(row.created_at);
      return {
        id: row.id,
        type: 'unit',
        age_days: age,
        milestone: Math.floor(age / review.review_interval_days) * review.review_interval_days,
        vehicle: vehicleName(row),
        vin: row.vin,
        stage: row.stage,
        created_at: row.created_at,
        review_interval_days: review.review_interval_days,
        days_since_review: review.days_since_review,
        overdue_days: review.overdue_days,
        escalated: review.escalated,
        // An assignee who has since been revoked counts as unassigned.
        assigned_user_id: row.assignee_name ? row.assigned_user_id : null,
        assignee_name: row.assignee_name || null,
      };
    });
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

// --- "Today's Priorities": a deterministic, server-ranked view over the
// SAME alert queries above. Deliberately not a parallel detection system —
// getDealAlerts/getUnitAlerts/getStaleUserAlerts are the single source of
// truth for what counts as an alert; this section only reshapes and ranks
// their output.

// Title cases sit between deals and units: an expired or expiring temporary
// tag outranks aging inventory but not a stalled deal.
const PRIORITY_CATEGORY_ORDER = { deal: 0, title: 0.5, unit: 1, user: 2 };
// Priority level follows directly from category — pending/stalled deals are
// always High, aging inventory Medium, stale access Low — matching the
// required category ranking (deals > units > users) rather than a separate,
// independently-tunable scale.
const PRIORITY_LEVEL_BY_TYPE = { deal: 'high', title: 'medium', unit: 'medium', user: 'low' };

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Higher score = higher priority. Category dominates every other factor
// (deals always outrank units, units always outrank stale-user items);
// within a category, more days overdue outranks fewer; the id term at the
// end is a pure, deterministic tie-break for when age_days is identical
// (smaller id sorts first). It's divided down to a tiny fraction specifically
// so it can NEVER outweigh a single day of age difference, no matter how
// large an id grows over the life of the database — it only ever breaks a
// true tie, never overrides category or age. This is the entire ranking
// rule: no AI, no hidden weighting.
function priorityScore(type, ageDays, id) {
  const categoryRank = PRIORITY_CATEGORY_ORDER[type];
  return (2 - categoryRank) * 10_000_000 + Math.max(0, Number(ageDays) || 0) * 1000 - (Number(id) / 1e9);
}

function checklistNote(row) {
  const n = Number(row.checklist_outstanding || 0);
  return n ? ` ${plural(n, 'checklist item')} outstanding${row.reminders_escalated ? '; customer reminders exhausted' : ''}.` : '';
}

function toPriority(type, row) {
  const ageDays = row.age_days || 0;
  const base = {
    id: `${type}:${row.id}`,
    type,
    priority_level: PRIORITY_LEVEL_BY_TYPE[type],
    age_days: ageDays,
    score: priorityScore(type, ageDays, row.id),
  };

  if (type === 'deal') {
    return {
      ...base,
      title: `Follow up with ${row.customer_name}`,
      reason: `Pending for ${plural(ageDays, 'day')} with no status update.${checklistNote(row)}`,
      next_step: `Contact ${row.customer_name} to confirm the deal is still moving forward.`,
      // Name-free version of reason/next_step, used ONLY as the input sent
      // to the AI-guidance service (services/priorityGuidance.js). The
      // customer's name is real, useful, and shown on-page — but it's
      // unnecessary personal data for an AI request whose whole job is to
      // rephrase a generic situation, so it's deliberately never included in
      // what gets sent.
      // Only the numeric outstanding-checklist count is shared; never item
      // labels, notes, or reasons.
      ai_context: `A deal has been pending for ${plural(ageDays, 'day')} with no status update.${checklistNote(row)}`,
      checklist_outstanding: Number(row.checklist_outstanding || 0),
      status: 'pending',
      vehicle: row.vehicle,
      link: '/deals',
      actions: { endpoint: `/api/dashboard/deal-alert/${row.id}/action`, options: ['still_pending', 'vehicle_changed', 'dead', 'closed'] },
    };
  }

  if (type === 'title') {
    const days = row.days_to_tag_expiry;
    const reason = row.level === 'overdue'
      ? `Temporary tag expired ${plural(-days, 'day')} ago and the title/registration case is not complete.`
      : days !== null && days <= titleCases.DUE_SOON_DAYS
        ? `Temporary tag expires in ${plural(days, 'day')}; title/registration case is ${row.status.replace(/_/g, ' ')}.`
        : `Title/registration case is ${row.status === 'on_hold' ? 'on hold' : 'blocked'}.`;
    return {
      ...base,
      // Overdue uses days past the dealer-entered tag date for ranking.
      age_days: Math.max(0, -(days ?? 0)),
      score: priorityScore(type, Math.max(0, -(days ?? 0)) + (row.level === 'overdue' ? 1000 : 0), row.id),
      priority_level: row.level === 'overdue' ? 'high' : 'medium',
      title: `Title & registration: ${row.vehicle}`,
      reason,
      next_step: row.blocking_issue ? 'Resolve the blocking issue and update the case.' : 'Update the title, registration, and plate status, or the temporary tag.',
      // Name-free and note-free: only dates and statuses reach the AI context.
      ai_context: reason,
      status: row.status,
      vehicle: row.vehicle,
      assignee_name: row.assignee_name || null,
      link: `/deals?deal=${Number(row.deal_id)}`,
      actions: { endpoint: null, options: [] },
    };
  }

  if (type === 'unit') {
    // Name-free reason (it is also the AI context); the assignee is a
    // separate display field and is never sent to the AI-guidance service.
    const reason = row.review_interval_days
      ? `Not reviewed in ${plural(row.days_since_review, 'day')} (reviewed every ${plural(row.review_interval_days, 'day')})${row.escalated ? '; escalated for manager attention' : ''}.`
      : `In inventory for ${plural(ageDays, 'day')}, crossing the ${row.milestone}-day review milestone.`;
    return {
      ...base,
      title: `${row.escalated ? 'Escalated: ' : ''}Check in on ${row.vehicle}`,
      reason,
      next_step: row.escalated
        ? `A manager should confirm ${row.vehicle}'s current status, reassign it, or record its disposition.`
        : `Confirm ${row.vehicle}'s current stage, or move it forward.`,
      // Vehicle year/make/model (row.vehicle) is not personal data and is
      // safe to send as-is — no VIN is ever included here.
      ai_context: reason,
      status: row.stage,
      vehicle: row.vehicle,
      escalated: Boolean(row.escalated),
      assignee_name: row.assignee_name || null,
      link: `/inventory/${row.id}`,
      actions: { endpoint: `/api/dashboard/unit-alert/${row.id}/action`, options: ['update_stage'] },
    };
  }

  // user
  return {
    ...base,
    title: `Review access for ${row.name}`,
    reason: `No login for ${plural(ageDays, 'day')}.`,
    next_step: `Confirm ${row.name} still needs access, or revoke it.`,
    // Name-free: never send a staff member's name (or email — never
    // collected here at all) to the AI-guidance service.
    ai_context: `A staff account has had no login for ${plural(ageDays, 'day')}.`,
    status: row.role,
    link: '/settings/users',
    actions: { endpoint: `/api/dashboard/user-alert/${row.id}/action`, options: ['keep_active', 'revoke'] },
  };
}

// Exported and unit-tested directly (see test/dashboard-priorities.test.js)
// so ranking correctness never depends on spinning up the HTTP layer.
function rankPriorities(dealAlerts, unitAlerts, staleUserAlerts, titleAlerts = []) {
  const priorities = [
    ...dealAlerts.map(row => toPriority('deal', row)),
    ...titleAlerts.map(row => toPriority('title', row)),
    ...(unitAlerts || []).map(row => toPriority('unit', row)),
    ...(staleUserAlerts || []).map(row => toPriority('user', row)),
  ];
  return priorities.sort((a, b) => b.score - a.score);
}

function currentPriorities(req) {
  const dealershipId = req.user.dealership_id;
  return rankPriorities(getDealAlerts(dealershipId), getUnitAlerts(dealershipId), getStaleUserAlerts(req), titleCases.listCases(db, { dealershipId, filter: 'due' }));
}

router.get('/priorities', ...requirePermission('reports_view'), (req, res) => {
  res.json({ priorities: currentPriorities(req) });
});

// Short-lived, per-process, per-dealership+selection cache so repeated
// clicks/refreshes within a few seconds don't re-spend tokens on an
// unchanged list. Deliberately simple (a Map with a TTL) rather than a
// persistent cache layer — this is a first-release cost control, not
// durable state, and is fine to lose on restart.
const AI_GUIDANCE_CACHE_TTL_MS = 60_000;
const aiGuidanceCache = new Map();

// Pulled out of the route handler as a standalone, dependency-injectable
// function (mirrors the `{ download }` override pattern used by
// archiveDocusealSubmission in routes/paperwork.js) so tests can exercise
// every branch — cache hit, missing key, malformed response, id tampering —
// without spinning up the HTTP layer or ever contacting OpenAI. `generate`
// and `cache` default to the real implementation/module-level cache; tests
// override both.
async function buildAiGuidanceResponse({ dealershipId, priorities, requestedIds, generate = generateBatchGuidance, cache = aiGuidanceCache }) {
  // The list of priorities is always freshly recomputed from this request's
  // own dealership_id by the caller — client-supplied `ids` is only ever a
  // SELECTION filter over that fresh, server-derived list, never a source of
  // data. An id that doesn't match a real, current priority for this
  // dealership is simply not present in `selected` and is never sent to the
  // AI or returned.
  const selected = requestedIds
    ? priorities.filter(p => requestedIds.includes(p.id))
    : priorities;

  if (!selected.length) return { guidance: {}, ai_unavailable: false };

  const cacheKey = `${dealershipId}:${selected.map(p => p.id).sort().join(',')}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { guidance: cached.guidance, ai_unavailable: false, cached: true };
  }

  try {
    const guidance = await generate(selected);
    cache.set(cacheKey, { guidance, expiresAt: Date.now() + AI_GUIDANCE_CACHE_TTL_MS });
    return { guidance, ai_unavailable: false };
  } catch (err) {
    // Any failure at all — no API key, a provider error, a timeout, an
    // unparseable response — falls back to the deterministic text the
    // client already has. This endpoint only ever enhances; it is never a
    // hard dependency for the page to work.
    return { guidance: {}, ai_unavailable: true, reason: err.code === 'missing_openai_key' ? 'not_configured' : 'unavailable' };
  }
}

router.post('/priorities/ai-guidance', ...requirePermission('reports_view'), async (req, res) => {
  const priorities = currentPriorities(req);
  const requestedIds = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => typeof id === 'string') : null;
  const result = await buildAiGuidanceResponse({
    dealershipId: req.user.dealership_id, priorities, requestedIds,
    generate: usage.metered(db, { dealershipId: req.user.dealership_id, userId: req.user.id, feature: 'priority_guidance' }, generateBatchGuidance),
  });
  res.json(result);
});

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
      AND ${dealChecklist.OUTSTANDING_COUNT_SQL} > 0
  `).get(dealershipId).count || 0;

  const titleDue = titleCases.listCases(db, { dealershipId, filter: 'due' });

  // Pending deals whose customer reminders ran out with items still outstanding.
  const remindersEscalated = db.prepare(`
    SELECT COUNT(*) AS count FROM deals d
    JOIN deal_reminder_state rs ON rs.dealership_id = d.dealership_id AND rs.deal_id = d.id AND rs.escalated_at IS NOT NULL
    WHERE d.dealership_id = ? AND d.status = 'pending' AND ${dealChecklist.OUTSTANDING_COUNT_SQL} > 0
  `).get(dealershipId).count || 0;

  res.json({
    metrics: {
      deals_need_follow_up: dealAlerts.length,
      units_missing_photos: unitsMissingPhotos,
      missing_acquisition_cost: missingAcquisitionCost,
      paperwork_incomplete: paperworkIncomplete,
      stale_user_logins: staleUserAlerts.length,
      reminders_escalated: remindersEscalated,
      title_cases_due: titleDue.length,
      title_cases_overdue: titleDue.filter(c => c.level === 'overdue').length,
      inventory_reviews_due: unitAlerts.length,
      inventory_reviews_escalated: unitAlerts.filter(alert => alert.escalated).length,
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
  let result = null;
  try {
    db.transaction(() => {
      if (action === 'closed') {
        result = closeDeal(db, { dealershipId: req.user.dealership_id, dealId: deal.id, actorId: req.user.id, markStatusChecked: true });
      } else {
        const status = action === 'still_pending' ? deal.status : action;
        db.prepare('UPDATE deals SET status = ?, last_status_check_at = ? WHERE id = ? AND dealership_id = ?')
          .run(status, now, deal.id, req.user.dealership_id);
      }
      db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
        VALUES (?, 'deal', ?, ?, ?, ?)`)
        .run(req.user.dealership_id, deal.id, 'Deal alert resolved', action, req.user.id);
    })();
  } catch (err) {
    console.error('Deal alert action failed', err);
    return res.status(500).json({ error: 'Could not update the deal. Nothing was changed.' });
  }

  const warning = result ? checklistWarning(result.outstanding_checklist_items) : null;
  res.json({ ok: true, ...(warning ? { warning, outstanding_checklist_items: result.outstanding_checklist_items } : {}) });
});

router.post('/unit-alert/:id/action', requireAuth, (req, res) => {
  if (!hasPermission(req.user, 'inventory_edit')) {
    return res.status(403).json({ error: 'You do not have access to update inventory alerts' });
  }

  const { stage } = req.body || {};
  if (stage && !UNIT_STAGES.has(stage)) return res.status(400).json({ error: 'Invalid inventory stage' });

  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  // Sold and archived come only from a structured disposition.
  if (inventoryTruth.TERMINAL_STAGES.has(stage)) {
    return res.status(409).json({ error: 'Record a disposition to mark a vehicle sold or remove it from inventory.', code: 'disposition_required' });
  }
  if (inventoryTruth.TERMINAL_STAGES.has(unit.stage)) {
    return res.status(409).json({ error: 'This vehicle is already sold or archived. Correct its disposition from the vehicle page.', code: 'disposition_required' });
  }

  const now = new Date().toISOString();
  const targetStage = stage || unit.stage;
  const wasEscalated = inventoryTruth.reviewState(unit, inventoryTruth.reviewInterval(db, req.user.dealership_id)).escalated;

  db.prepare(`
    UPDATE units SET stage = ?, last_age_check_at = ?
    WHERE id = ? AND dealership_id = ?
  `).run(targetStage, now, req.params.id, req.user.dealership_id);

  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
    VALUES (?, 'unit', ?, ?, ?, ?)`)
    .run(req.user.dealership_id, req.params.id, 'Inventory age alert resolved', targetStage, req.user.id);
  if (wasEscalated) {
    db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
      VALUES (?, 'unit', ?, 'Escalation resolved', ?, ?)`)
      .run(req.user.dealership_id, req.params.id, `Resolved from the inventory alert (${targetStage})`, req.user.id);
  }

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
      log.run(req.user.dealership_id, alert.id, `Reviewed after ${alert.days_since_review} days${alert.escalated ? ' (escalation resolved)' : ''}`, req.user.id);
    });
  });
  dismiss(unitAlerts);

  res.json({ ok: true, dismissed: unitAlerts.length });
});

// Router is a function; attaching properties keeps it directly usable as
// Express middleware (`app.use('/api/dashboard', require('./routes/dashboard'))`)
// while still exposing pure functions for direct, server-free unit testing.
router.rankPriorities = rankPriorities;
router.priorityScore = priorityScore;
router.buildAiGuidanceResponse = buildAiGuidanceResponse;
router.toPriority = toPriority;
router.getUnitAlerts = getUnitAlerts;

module.exports = router;
