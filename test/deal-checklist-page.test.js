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

test('reminder panel escapes provider errors, shows blockers, and opting in requires confirmation', async () => {
  const h = harness(() => true);
  await tick();
  const data = {
    channels: [
      { channel: 'email', dealership_enabled: false, provider_configured: false, has_address: true, consent: 'none', consent_source: null },
      { channel: 'sms', dealership_enabled: true, provider_configured: true, has_address: true, consent: 'opted_out', consent_source: 'sms_stop' },
    ],
    state: { attempts: 3, escalated_at: '2026-10-19T00:00:00Z' },
    messages: [{ channel: 'sms', status: 'failed', to_address: '•••0177', error: HOSTILE, created_at: '2026-10-19T00:00:00Z' }],
  };
  vm.runInContext(`checklistDealId = 7; renderReminders(${JSON.stringify(data)})`, h.context);
  const out = h.elements.reminderPanel.innerHTML;
  assert.ok(!out.includes('<img'));
  assert.match(out, /turned off in dealership settings, sending not set up yet/);
  assert.match(out, /replied STOP/);
  assert.match(out, /Reminders exhausted/);
  vm.runInContext("setReminderConsent('sms', 'opted_in')", h.context);
  await tick();
  const post = h.calls.find(([m, u]) => m === 'POST' && u.endsWith('/communications/consent'));
  assert.equal(JSON.stringify(post[2]), JSON.stringify({ channel: 'sms', status: 'opted_in', attested: true }));
});

test('title panel escapes values, offers creation only on closed deals, and disables fields without deals_manage', async () => {
  const h = harness(p => p !== 'deals_manage');
  await tick();
  vm.runInContext("checklistDealId = 7; renderTitleCase({ deal_status: 'pending', case: null })", h.context);
  assert.match(h.elements.titlePanel.innerHTML, /opens automatically/);
  const c = { id: 3, status: 'on_hold', title_status: 'submitted', registration_status: 'not_started', plate_status: 'not_started', level: 'overdue',
    blocking_issue: HOSTILE, note: HOSTILE, temp_tag_number: 'T1', assignee_name: HOSTILE, assigned_user_id: 4, history: [{ field: 'note', from_value: HOSTILE, to_value: null, created_at: '2026-10-19T00:00:00Z' }] };
  vm.runInContext(`renderTitleCase(${JSON.stringify({ deal_status: 'closed', case: c })})`, h.context);
  const out = h.elements.titlePanel.innerHTML;
  assert.ok(!out.includes('<img'));
  assert.match(out, /Temp tag expired/);
  assert.match(out, /disabled/);
  assert.ok(!/Save title case/.test(out), 'no save without deals_manage');
});
