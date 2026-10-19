'use strict';
// Title, plate, and registration cases. deals_view reads; deals_manage
// creates, assigns, and updates. Everything is scoped to the caller's
// dealership.
const router = require('express').Router();
const db = require('../database');
const { requirePermission } = require('../middleware/auth');
const titleCases = require('../services/titleCases');
const inventoryTruth = require('../services/inventoryTruth');

function send(res, fn, status = 200) {
  try {
    res.status(status).json(fn());
  } catch (err) {
    if (err instanceof titleCases.TitleCaseError) return res.status(err.statusCode).json({ error: err.message });
    console.error('Title case request failed', err);
    res.status(500).json({ error: 'Could not update the title case' });
  }
}

router.get('/', ...requirePermission('deals_view'), (req, res) => {
  const filter = ['open', 'due', 'overdue', 'completed', 'all'].includes(req.query.filter) ? req.query.filter : 'open';
  send(res, () => ({ cases: titleCases.listCases(db, { dealershipId: req.user.dealership_id, filter, assignee: req.query.assignee }) }));
});

router.get('/deal/:dealId', ...requirePermission('deals_view'), (req, res) => {
  send(res, () => titleCases.caseForDeal(db, { dealershipId: req.user.dealership_id, dealId: req.params.dealId }));
});

// Active employees of this dealership who can be made responsible.
router.get('/assignees', ...requirePermission('deals_manage'), (req, res) => {
  send(res, () => ({ users: inventoryTruth.assignableUsers(db, req.user.dealership_id) }));
});

// Manual creation, mainly for sales recorded before automatic cases existed.
router.post('/', ...requirePermission('deals_manage'), (req, res) => {
  send(res, () => {
    titleCases.createForDeal(db, { dealershipId: req.user.dealership_id, dealId: req.body?.deal_id, actorId: req.user.id });
    return titleCases.caseForDeal(db, { dealershipId: req.user.dealership_id, dealId: req.body.deal_id });
  }, 201);
});

router.patch('/:id', ...requirePermission('deals_manage'), (req, res) => {
  send(res, () => {
    const result = titleCases.updateCase(db, { dealershipId: req.user.dealership_id, caseId: req.params.id, actorId: req.user.id, body: req.body || {} });
    const dealId = db.prepare('SELECT deal_id FROM title_cases WHERE id = ? AND dealership_id = ?').get(result.id, req.user.dealership_id).deal_id;
    return { changed: result.changed, ...titleCases.caseForDeal(db, { dealershipId: req.user.dealership_id, dealId }) };
  });
});

module.exports = router;
