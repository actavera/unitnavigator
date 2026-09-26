'use strict';
// Proves the extension-from-filename bug is closed: a file with genuinely
// valid image magic bytes (so it passes both the multer fileFilter and the
// magic-byte check) but named "payload.html" must never be stored, or served,
// as an .html file — its extension must come only from the detected content.
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
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-ext-test-'));
  const port = 5000 + Math.floor(Math.random() * 300);
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

async function demoLogin() {
  const res = await fetch(`${baseUrl}/api/auth/demo-login`, { method: 'POST' });
  return (await res.json()).token;
}

// Genuinely valid GIF magic bytes — passes both the fileFilter (claimed
// image/gif) and the magic-byte check. The only thing wrong with this upload
// is its filename.
const VALID_GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(20, 0)]);

test('unit-photo upload with a real image disguised under payload.html is stored and served with an image extension/content-type', async () => {
  const token = await demoLogin();
  const unitRes = await fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vin: 'EXTBUG00000000001', year: 2020, make: 'Test', model: 'Ext', acquisition_cost: 100 }),
  });
  const unit = (await unitRes.json()).unit;

  const form = new FormData();
  form.append('photos', new Blob([VALID_GIF_BYTES], { type: 'image/gif' }), 'payload.html');

  const uploadRes = await fetch(`${baseUrl}/api/inventory/${unit.id}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const uploadBody = await uploadRes.json();
  assert.equal(uploadRes.status, 200, JSON.stringify(uploadBody));
  assert.equal(uploadBody.photos.length, 1);

  const storedUrl = uploadBody.photos[0];
  assert.ok(!storedUrl.toLowerCase().endsWith('.html'), `stored URL must not end in .html, got ${storedUrl}`);
  assert.ok(storedUrl.toLowerCase().endsWith('.gif'), `stored URL must carry the detected .gif extension, got ${storedUrl}`);

  const served = await fetch(`${baseUrl}${storedUrl}`);
  const contentType = served.headers.get('content-type') || '';
  assert.ok(contentType.startsWith('image/'), `expected an image content type, got "${contentType}"`);
  assert.ok(!contentType.includes('html'), `must never be served as HTML, got "${contentType}"`);
});

test('dealership logo upload with a real image disguised under payload.html gets a server-generated extension', async () => {
  const token = await demoLogin();
  const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const dealershipId = me.user.dealership_id;

  const form = new FormData();
  form.append('dealership_id', String(dealershipId));
  form.append('logo', new Blob([VALID_GIF_BYTES], { type: 'image/gif' }), 'payload.html');

  const res = await fetch(`${baseUrl}/api/admin/dealership-settings/logo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.ok(!body.logo_url.toLowerCase().endsWith('.html'));
  assert.ok(body.logo_url.toLowerCase().endsWith('.gif'));

  const served = await fetch(`${baseUrl}${body.logo_url}`);
  const contentType = served.headers.get('content-type') || '';
  assert.ok(contentType.startsWith('image/'), `expected an image content type, got "${contentType}"`);
});
