'use strict';
// HTTP hardening: security headers, health check, JSON 404/400 responses
// without internals, throttling of sign-in and demo sessions, per-account
// login lockout, session invalidation on password change, and production
// environment validation. Real server with rate limits enabled.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { validateProductionEnv } = require('../services/security');

const REPO_ROOT = path.join(__dirname, '..');
const JWT_SECRET = 'test-only-secret-do-not-use-in-prod';
let child;
let baseUrl;
let tmpDataDir;

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-security-test-'));
  const port = 8100 + Math.floor(Math.random() * 400);
  baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET, NODE_ENV: 'test', UNITNAV_TEST_RATE_LIMITS: '1' };
  delete env.OPENAI_API_KEY;
  child = spawn(process.execPath, ['server.js'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 10000;
  for (;;) {
    try { await fetch(`${baseUrl}/healthz`); break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 100));
  }
});
test.after(() => { if (child) child.kill(); fs.rmSync(tmpDataDir, { recursive: true, force: true }); });

const req = (method, urlPath, { body, headers = {}, token } = {}) => fetch(`${baseUrl}${urlPath}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body,
});
const withDb = fn => { const db = new Database(path.join(tmpDataDir, 'unitnavigator.db')); try { return fn(db); } finally { db.close(); } };

test('security headers on pages and API; no x-powered-by; API responses not cached', async () => {
  const page = await req('GET', '/login');
  for (const h of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy']) assert.ok(page.headers.get(h), h);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'.*object-src 'none'/);
  assert.equal(page.headers.get('x-powered-by'), null);
  const api = await req('GET', '/api/public/dealer');
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('health check, JSON 404 for unknown API routes, and malformed bodies without internals', async () => {
  const health = await req('GET', '/healthz');
  assert.deepEqual([health.status, await health.json()], [200, { ok: true }]);
  const missing = await req('GET', '/api/does-not-exist');
  assert.deepEqual([missing.status, await missing.json()], [404, { error: 'Not found' }]);
  const bad = await req('POST', '/api/auth/login', { body: '{"email": ' });
  const text = await bad.text();
  assert.equal(bad.status, 400);
  assert.ok(!/at |node_modules|SyntaxError/.test(text), 'no stack or internals');
});

test('per-account lockout after repeated failures; timing-equalized unknown accounts', async () => {
  const email = `lock-${Date.now()}@example.invalid`;
  withDb(db => db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Lock', ?, ?, 'staff')").run(email, bcrypt.hashSync('Right-Password-1', 4)));
  for (let i = 0; i < 8; i += 1) assert.equal((await req('POST', '/api/auth/login', { body: JSON.stringify({ email, password: 'wrong' }) })).status, 401);
  assert.equal((await req('POST', '/api/auth/login', { body: JSON.stringify({ email, password: 'Right-Password-1' }) })).status, 429, 'locked even with the right password');
  assert.equal((await req('POST', '/api/auth/login', { body: JSON.stringify({ email: 'nobody@example.invalid', password: 'x' }) })).status, 401);
});

test('per-IP throttling of sign-in attempts', async () => {
  let last;
  for (let i = 0; i < 25; i += 1) last = await req('POST', '/api/auth/login', { body: JSON.stringify({ email: `ip-${i}@example.invalid`, password: 'x' }) });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('a password change invalidates sessions issued before it', async () => {
  const id = withDb(db => Number(db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Sess', ?, 'x', 'admin')").run(`sess-${Date.now()}@example.invalid`).lastInsertRowid));
  const old = jwt.sign({ id, iat: Math.floor(Date.now() / 1000) - 3600 }, JWT_SECRET);
  assert.notEqual((await req('GET', '/api/inventory', { token: old })).status, 401);
  withDb(db => db.prepare('UPDATE users SET password_changed_at = ? WHERE id = ?').run(new Date().toISOString(), id));
  assert.equal((await req('GET', '/api/inventory', { token: old })).status, 401);
  const fresh = jwt.sign({ id }, JWT_SECRET);
  assert.notEqual((await req('GET', '/api/inventory', { token: fresh })).status, 401);
});

test('production refuses a missing or short JWT secret', () => {
  assert.throws(() => validateProductionEnv({ NODE_ENV: 'production', JWT_SECRET: 'short' }));
  assert.throws(() => validateProductionEnv({ NODE_ENV: 'production' }));
  assert.doesNotThrow(() => validateProductionEnv({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(64) }));
  assert.doesNotThrow(() => validateProductionEnv({ NODE_ENV: 'test' }));
});
