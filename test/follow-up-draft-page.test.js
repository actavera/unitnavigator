'use strict';
// Page-level checks for the Draft Follow-up UI, running the real deals page
// script against a stub DOM: nothing is requested until an explicit click,
// drafts are placed as plain text (never HTML), email gets a mailto the user
// must send themselves, and nothing can send.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'deals.html'), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(c => c.trim() && !/^\(function\(\)\{var t=/.test(c.trim())).join('\n');

const DEAL = { id: 7, status: 'pending', customer_name: 'Casey Customer', vehicle: '2021 Toyota Camry', deal_type_label: 'Cash', email: 'casey@example.com', phone: '801-555-0100', missing_docs: 0, last_activity: 'Deal started', next_follow_up_at: null };
const HOSTILE = '<img src=x onerror=alert(1)>';

function harness({ can = () => true, draftResponse, confirmAnswer = true } = {}) {
  const elements = {};
  const make = () => ({
    innerHTML: '', textContent: '', value: '', style: {}, title: '', disabled: false, dataset: {},
    classList: { add() {}, remove() {}, toggle(name, on) { this.last = [name, on]; }, contains() { return false; } },
    addEventListener() {}, scrollIntoView() {}, querySelectorAll: () => [],
  });
  const calls = [];
  const toasts = [];
  const nav = { href: '' };
  const context = vm.createContext({
    document: { getElementById: id => (elements[id] ||= make()), querySelectorAll: () => [], createElement: () => make(), body: make() },
    toast: (message, type) => toasts.push([message, type]),
    console, Date, Number, String, JSON, Math, Set, setTimeout, clearTimeout,
    window: { location: nav }, location: nav, alert() {}, confirm: () => { context.confirmAsked = (context.confirmAsked || 0) + 1; return confirmAnswer; },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async text => { context.copied = text; } } },
    UN: {
      requireAuth: () => true, renderNav() {}, can, getUser: () => ({ email: 'dealer@example.com' }),
      api: async (method, url, body) => {
        calls.push([method, url, body]);
        if (url.startsWith('/api/deals/7/follow-up-draft')) return draftResponse ? draftResponse(body) : { draft: { channel: body.channel, source: 'template', subject: body.channel === 'email' ? 'Subject' : undefined, body: 'Hi Casey,\nbody' } };
        if (url.startsWith('/api/deals')) return { deals: [DEAL] };
        return { customers: [] };
      },
    },
  });
  vm.runInContext(script, context);
  return { context, elements, calls, toasts, nav };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const draftCalls = calls => calls.filter(([, url]) => url.includes('follow-up-draft'));

test('the page script parses and nothing is requested until an explicit click', async () => {
  const { calls } = harness();
  await tick();
  await tick();
  assert.equal(draftCalls(calls).length, 0, 'loading the page requests no drafts');
});

test('the Draft Follow-up button appears only for pending deals and only with deals_manage', async () => {
  const ctx = harness();
  await tick();
  const card = fn => vm.runInContext(`dealCard(${JSON.stringify(fn)})`, ctx.context);
  assert.match(card(DEAL), /Draft Follow-up/);
  assert.ok(!/Draft Follow-up/.test(card({ ...DEAL, status: 'closed' })));
  assert.ok(!/Draft Follow-up/.test(card({ ...DEAL, status: 'dead' })));
  const restricted = harness({ can: p => p !== 'deals_manage' });
  await tick();
  assert.ok(!/Draft Follow-up/.test(vm.runInContext(`dealCard(${JSON.stringify(DEAL)})`, restricted.context)));
});

test('opening the modal requests one template draft; switching channel requests another; AI is only requested by its own button', async () => {
  const h = harness();
  await tick();
  vm.runInContext('deals = [' + JSON.stringify(DEAL) + ']; openDraft(7)', h.context);
  await tick();
  assert.equal(JSON.stringify(draftCalls(h.calls).map(([, , body]) => body)), JSON.stringify([{ channel: 'email', ai: false }]));
  assert.equal(h.elements.draftBody.value, 'Hi Casey,\nbody');
  assert.equal(h.elements.draftSubject.value, 'Subject');

  vm.runInContext("setDraftChannel('text')", h.context);
  await tick();
  assert.equal(JSON.stringify(draftCalls(h.calls).at(-1)[2]), JSON.stringify({ channel: 'text', ai: false }));
  assert.equal(h.elements.draftSubjectRow.style.display, 'none', 'no subject for a text');
  assert.equal(h.elements.draftMailBtn.style.display, 'none', 'no email link for a text');
  assert.ok(draftCalls(h.calls).every(([, , body]) => body.ai === false), 'no AI request so far');

  vm.runInContext('rewriteDraftWithAi()', h.context);
  await tick();
  assert.equal(JSON.stringify(draftCalls(h.calls).at(-1)[2]), JSON.stringify({ channel: 'text', ai: true }));
  assert.equal(draftCalls(h.calls).length, 3);
});

test('an unavailable-AI response keeps the standard draft and shows the message', async () => {
  const h = harness({
    draftResponse: body => (body.ai
      ? { draft: { channel: 'email', source: 'template', subject: 'S', body: 'standard body' }, ai_unavailable: true, reason: 'not_configured', message: 'AI rewriting is not configured yet. Showing the standard draft.' }
      : { draft: { channel: 'email', source: 'template', subject: 'S', body: 'standard body' } }),
  });
  await tick();
  vm.runInContext('deals = [' + JSON.stringify(DEAL) + ']; openDraft(7)', h.context);
  await tick();
  vm.runInContext('rewriteDraftWithAi()', h.context);
  await tick();
  assert.equal(h.elements.draftBody.value, 'standard body');
  assert.match(h.elements.draftStatus.textContent, /not configured/);
});

test('draft text is set as plain text, never as HTML', async () => {
  const h = harness({ draftResponse: body => ({ draft: { channel: body.channel, source: 'ai', subject: HOSTILE, body: HOSTILE } }) });
  await tick();
  vm.runInContext('deals = [' + JSON.stringify(DEAL) + ']; openDraft(7)', h.context);
  await tick();
  assert.equal(h.elements.draftBody.value, HOSTILE, 'held in a textarea value, not parsed');
  assert.equal(h.elements.draftBody.innerHTML, '', 'nothing is injected as markup');
  assert.equal(h.elements.draftSubject.innerHTML, '');
  assert.ok(!/innerHTML\s*=[^;]*draft/.test(script.slice(script.indexOf('Follow-up drafts'))), 'no draft text is assigned to innerHTML anywhere in the draft code');
});

test('Copy copies the edited text; the email link is a mailto the user must send; a text has no link', async () => {
  const h = harness();
  await tick();
  vm.runInContext('deals = [' + JSON.stringify(DEAL) + ']; openDraft(7)', h.context);
  await tick();
  h.elements.draftSubject.value = 'My edited subject';
  h.elements.draftBody.value = 'My edited body & more';
  await vm.runInContext('copyDraft()', h.context);
  assert.equal(h.context.copied, 'Subject: My edited subject\n\nMy edited body & more');

  vm.runInContext('openDraftInMail()', h.context);
  assert.equal(h.nav.href, `mailto:${encodeURIComponent('casey@example.com')}?subject=${encodeURIComponent('My edited subject')}&body=${encodeURIComponent('My edited body & more')}`);
  assert.ok(h.nav.href.startsWith('mailto:casey%40example.com'), 'addressed to the customer, in the user\'s own mail app');

  const noEmail = harness();
  await tick();
  vm.runInContext('deals = [' + JSON.stringify({ ...DEAL, email: '' }) + ']; openDraft(7)', noEmail.context);
  await tick();
  assert.equal(noEmail.elements.draftMailBtn.disabled, true);
  vm.runInContext('openDraftInMail()', noEmail.context);
  assert.equal(noEmail.nav.href, '', 'no mailto is opened without an address');
});

test('nothing in the draft UI can send, save, or change a deal', () => {
  const draftCode = script.slice(script.indexOf('Follow-up drafts'));
  const apiCalls = [...draftCode.matchAll(/UN\.api\('([A-Z]+)', `([^`]+)`/g)].map(m => `${m[1]} ${m[2]}`);
  assert.deepEqual(apiCalls, ['POST /api/deals/${Number(dealId)}/follow-up-draft'], 'the only request the draft UI makes is the read-only draft route');
  assert.ok(!/\/send|sms:|twilio|status'|PATCH|PUT|DELETE/.test(draftCode), 'no send, sms, or write call');
  assert.match(html, /never sends it and does not save it/, 'the modal says so');
});

test('edits are not silently discarded: switching channel or rewriting asks first, and declining keeps the text and makes no request', async () => {
  const h = harness({ confirmAnswer: false });
  await tick();
  vm.runInContext('deals = [' + JSON.stringify(DEAL) + ']; openDraft(7)', h.context);
  await tick();
  const requests = () => draftCalls(h.calls).length;
  assert.equal(requests(), 1);

  vm.runInContext("setDraftChannel('text')", h.context);
  await tick();
  vm.runInContext('rewriteDraftWithAi()', h.context);
  await tick();
  assert.equal(h.context.confirmAsked || 0, 0, 'untouched text needs no confirmation');
  assert.equal(requests(), 3, 'an unedited draft is replaced freely');

  h.elements.draftBody.value = 'my careful edits';
  vm.runInContext("setDraftChannel('email')", h.context);
  await tick();
  vm.runInContext('rewriteDraftWithAi()', h.context);
  await tick();
  assert.equal(h.context.confirmAsked, 2, 'both actions asked before replacing edits');
  assert.equal(requests(), 3, 'declining makes no request');
  assert.equal(h.elements.draftBody.value, 'my careful edits', 'and keeps the text');

  const yes = harness({ confirmAnswer: true });
  await tick();
  vm.runInContext('deals = [' + JSON.stringify(DEAL) + ']; openDraft(7)', yes.context);
  await tick();
  yes.elements.draftBody.value = 'edited';
  vm.runInContext('rewriteDraftWithAi()', yes.context);
  await tick();
  assert.equal(draftCalls(yes.calls).at(-1)[2].ai, true, 'confirming proceeds');
});
