'use strict';
// End-to-end proof that DELETE /api/inventory/:id/photos cannot be used to
// delete an arbitrary file on the server via a crafted "url" body value.
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
let canaryPath;

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
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-traversal-test-'));
  // Stand-in for a file outside the uploads directory that a traversal
  // payload could reach (e.g. the sqlite file itself, or an nginx config).
  canaryPath = path.join(tmpDataDir, 'canary-do-not-delete.txt');
  fs.writeFileSync(canaryPath, 'if this file is gone, path traversal succeeded');

  const port = 4700 + Math.floor(Math.random() * 300);
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

test('a crafted photo URL cannot delete files outside the uploads directory', async () => {
  const login = await api(null, 'POST', '/api/auth/demo-login');
  assert.equal(login.status, 200);
  const token = login.body.token;

  const unitRes = await api(token, 'POST', '/api/inventory', {
    vin: 'TRAVERSAL0000000',
    year: 2021, make: 'Test', model: 'Traversal',
    acquisition_cost: 100,
  });
  assert.equal(unitRes.status, 201);
  const unitId = unitRes.body.unit.id;

  const relativeCanary = path.relative(path.join(REPO_ROOT, 'public'), canaryPath);
  const traversalPayloads = [
    `/uploads/units/../../../../../../..${path.sep}${relativeCanary}`.replace(/\\/g, '/'),
    '/uploads/units/../../../etc/passwd',
    '../../../../etc/passwd',
  ];

  for (const payload of traversalPayloads) {
    const del = await api(token, 'DELETE', `/api/inventory/${unitId}/photos`, { url: payload });
    // The route must not 500 (crash) and must not report the file as deleted from a real location.
    assert.notEqual(del.status, 500, `payload ${payload} caused a server error instead of being safely ignored`);
  }

  assert.ok(fs.existsSync(canaryPath), 'canary file outside the uploads directory must still exist');
  assert.equal(fs.readFileSync(canaryPath, 'utf8'), 'if this file is gone, path traversal succeeded');
});
