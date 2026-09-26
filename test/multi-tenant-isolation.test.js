'use strict';
// Proves Dealer A cannot read, modify, export, or delete Dealer B's data.
// Drives the real HTTP server directly (no UI), the way a malicious or
// compromised dealer account would call the API.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

let child;
let baseUrl;
let tmpDataDir;

async function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-isolation-test-'));
  const port = 4100 + Math.floor(Math.random() * 500);
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      UNITNAV_DATA_DIR: tmpDataDir,
      JWT_SECRET: 'test-only-secret-do-not-use-in-prod',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForServer(`${baseUrl}/api/paperwork`);
});

test.after(async () => {
  if (child) child.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

async function api(token, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, raw: text };
}

async function demoDealer() {
  const res = await api(null, 'POST', '/api/auth/demo-login');
  assert.equal(res.status, 200, `demo-login failed: ${res.raw}`);
  return { token: res.body.token, user: res.body.user };
}

test('two dealerships cannot see, modify, export, or delete each other\'s data', async () => {
  const dealerA = await demoDealer();
  const dealerB = await demoDealer();

  // --- Seed a unit for Dealer A ---
  const unitRes = await api(dealerA.token, 'POST', '/api/inventory', {
    vin: '1FTFW1ET' + '1EFA00001',
    year: 2019, make: 'Ford', model: 'F-150',
    acquisition_cost: 12000, asking_price: 18000,
  });
  assert.equal(unitRes.status, 201, `Dealer A unit create failed: ${JSON.stringify(unitRes.body)}`);
  const unitId = unitRes.body.unit.id;

  // --- Seed a deal (and customer) for Dealer A ---
  const dealRes = await api(dealerA.token, 'POST', '/api/deals', {
    deal_type: 'cash',
    unit_id: unitId,
    customer: { name: 'Alice Buyer', email: 'alice@example.com', phone: '555-0100', id_number: 'SSN-DEALER-A-SECRET' },
  });
  assert.equal(dealRes.status, 201, `Dealer A deal create failed: ${JSON.stringify(dealRes.body)}`);
  const dealId = dealRes.body.deal.id;
  const customerId = dealRes.body.deal.customer_id;

  // ========== READ ==========
  {
    const r = await api(dealerB.token, 'GET', `/api/inventory/${unitId}`);
    assert.equal(r.status, 404, 'Dealer B must not be able to read Dealer A\'s unit');
  }
  {
    const r = await api(dealerB.token, 'GET', `/api/customers/${customerId}`);
    assert.equal(r.status, 404, 'Dealer B must not be able to read Dealer A\'s customer');
    assert.ok(!JSON.stringify(r.body).includes('SSN-DEALER-A-SECRET'), 'Dealer A PII must never appear in Dealer B response');
  }
  {
    const r = await api(dealerB.token, 'GET', '/api/deals');
    const leaked = (r.body.deals || []).some(d => d.id === dealId);
    assert.equal(leaked, false, 'Dealer A\'s deal must not appear in Dealer B\'s deal list');
  }

  // ========== EXPORT ==========
  {
    const r = await api(dealerB.token, 'GET', '/api/inventory/export');
    assert.equal(r.status, 200);
    assert.ok(!r.raw.includes(unitRes.body.unit.vin), 'Dealer B\'s inventory export must not contain Dealer A\'s VIN');
  }
  {
    const r = await api(dealerB.token, 'GET', '/api/deals/export/contacts.csv');
    assert.equal(r.status, 200);
    assert.ok(!r.raw.includes('alice@example.com'), 'Dealer B\'s contact export must not contain Dealer A\'s customer email');
  }

  // ========== MODIFY ==========
  {
    const r = await api(dealerB.token, 'PUT', `/api/inventory/${unitId}`, { notes: 'pwned by dealer B' });
    assert.equal(r.status, 404, 'Dealer B must not be able to modify Dealer A\'s unit');
    const check = await api(dealerA.token, 'GET', `/api/inventory/${unitId}`);
    assert.notEqual(check.body.unit.notes, 'pwned by dealer B');
  }
  {
    const r = await api(dealerB.token, 'PATCH', `/api/inventory/${unitId}/stage`, { stage: 'sold' });
    assert.equal(r.status, 404, 'Dealer B must not be able to change Dealer A\'s unit stage');
  }
  {
    const r = await api(dealerB.token, 'PATCH', `/api/deals/${dealId}/status`, { status: 'dead' });
    assert.equal(r.status, 404, 'Dealer B must not be able to change Dealer A\'s deal status');
  }

  // ========== DELETE ==========
  {
    const r = await api(dealerB.token, 'DELETE', `/api/inventory/${unitId}`);
    assert.equal(r.status, 404, 'Dealer B must not be able to delete Dealer A\'s unit');
    const check = await api(dealerA.token, 'GET', `/api/inventory/${unitId}`);
    assert.equal(check.status, 200, 'Dealer A\'s unit must still exist after Dealer B\'s delete attempt');
  }
  {
    const r = await api(dealerB.token, 'DELETE', `/api/customers/${customerId}`);
    assert.equal(r.status, 404, 'Dealer B must not be able to delete Dealer A\'s customer');
    const check = await api(dealerA.token, 'GET', `/api/customers/${customerId}`);
    assert.equal(check.status, 200, 'Dealer A\'s customer must still exist after Dealer B\'s delete attempt');
  }
  {
    const r = await api(dealerB.token, 'DELETE', `/api/deals/${dealId}`);
    assert.equal(r.status, 404, 'Dealer B must not be able to delete Dealer A\'s deal');
  }

  // ========== ADMIN / SETTINGS / USER MANAGEMENT ==========
  {
    // The login payload only carries the dealership NAME; /api/auth/me returns the
    // raw JWT claims, including the numeric dealership_id we need for these checks.
    const meA = await api(dealerA.token, 'GET', '/api/auth/me');
    const dealershipAId = meA.body.user.dealership_id;

    const settingsRead = await api(dealerB.token, 'GET', `/api/admin/dealership-settings?dealership_id=${dealershipAId}`);
    assert.equal(settingsRead.status, 403, 'Dealer B must not be able to view Dealer A\'s dealership settings');

    const settingsWrite = await api(dealerB.token, 'PUT', '/api/admin/dealership-settings', {
      dealership_id: dealershipAId,
      name: 'Hijacked By Dealer B',
    });
    assert.equal(settingsWrite.status, 403, 'Dealer B must not be able to modify Dealer A\'s dealership settings');

    const usersRead = await api(dealerB.token, 'GET', `/api/admin/dealership-users?dealership_id=${dealershipAId}`);
    assert.equal(usersRead.status, 403, 'Dealer B must not be able to list Dealer A\'s users');

    const usersCreate = await api(dealerB.token, 'POST', '/api/admin/dealership-users', {
      dealership_id: dealershipAId, name: 'Injected User', email: 'injected@example.com', password: 'password123',
    });
    assert.equal(usersCreate.status, 403, 'Dealer B must not be able to create a user under Dealer A');
  }
});

test('a staff user without contracts_manage cannot generate the official signing packet', async () => {
  const dealer = await demoDealer();
  const meRes = await api(dealer.token, 'GET', '/api/auth/me');
  const dealershipId = meRes.body.user.dealership_id;

  const staffEmail = `staff-${Date.now()}@example.com`;
  const createStaff = await api(dealer.token, 'POST', '/api/admin/dealership-users', {
    dealership_id: dealershipId,
    name: 'Limited Staff',
    email: staffEmail,
    password: 'password123',
    role: 'staff',
  });
  assert.equal(createStaff.status, 201, `staff creation failed: ${JSON.stringify(createStaff.body)}`);
  assert.ok(!createStaff.body.user.permissions.includes('contracts_manage'), 'default staff role must not include contracts_manage');

  const loginRes = await api(null, 'POST', '/api/auth/login', { email: staffEmail, password: 'password123' });
  assert.equal(loginRes.status, 200);
  const staffToken = loginRes.body.token;

  const packetRes = await api(staffToken, 'POST', '/api/paperwork/official-packet', {
    customer: { name: 'Test Buyer' },
    vehicle: { year: 2020, make: 'Test', model: 'Car', vin: '1'.repeat(17) },
  });
  assert.equal(packetRes.status, 403, 'Staff without contracts_manage must not be able to generate the official signing packet');
});
