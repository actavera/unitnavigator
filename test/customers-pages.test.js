'use strict';
// People with restricted client access must get clean pages, not errors,
// "undefined", or misleading zeros. The real page scripts run against a stub
// DOM and canned API responses shaped like the restricted server output.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const scriptOf = html => [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(c => c.trim() && !/^\(function\(\)\{var t=/.test(c.trim())).join('\n');

function stubDom() {
  const elements = {};
  const make = () => ({
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, scrollIntoView() {}, querySelectorAll: () => [],
  });
  return { elements, document: { getElementById: id => (elements[id] ||= make()), querySelectorAll: () => [] } };
}

const RESTRICTED_LIST = { customers: [{ id: 1, first_name: 'Alpha', last_name: 'Sentinel', name: 'Alpha Sentinel', phone: '801-555-0100', email: 'a@example.com', created_at: '2026-10-01 10:00:00', deal_count: 1, last_deal_at: '2026-10-02 10:00:00', last_deal_status: 'pending', last_deal_type: 'cash', last_vehicle: '2020 Honda Accord', last_vin: 'VINSENTINEL0000001' }] };
const RESTRICTED_DETAIL = { customer: RESTRICTED_LIST.customers[0], deals: [{ id: 5, status: 'pending', deal_type: 'cash', created_at: '2026-10-02 10:00:00', vehicle: '2020 Honda Accord', vin: 'VINSENTINEL0000001' }] };

test('Clients page, restricted access: no "undefined", no fake zero credit count, and the restrictions are stated', async () => {
  const { elements, document } = stubDom();
  const context = vm.createContext({
    document, toast() {}, console, Date, Number, String, JSON, RegExp, URLSearchParams, clearTimeout, setTimeout,
    confirm: () => false,
    UN: {
      requireAuth: () => true, renderNav() {}, can: () => false, fmt: { money: v => `$${v}` },
      api: async (_method, url) => (/\/api\/customers\/\d+/.test(url) ? RESTRICTED_DETAIL : RESTRICTED_LIST),
    },
  });
  vm.runInContext(scriptOf(read('customers.html')), context);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const results = elements.clientResults.innerHTML;
  const detail = elements.clientDetail.innerHTML;
  const stats = elements.clientStats.innerHTML;
  assert.ok(results.includes('Alpha Sentinel') && results.includes('2020 Honda Accord'), 'basic data still renders');
  assert.ok(results.includes('Restricted'), 'the credit column says it is restricted');
  assert.ok(!/undefined|NaN/.test(results + detail + stats), 'no "undefined" or NaN anywhere');
  assert.ok(!/0 credit pulls/.test(results), 'a restricted user is not told there are zero credit pulls');
  assert.equal(elements.creditFilter.disabled, true, 'the credit filter is disabled for a user without credit access');
  assert.match(stats, /With Credit Pulls<\/span><strong>-<\/strong>/, 'the credit stat is a dash, not 0');
  assert.match(detail, /Address, ID, employer, and income are restricted/);
  assert.match(detail, /Credit history is restricted/);
  assert.ok(!/No credit pulls yet/.test(detail), 'restricted is not presented as "none"');
});

test('Clients page, full access: identity and credit details still render', async () => {
  const { elements, document } = stubDom();
  const full = { ...RESTRICTED_LIST.customers[0], address: '1 Main St', id_number: 'ID-1', employer: 'Acme', monthly_income: 5000, credit_count: 1, last_credit_status: 'approved', last_credit_at: '2026-10-01 10:00:00', last_score: 700 };
  const context = vm.createContext({
    document, toast() {}, console, Date, Number, String, JSON, RegExp, URLSearchParams, clearTimeout, setTimeout,
    UN: {
      requireAuth: () => true, renderNav() {}, can: () => true, fmt: { money: v => `$${v}` },
      api: async (_m, url) => (/\/api\/customers\/\d+/.test(url)
        ? { customer: full, deals: RESTRICTED_DETAIL.deals, credit_pulls: [{ provider_status: 'approved', score_placeholder: 700, pulled_at: '2026-10-01 10:00:00', vehicle_interest: 'Truck', result_summary: 'Prime' }] }
        : { customers: [full] }),
    },
  });
  vm.runInContext(scriptOf(read('customers.html')), context);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const detail = elements.clientDetail.innerHTML;
  assert.ok(!elements.creditFilter.disabled, 'the credit filter stays enabled with credit access');
  assert.ok(detail.includes('ID-1') && detail.includes('Acme') && detail.includes('1 Main St') && detail.includes('Score 700'));
  assert.ok(!/restricted/i.test(detail));
  assert.ok(elements.clientResults.innerHTML.includes('1 credit pull'));
});

test('Deals page, restricted access: the client summary does not claim "Credit pulls: 0"', async () => {
  const html = read('deals.html');
  const source = html.match(/async function openClient\(id\) \{[\s\S]*?\n\}\n/)[0];
  let shown = '';
  const context = vm.createContext({
    toast() {}, String, alert: text => { shown = text; }, statusLabel: s => s,
    UN: { api: async () => RESTRICTED_DETAIL },
  });
  vm.runInContext(`${source}\nthis.openClient = openClient;`, context);
  await context.openClient(1);
  assert.match(shown, /Alpha Sentinel/);
  assert.ok(!/Credit pulls|Last credit/.test(shown), `restricted summary must not mention credit: ${shown}`);
  assert.match(shown, /Deals: 1/);

  const full = { ...RESTRICTED_DETAIL, credit_pulls: [{ provider_status: 'approved', score_placeholder: 700 }] };
  context.UN.api = async () => full;
  await context.openClient(1);
  assert.match(shown, /Credit pulls: 1/);
  assert.match(shown, /Last credit: approved Score 700/);
});

test('Home dashboard still loads when the person has no access to client records', async () => {
  const html = read('home.html');
  const source = html.match(/async function loadDashboard\(\) \{[\s\S]*?\n\}\n/)[0];
  const calls = [];
  const errors = [];
  const context = vm.createContext({
    dashboardAlerts: [], dashboardCustomers: [], toast: (message, type) => { if (type === 'err') errors.push(message); },
    renderMetrics: metrics => calls.push(['metrics', metrics]), showNextAlert: () => calls.push(['alert']),
    UN: {
      api: async (_m, url) => {
        if (url.startsWith('/api/customers')) throw new Error('You do not have access to client records');
        return { metrics: { deals_need_follow_up: 2 }, alerts: [] };
      },
    },
  });
  vm.runInContext(`let dashboardAlerts = []; let dashboardCustomers = [];\n${source}\nthis.loadDashboard = loadDashboard; this.state = () => ({ dashboardCustomers, dashboardAlerts });`, context);
  await context.loadDashboard();
  assert.deepEqual(errors, [], 'no error toast for a restricted user');
  assert.equal(JSON.stringify(context.state().dashboardCustomers), '[]');
  assert.ok(calls.some(([name]) => name === 'metrics'), 'the dashboard still renders its metrics');
});
