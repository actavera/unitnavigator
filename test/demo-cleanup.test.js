'use strict';
// Demo cleanup must remove a demo dealership's inventory-truth history
// (assignments, dispositions) and pricing comparables, and leave every other
// dealership's records alone. Real server, throwaway data directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');
let child;
let baseUrl;
let tmpDataDir;

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-demo-cleanup-test-'));
  const port = 5700 + Math.floor(Math.random() * 400);
  baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET: 'test-only-secret', NODE_ENV: 'test' };
  delete env.OPENAI_API_KEY;
  child = spawn(process.execPath, ['server.js'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 10000;
  for (;;) {
    try { await fetch(`${baseUrl}/api/public/dealer`); break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 100));
  }
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

async function api(token, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const withDb = fn => {
  const db = new Database(path.join(tmpDataDir, 'unitnavigator.db'));
  try { return fn(db); } finally { db.close(); }
};

async function demoWithHistory(vin) {
  const login = await api(null, 'POST', '/api/auth/demo-login');
  const token = login.body.token;
  const dealershipId = jwt.decode(token).dealership_id;
  const userId = jwt.decode(token).id;
  const unit = await api(token, 'POST', '/api/inventory', { vin, year: 2020, make: 'Clean', model: 'Probe', acquisition_cost: 100 });
  const unitId = unit.body.unit.id;
  assert.equal((await api(token, 'PUT', `/api/inventory/${unitId}/assignment`, { user_id: userId })).status, 200);
  assert.equal((await api(token, 'POST', `/api/inventory/${unitId}/disposition`, { outcome: 'retail_sold', amount: 12000 })).status, 201);
  return { token, dealershipId };
}

const counts = dealershipId => withDb(db => Object.fromEntries(
  ['unit_assignments', 'unit_dispositions', 'platform_sold_units'].map(t => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE dealership_id = ?`).get(dealershipId).n]),
));

test('demo cleanup removes assignment, disposition, and comparable rows for that dealership only', async () => {
  const doomed = await demoWithHistory('CLEANUPVIN0000001');
  const kept = await demoWithHistory('CLEANUPVIN0000002');
  const all = { unit_assignments: 1, unit_dispositions: 1, platform_sold_units: 1 };
  assert.deepEqual(counts(doomed.dealershipId), all, 'fixture created all three record types');
  assert.deepEqual(counts(kept.dealershipId), all);

  assert.equal((await api(doomed.token, 'POST', '/api/auth/demo-clear')).status, 200);

  assert.deepEqual(counts(doomed.dealershipId), { unit_assignments: 0, unit_dispositions: 0, platform_sold_units: 0 });
  assert.deepEqual(counts(kept.dealershipId), all, 'another dealership is untouched');
  withDb(db => {
    for (const t of ['unit_assignments', 'unit_dispositions', 'platform_sold_units']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE unit_id NOT IN (SELECT id FROM units)`).get().n, 0, `no orphan ${t}`);
    }
  });
});
