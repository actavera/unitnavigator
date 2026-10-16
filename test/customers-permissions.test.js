'use strict';
// Client records hold personal and financial data. These tests pin who can
// read what from GET /api/customers and GET /api/customers/:id: basic contact
// and deal data for deal/paperwork/credit roles; address, ID number, employer
// and income only for paperwork_manage or credit_pull; credit pulls, scores
// and credit status only for credit_pull; nothing for anyone else; and never
// across dealerships. Hidden fields must not be readable, searchable,
// filterable, or sortable.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');
const JWT_SECRET = 'test-only-secret-do-not-use-in-prod';

const ID_NUMBER = 'IDNUM-SENTINEL-4471';
const EMPLOYER = 'EMPLOYER-SENTINEL-Acme';
const ADDRESS = 'ADDRESS-SENTINEL 12 Hidden Way';
const INCOME = 7777.77;
const RESULT = 'RESULT-SENTINEL-prime';
const INTEREST = 'INTEREST-SENTINEL-truck';
const SCORE = 731;
const VIN = 'VINSENTINEL0000001';

let child;
let baseUrl;
let tmpDataDir;
let A;          // demo admin of dealership A (all permissions)
let B;          // demo admin of dealership B
let customerA;
let customerB;
const tokens = {};

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.status) return; } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function get(token, urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  return { status: res.status, body: json, raw };
}

async function demo() {
  const res = await fetch(`${baseUrl}/api/auth/demo-login`, { method: 'POST' });
  const body = await res.json();
  return { token: body.token, dealershipId: jwt.decode(body.token).dealership_id };
}

function seedDealership(db, dealershipId, label) {
  db.prepare('DELETE FROM deals WHERE dealership_id = ?').run(dealershipId);
  db.prepare('DELETE FROM customers WHERE dealership_id = ?').run(dealershipId);
  const customer = Number(db.prepare(`
    INSERT INTO customers (dealership_id, first_name, last_name, phone, email, address, id_number, employer, monthly_income)
    VALUES (?, ?, 'Sentinel', '801-555-0100', ?, ?, ?, ?, ?)
  `).run(dealershipId, label, `${label.toLowerCase()}@example.com`, `${label} ${ADDRESS}`, `${label}-${ID_NUMBER}`, `${label}-${EMPLOYER}`, INCOME).lastInsertRowid);
  const pull = Number(db.prepare(`
    INSERT INTO credit_pulls (dealership_id, customer_id, provider, provider_status, result_summary, score_placeholder, consent_confirmed, vehicle_interest, notes)
    VALUES (?, ?, 'mock', 'approved', ?, ?, 1, ?, 'notes')
  `).run(dealershipId, customer, `${label}-${RESULT}`, SCORE, `${label}-${INTEREST}`).lastInsertRowid);
  const unit = Number(db.prepare("INSERT INTO units (dealership_id, vin, year, make, model, stage) VALUES (?, ?, 2020, 'Honda', 'Accord', 'ready')").run(dealershipId, `${label.slice(0, 1)}${VIN}`).lastInsertRowid);
  db.prepare("INSERT INTO deals (dealership_id, customer_id, unit_id, credit_pull_id, deal_type, status) VALUES (?, ?, ?, ?, 'cash', 'pending')").run(dealershipId, customer, unit, pull);
  return customer;
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-customers-perm-test-'));
  const port = 8800 + Math.floor(Math.random() * 300);
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(`${baseUrl}/api/public/dealer`);
  A = await demo();
  B = await demo();

  const db = new Database(path.join(tmpDataDir, 'unitnavigator.db'));
  try {
    customerA = seedDealership(db, A.dealershipId, 'Alpha');
    customerB = seedDealership(db, B.dealershipId, 'Bravo');
    const addUser = (key, permissions) => {
      const id = Number(db.prepare(`
        INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, status)
        VALUES (?, ?, ?, ?, 'staff', ?, 'active')
      `).run(A.dealershipId, key, `${key}@example.test`, bcrypt.hashSync('x', 4), JSON.stringify(permissions)).lastInsertRowid);
      tokens[key] = jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' });
    };
    addUser('nobody', ['inventory_view']);
    addUser('inventoryEditor', ['inventory_view', 'inventory_edit', 'inventory_pricing']);
    addUser('dealsView', ['deals_view']);
    addUser('dealsManage', ['deals_manage']);
    addUser('paperwork', ['paperwork_manage']);
    addUser('credit', ['credit_pull']);
  } finally {
    db.close();
  }
  tokens.admin = A.token;
  tokens.adminB = B.token;
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

const IDENTITY_FIELDS = ['address', 'id_number', 'employer', 'monthly_income'];
const CREDIT_FIELDS = ['last_credit_at', 'last_credit_status', 'last_score', 'credit_count'];
const IDENTITY_SECRETS = [ID_NUMBER, EMPLOYER, ADDRESS, String(INCOME)];
const CREDIT_SECRETS = [RESULT, INTEREST, String(SCORE), 'approved'];

const listOf = async key => (await get(tokens[key], '/api/customers?limit=75')).body.customers;
const mine = customers => customers.find(c => c.first_name === 'Alpha');

test('authentication is required', async () => {
  assert.equal((await get(null, '/api/customers')).status, 401);
  assert.equal((await get(null, `/api/customers/${customerA}`)).status, 401);
});

test('a user with none of the client-related permissions gets 403 from the list and the detail', async () => {
  for (const key of ['nobody', 'inventoryEditor']) {
    const list = await get(tokens[key], '/api/customers');
    assert.equal(list.status, 403, key);
    assert.ok(!list.raw.includes('Alpha') && !list.raw.includes('801-555-0100'));
    assert.equal((await get(tokens[key], `/api/customers/${customerA}`)).status, 403, key);
  }
});

test('deals_view and deals_manage receive basic contact and deal data only', async () => {
  for (const key of ['dealsView', 'dealsManage']) {
    const list = await get(tokens[key], '/api/customers?limit=75');
    assert.equal(list.status, 200, key);
    const customer = mine(list.body.customers);
    assert.ok(customer, key);
    assert.deepEqual([customer.name, customer.phone, customer.email, customer.last_vehicle, customer.deal_count], ['Alpha Sentinel', '801-555-0100', 'alpha@example.com', '2020 Honda Accord', 1], key);
    for (const field of [...IDENTITY_FIELDS, ...CREDIT_FIELDS]) assert.equal(field in customer, false, `${key} must not receive ${field}`);
    for (const secret of [...IDENTITY_SECRETS, ...CREDIT_SECRETS]) assert.ok(!list.raw.includes(secret), `${key} list must not contain ${secret}`);

    const detail = await get(tokens[key], `/api/customers/${customerA}`);
    assert.equal(detail.status, 200, key);
    for (const field of [...IDENTITY_FIELDS, ...CREDIT_FIELDS]) assert.equal(field in detail.body.customer, false, `${key} detail must not include ${field}`);
    assert.equal('credit_pulls' in detail.body, false, `${key} must not receive credit pulls`);
    for (const secret of [...IDENTITY_SECRETS, ...CREDIT_SECRETS]) assert.ok(!detail.raw.includes(secret), `${key} detail must not contain ${secret}`);
    assert.equal(detail.body.deals.length, 1);
    assert.equal(detail.body.deals[0].vehicle, '2020 Honda Accord');
  }
});

test('paperwork_manage additionally receives address, ID number, employer and income, but no credit data', async () => {
  const list = await get(tokens.paperwork, '/api/customers?limit=75');
  const customer = mine(list.body.customers);
  assert.equal(customer.id_number, `Alpha-${ID_NUMBER}`);
  assert.equal(customer.employer, `Alpha-${EMPLOYER}`);
  assert.equal(customer.monthly_income, INCOME);
  assert.ok(customer.address.includes('ADDRESS-SENTINEL'));
  for (const field of CREDIT_FIELDS) assert.equal(field in customer, false, `paperwork must not receive ${field}`);
  for (const secret of CREDIT_SECRETS) assert.ok(!list.raw.includes(secret), `paperwork list must not contain ${secret}`);

  const detail = await get(tokens.paperwork, `/api/customers/${customerA}`);
  assert.equal(detail.body.customer.id_number, `Alpha-${ID_NUMBER}`);
  assert.equal('credit_pulls' in detail.body, false);
  for (const secret of CREDIT_SECRETS) assert.ok(!detail.raw.includes(secret));
});

test('credit_pull and full-permission users receive identity and credit data', async () => {
  for (const key of ['credit', 'admin']) {
    const list = await get(tokens[key], '/api/customers?limit=75');
    const customer = mine(list.body.customers);
    assert.equal(customer.id_number, `Alpha-${ID_NUMBER}`, key);
    assert.equal(customer.last_credit_status, 'approved', key);
    assert.equal(customer.last_score, SCORE, key);
    assert.equal(customer.credit_count, 1, key);

    const detail = await get(tokens[key], `/api/customers/${customerA}`);
    assert.equal(detail.body.credit_pulls.length, 1, key);
    assert.equal(detail.body.credit_pulls[0].provider_status, 'approved');
    assert.equal(detail.body.credit_pulls[0].result_summary, `Alpha-${RESULT}`);
  }
});

test('the customer detail never returns raw rows: no credit_pull_id or other internal columns', async () => {
  const detail = await get(tokens.admin, `/api/customers/${customerA}`);
  assert.deepEqual(Object.keys(detail.body.deals[0]).sort(), ['closed_at', 'created_at', 'deal_type', 'id', 'make', 'model', 'next_follow_up_at', 'status', 'vehicle', 'vin', 'year']);
  assert.ok(!('dealership_id' in detail.body.customer));
  assert.ok(!('dealership_id' in detail.body.credit_pulls[0]));
  assert.ok(!('credit_pull_id' in detail.body.deals[0]));
  const basic = await get(tokens.dealsView, `/api/customers/${customerA}`);
  assert.deepEqual(Object.keys(basic.body.customer).sort(), ['created_at', 'deal_count', 'email', 'first_name', 'id', 'last_name', 'last_vehicle', 'name', 'phone'], 'a basic user gets exactly the basic columns');
});

test('hidden fields cannot be probed through search: a query only matches columns the caller may see', async () => {
  const search = async (key, q) => (await get(tokens[key], `/api/customers?limit=75&q=${encodeURIComponent(q)}`)).body.customers.filter(c => c.first_name === 'Alpha').length;

  // basic user: identity and credit text matches nothing
  for (const q of ['IDNUM-SENTINEL', 'EMPLOYER-SENTINEL', 'ADDRESS-SENTINEL', 'RESULT-SENTINEL', 'INTEREST-SENTINEL']) {
    assert.equal(await search('dealsView', q), 0, `dealsView must not match "${q}"`);
  }
  assert.equal(await search('dealsView', 'Alpha'), 1, 'visible columns still match');
  assert.equal(await search('dealsView', '801-555'), 1);
  assert.equal(await search('dealsView', VIN.slice(0, 12)), 1, 'the VIN is visible to this role, so it still matches');

  // identity user: identity text matches, credit text does not
  for (const q of ['IDNUM-SENTINEL', 'EMPLOYER-SENTINEL', 'ADDRESS-SENTINEL']) assert.equal(await search('paperwork', q), 1, `paperwork should match "${q}"`);
  for (const q of ['RESULT-SENTINEL', 'INTEREST-SENTINEL']) assert.equal(await search('paperwork', q), 0, `paperwork must not match "${q}"`);

  // credit user: everything matches
  for (const q of ['IDNUM-SENTINEL', 'RESULT-SENTINEL', 'INTEREST-SENTINEL']) assert.equal(await search('credit', q), 1, `credit should match "${q}"`);
});

test('credit filters and credit sorting cannot be used to infer credit data without credit access', async () => {
  const sets = {};
  for (const [label, qs] of [['none', ''], ['approved', '&credit=approved'], ['declined', '&credit=declined'], ['no-pulls', '&credit=none'], ['sort', '&sort=credit']]) {
    const res = await get(tokens.dealsView, `/api/customers?limit=75${qs}`);
    assert.equal(res.status, 200, label);
    sets[label] = res.body.customers.map(c => c.id).join(',');
  }
  assert.ok(Object.values(sets).every(value => value === sets.none || value.split(',').sort().join() === sets.none.split(',').sort().join()), 'the credit filter and sort are ignored for a basic user');

  const creditSees = async qs => (await get(tokens.credit, `/api/customers?limit=75${qs}`)).body.customers.some(c => c.first_name === 'Alpha');
  assert.equal(await creditSees('&credit=approved'), true, 'a credit user can still filter');
  assert.equal(await creditSees('&credit=declined'), false);
  assert.equal(await creditSees('&credit=none'), false);
});

test('tenant isolation: no one reads another dealership\'s clients, by list, detail, or search', async () => {
  const aAdminList = await get(tokens.admin, '/api/customers?limit=75');
  assert.ok(!aAdminList.raw.includes('Bravo') && !aAdminList.raw.includes(`Bravo-${ID_NUMBER}`));
  const bAdminList = await get(tokens.adminB, '/api/customers?limit=75');
  assert.ok(!bAdminList.raw.includes('Alpha') && !bAdminList.raw.includes(`Alpha-${ID_NUMBER}`));

  for (const key of ['admin', 'credit', 'paperwork', 'dealsView']) {
    assert.equal((await get(tokens[key], `/api/customers/${customerB}`)).status, 404, `${key} must not read dealership B's client`);
  }
  assert.equal((await get(tokens.adminB, `/api/customers/${customerA}`)).status, 404);

  const crossSearch = await get(tokens.admin, `/api/customers?limit=75&q=${encodeURIComponent('Bravo')}`);
  assert.deepEqual(crossSearch.body.customers, []);
});

test('deleting a client still requires deals_manage', async () => {
  assert.equal((await fetch(`${baseUrl}/api/customers/${customerA}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokens.dealsView}` } })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/customers/${customerA}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokens.nobody}` } })).status, 403);
  const stillThere = await get(tokens.admin, `/api/customers/${customerA}`);
  assert.equal(stillThere.status, 200);
});
