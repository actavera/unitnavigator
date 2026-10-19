'use strict';
// The single implementation of closing a deal. Used by the deal-alert action
// and PATCH /api/deals/:id/status so both behave identically: the deal is
// closed and, when it is linked to an active vehicle, that vehicle gets a
// retail-sold disposition with no amount (sold_price stays null), all in one
// transaction, which also opens the deal's title and registration case.
// Outstanding checklist items never block closing; the count is
// returned so the caller can warn.
const inventoryTruth = require('./inventoryTruth');
const dealChecklist = require('./dealChecklist');
const titleCases = require('./titleCases');

function closeDeal(db, { dealershipId, dealId, actorId, now = Date.now(), markStatusChecked = false }) {
  const stamp = new Date(now).toISOString();
  return db.transaction(() => {
    const deal = db.prepare('SELECT id, unit_id FROM deals WHERE id = ? AND dealership_id = ?').get(dealId, dealershipId);
    if (!deal) return null;
    let disposition = null;
    if (deal.unit_id) {
      const unit = db.prepare('SELECT id, stage FROM units WHERE id = ? AND dealership_id = ?').get(deal.unit_id, dealershipId);
      if (unit && !inventoryTruth.TERMINAL_STAGES.has(unit.stage)) {
        disposition = inventoryTruth.recordDisposition(db, {
          dealershipId, unitId: unit.id, actorId, now,
          body: { outcome: 'retail_sold', note: 'Recorded when the deal was closed' }, canPrice: true,
        });
      }
    }
    db.prepare(`UPDATE deals SET status = 'closed', closed_at = ?${markStatusChecked ? ', last_status_check_at = ?' : ''}
      WHERE id = ? AND dealership_id = ?`).run(stamp, ...(markStatusChecked ? [stamp] : []), deal.id, dealershipId);
    // A retail sale opens its title and registration case in the same transaction.
    const titleCase = disposition ? titleCases.createForDeal(db, { dealershipId, dealId: deal.id, actorId, now }) : null;
    return {
      deal_id: deal.id,
      disposition_id: disposition ? disposition.id : null,
      title_case_id: titleCase ? titleCase.id : null,
      outstanding_checklist_items: dealChecklist.outstandingCount(db, dealershipId, deal.id),
    };
  })();
}

function checklistWarning(count) {
  return count ? `${count} checklist item${count === 1 ? ' is' : 's are'} still outstanding on this deal.` : null;
}

module.exports = { closeDeal, checklistWarning };
