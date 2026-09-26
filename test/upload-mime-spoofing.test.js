'use strict';
// Proves that a file whose bytes are not really an image gets rejected (and
// deleted) even when the multipart request lies about the Content-Type of
// that file part — the classic MIME-spoofing bypass of a fileFilter that
// only ever inspects the caller-supplied type.
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
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-mime-spoof-test-'));
  const port = 4900 + Math.floor(Math.random() * 300);
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
  const body = await res.json();
  return body.token;
}

const REAL_PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // valid PNG magic bytes (truncated, header only)
const NOT_AN_IMAGE_BYTES = Buffer.from('<script>alert(1)</script>\n'.repeat(20), 'utf8');

test('unit-photo upload rejects a non-image file that spoofs image/png as its Content-Type', async () => {
  const token = await demoLogin();
  const unitRes = await fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vin: 'MIMESPOOF000001', year: 2020, make: 'Test', model: 'Spoof', acquisition_cost: 100 }),
  });
  const unit = (await unitRes.json()).unit;

  const form = new FormData();
  form.append('photos', new Blob([NOT_AN_IMAGE_BYTES], { type: 'image/png' }), 'totally-a-photo.png');

  const uploadRes = await fetch(`${baseUrl}/api/inventory/${unit.id}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const uploadBody = await uploadRes.json();

  assert.equal(uploadRes.status, 400, `expected the spoofed upload to be rejected, got ${uploadRes.status}: ${JSON.stringify(uploadBody)}`);

  const detail = await fetch(`${baseUrl}/api/inventory/${unit.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const detailBody = await detail.json();
  assert.equal(detailBody.unit.photos.length, 0, 'the spoofed file must not have been recorded as a photo');
});

test('unit-photo upload accepts a real PNG and keeps a mix of valid + spoofed files partially', async () => {
  const token = await demoLogin();
  const unitRes = await fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vin: 'MIMESPOOF000002', year: 2020, make: 'Test', model: 'Mixed', acquisition_cost: 100 }),
  });
  const unit = (await unitRes.json()).unit;

  const form = new FormData();
  form.append('photos', new Blob([REAL_PNG_BYTES], { type: 'image/png' }), 'real.png');
  form.append('photos', new Blob([NOT_AN_IMAGE_BYTES], { type: 'image/png' }), 'fake.png');

  const uploadRes = await fetch(`${baseUrl}/api/inventory/${unit.id}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const uploadBody = await uploadRes.json();
  assert.equal(uploadRes.status, 200);
  assert.equal(uploadBody.photos.length, 1, 'only the genuine PNG should have been kept');
  assert.equal(uploadBody.rejected, 1);
});

test('dealership logo upload rejects a non-image file that spoofs image/png', async () => {
  const token = await demoLogin();
  const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const dealershipId = me.user.dealership_id;

  const form = new FormData();
  form.append('dealership_id', String(dealershipId));
  form.append('logo', new Blob([NOT_AN_IMAGE_BYTES], { type: 'image/png' }), 'logo.png');

  const res = await fetch(`${baseUrl}/api/admin/dealership-settings/logo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(res.status, 400);

  const settings = await (await fetch(`${baseUrl}/api/admin/dealership-settings?dealership_id=${dealershipId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  assert.ok(!settings.dealership.logo_url, 'logo_url must not have been set from the spoofed upload');
});
