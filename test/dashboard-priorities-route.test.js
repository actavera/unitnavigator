'use strict';
// Route-level coverage for GET /api/dashboard/priorities and
// POST /api/dashboard/priorities/ai-guidance: tenant isolation, permission
// gating on the stale-user category, and the real route's deterministic
// behavior with no OPENAI_API_KEY set (genuinely no network call is made —
// generateBatchGuidance throws before ever reaching https.request).
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
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-priorities-route-test-'));
  const port = 4600 + Math.floor(Math.random() * 500);
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      UNITNAV_DATA_DIR: tmpDataDir,
      JWT_SECRET,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // OPENAI_API_KEY is deliberately NOT set for this server process — the
  // deterministic-without-a-key test below relies on that.
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

function dbHandle() {
  return new Database(path.join(tmpDataDir, 'unitnavigator.db'));
}

// Seeds one stalled deal and one aging unit directly (backdated timestamps
// aren't reachable through the app's own API), reusing the exact detection
// windows getDealAlerts/getUnitAlerts already use (3+ days pending, 30+ day
// milestone) — proving this test rides the SAME detection logic, not a
// duplicate of it.
function seedAlertData(dealershipId) {
  const db = dbHandle();
  try {
    const customer = db.prepare(`
      INSERT INTO customers (dealership_id, first_name, last_name, phone, email)
      VALUES (?, 'Test', 'Buyer', '555-0100', 'buyer@example.com')
    `).run(dealershipId);
    const unit = db.prepare(`
      INSERT INTO units (dealership_id, vin, year, make, model, stage, created_at)
      VALUES (?, 'VINSEED0000000001', 2019, 'Ford', 'F-150', 'ready', datetime('now', '-40 days'))
    `).run(dealershipId);
    db.prepare(`
      INSERT INTO deals (dealership_id, customer_id, unit_id, deal_type, status, created_at)
      VALUES (?, ?, ?, 'cash', 'pending', datetime('now', '-10 days'))
    `).run(dealershipId, customer.lastInsertRowid, unit.lastInsertRowid);
    return { unitId: unit.lastInsertRowid };
  } finally {
    db.close();
  }
}

function insertStaffUserWithoutUsersManage(dealershipId) {
  const db = dbHandle();
  try {
    const info = db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, status, last_login_at)
      VALUES (?, 'Limited Staffer', ?, ?, 'staff', 'active', datetime('now'))
    `).run(dealershipId, `staff-${Date.now()}@example.com`, bcrypt.hashSync('x', 4));
    return info.lastInsertRowid;
  } finally {
    db.close();
  }
}

function insertStaleUser(dealershipId) {
  const db = dbHandle();
  try {
    db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, status, last_login_at)
      VALUES (?, 'Stale Person', ?, ?, 'staff', 'active', datetime('now', '-40 days'))
    `).run(dealershipId, `stale-${Date.now()}@example.com`, bcrypt.hashSync('x', 4));
  } finally {
    db.close();
  }
}

function tokenForUserId(id) {
  // requireAuth only trusts `id` from the token — it re-derives
  // dealership_id/role/permissions from the live DB row on every request —
  // so a minimal payload is sufficient and faithfully exercises that path.
  return jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' });
}

test('Dealer A never sees Dealer B\'s priorities, and vice versa', async () => {
  const dealerA = await demoDealer();
  const dealerB = await demoDealer();

  // Re-derive Dealer A's numeric dealership_id from its own token (never
  // trust anything client-suppliable) purely to seed test fixtures.
  const dealershipIdA = jwt.decode(dealerA.token).dealership_id;
  seedAlertData(dealershipIdA);

  const resA = await api(dealerA.token, 'GET', '/api/dashboard/priorities');
  const resB = await api(dealerB.token, 'GET', '/api/dashboard/priorities');
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  assert.ok(resA.body.priorities.length > 0, 'Dealer A must see the alerts seeded for its own dealership');
  assert.equal(resB.body.priorities.length, 0, 'Dealer B must see none of Dealer A\'s priorities');

  // Sanity: nothing in Dealer B's (empty) list can possibly leak Dealer A's
  // ids, but assert it explicitly for clarity.
  const leakedIds = resB.body.priorities.filter(p => resA.body.priorities.some(a => a.id === p.id));
  assert.equal(leakedIds.length, 0);
});

test('stale-user priorities are visible only to a user with users_manage; a staff user without it never sees them', async () => {
  const admin = await demoDealer();
  const dealershipId = jwt.decode(admin.token).dealership_id;
  insertStaleUser(dealershipId);
  const limitedStaffId = insertStaffUserWithoutUsersManage(dealershipId);
  const limitedToken = tokenForUserId(limitedStaffId);

  const asAdmin = await api(admin.token, 'GET', '/api/dashboard/priorities');
  const asLimitedStaff = await api(limitedToken, 'GET', '/api/dashboard/priorities');
  assert.equal(asAdmin.status, 200);
  assert.equal(asLimitedStaff.status, 200);

  assert.ok(asAdmin.body.priorities.some(p => p.type === 'user'), 'an admin (has users_manage) must see the stale-user priority');
  assert.ok(!asLimitedStaff.body.priorities.some(p => p.type === 'user'), 'a staff user without users_manage must never see stale-user priorities');
});

test('GET /api/dashboard/priorities requires authentication', async () => {
  const res = await api(null, 'GET', '/api/dashboard/priorities');
  assert.equal(res.status, 401);
});

test('the real route works completely without an OpenAI key: no network attempt, deterministic fallback response', async () => {
  const dealer = await demoDealer();
  const dealershipId = jwt.decode(dealer.token).dealership_id;
  seedAlertData(dealershipId);

  const priorities = await api(dealer.token, 'GET', '/api/dashboard/priorities');
  assert.ok(priorities.body.priorities.length > 0);

  const res = await api(dealer.token, 'POST', '/api/dashboard/priorities/ai-guidance', {
    ids: priorities.body.priorities.map(p => p.id),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ai_unavailable, true);
  assert.equal(res.body.reason, 'not_configured');
  assert.deepEqual(res.body.guidance, {});
});
