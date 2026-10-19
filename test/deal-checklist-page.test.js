'use strict';
// Page-level checks for the deal checklist modal in public/deals.html, running
// the real page script against a stub DOM: labels and notes are escaped,
// actions follow permissions, and the modal only calls checklist endpoints.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'deals.html'), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(c => c.trim() && !/^\(function\(\)\{var t=/.test(c.trim())).join('\n');
const HOSTILE = '<img src=x onerror=alert(1)>';
const DEAL = { id: 7, status: 'pending', customer_name: 'Casey', vehicle: '2021 Camry', deal_type_label: 'We Finance', email: '', phone: '', missing_docs: 1, last_activity: 'x' };
const CHECKLIST = {
  deal_id: 7,
  summary: { total: 2, outstanding: 1 },
  items: [
    { id: 1, item_key: 'custom', label: HOSTILE, status: 'required', effective_status: 'required', note: HOSTILE, note_hidden: false, history: [] },
    { id: 2, item_key: 'pay_stubs', label: 'Pay stubs', status: 'received', effective_status: 'received', note: null, note_hidden: true, history: [] },
  ],
};

function harness(can) {
  const elements = {};
  const make = () => ({ innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, querySelectorAll: () => [] });
  const calls = [];
  const context = vm.createContext({
    document: { getElementById: id => (elements[id] ||= make()), querySelectorAll: () => [], createElement: () => make(), body: make() },
    toast() {}, console, Date, Number, String, JSON, Math, Set, setTimeout, clearTimeout,
    window: { location: {} }, location: {}, alert() {}, confirm: () => true, prompt: () => 'reason',
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {},
    UN: {
      requireAuth: () => true, renderNav() {}, can, getUser: () => ({}),
      api: async (method, url, body) => { calls.push([method, url, body]); if (url.includes('/checklist')) return CHECKLIST; if (url.startsWith('/api/deals')) return { deals: [DEAL] }; return { customers: [] }; },
    },
  });
  vm.runInContext(script, context);
  return { context, elements, calls };
}
const tick = () => new Promise(r => setImmediate(r));

test('labels and notes are escaped; hidden notes show a placeholder only', async () => {
  const h = harness(() => true);
  await tick();
  vm.runInContext(`deals = [${JSON.stringify(DEAL)}]; openDeal(7)`, h.context);
  await tick();
  const out = h.elements.checklistItems.innerHTML;
  assert.ok(!out.includes('<img'), 'no raw HTML from labels or notes');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.match(out, /Note hidden/);
  assert.equal(h.elements.checklistSummary.textContent, '1 of 2 outstanding');
  assert.ok(h.calls.some(([m, u]) => m === 'GET' && u === '/api/deals/7/checklist'));
});

test('actions follow permissions', async () => {
  const render = async can => {
    const h = harness(can);
    await tick();
    vm.runInContext(`deals = [${JSON.stringify(DEAL)}]; openDeal(7)`, h.context);
    await tick();
    return h;
  };
  const manager = await render(p => p === 'deals_manage');
  assert.match(manager.elements.checklistItems.innerHTML, /Mark received/);
  assert.ok(!/Approve|Waive|Reopen/.test(manager.elements.checklistItems.innerHTML));
  const paper = await render(p => p === 'paperwork_manage');
  assert.match(paper.elements.checklistItems.innerHTML, /Approve/);
  assert.match(paper.elements.checklistItems.innerHTML, /Waive/);
  assert.equal(paper.elements.checklistAddRow.style.display, 'none', 'adding needs deals_manage');
  const viewer = await render(p => p === 'deals_view');
  assert.ok(!/<button/.test(viewer.elements.checklistItems.innerHTML), 'view-only users see no actions');
});

test('a status change sends one PATCH with a prompted reason when required', async () => {
  const h = harness(() => true);
  await tick();
  vm.runInContext(`deals = [${JSON.stringify(DEAL)}]; openDeal(7)`, h.context);
  await tick();
  vm.runInContext("setChecklistStatus(2, 'rejected')", h.context);
  await tick();
  const patches = h.calls.filter(([m]) => m === 'PATCH');
  assert.equal(JSON.stringify(patches), JSON.stringify([['PATCH', '/api/deals/7/checklist/2', { status: 'rejected', reason: 'reason' }]]));
});
