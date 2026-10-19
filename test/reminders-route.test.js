'use strict';
// Route-level coverage for reminder settings, consent, history, the signed
// SMS webhook, email unsubscribe, the escalation metric, and cleanup. Real
// server in a throwaway data directory. Twilio values below are fake; the
// server never sends in tests (NODE_ENV=test disables the scheduler).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const reminders = require('../services/reminders');

const REPO_ROOT = path.join(__dirname, '..');
const JWT_SECRET = 'test-only-secret-do-not-use-in-prod';
const TWILIO_TOKEN = 'fake-twilio-token';
let child;
let baseUrl;
let tmpDataDir;

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-reminders-route-test-'));
  const port = 6600 + Math.floor(Math.random() * 400);
  baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET, NODE_ENV: 'test',
    TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: TWILIO_TOKEN, TWILIO_FROM_NUMBER: '+18015550000', PUBLIC_BASE_URL: 'https://unitnavigator.com',
  };
  delete env.OPENAI_API_KEY;
  delete env.POSTMARK_SERVER_TOKEN;
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

async function api(token, method, urlPath, body, headers = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

const withDb = fn => {
  const db = new Database(path.join(tmpDataDir, 'unitnavigator.db'));
  try { return fn(db); } finally { db.close(); }
};

let seq = 0;
async function dealer() {
  const res = await api(null, 'POST', '/api/auth/demo-login');
  return { token: res.body.token, dealershipId: jwt.decode(res.body.token).dealership_id };
}
function addUser(dealershipId, permissions) {
  seq += 1;
  const id = withDb(db => Number(db.prepare(`INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, status, last_login_at)
    VALUES (?, ?, ?, 'x', 'staff', ?, 'active', datetime('now'))`).run(dealershipId, `Rem ${seq}`, `rem-${seq}-${Date.now()}@example.invalid`, JSON.stringify(permissions)).lastInsertRowid));
  return { id, token: jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' }) };
}
function addDeal(dealershipId, phone = '801-555-0177', email = 'buyer@example.com') {
  return withDb(db => {
    const customer = Number(db.prepare("INSERT INTO customers (dealership_id, first_name, last_name, phone, email) VALUES (?, 'Rem', 'Probe', ?, ?)").run(dealershipId, phone, email).lastInsertRowid);
    return { customerId: customer, dealId: Number(db.prepare("INSERT INTO deals (dealership_id, customer_id, deal_type, status) VALUES (?, ?, 'we_finance', 'pending')").run(dealershipId, customer).lastInsertRowid) };
  });
}

test('settings: defaults, provider status, validation, permission', async () => {
  const a = await dealer();
  const s = await api(a.token, 'GET', '/api/admin/dealership-settings');
  const d = s.body.dealership;
  assert.deepEqual([d.reminders_email_enabled, d.reminders_sms_enabled, d.reminder_first_after_days, d.reminder_interval_days, d.reminder_max_attempts, d.timezone], [0, 0, 2, 3, 3, 'America/Denver']);
  assert.deepEqual(s.body.messaging, { email: false, sms: true });
  assert.ok(!s.text.includes(TWILIO_TOKEN), 'credentials never returned');
  for (const bad of [{ reminder_interval_days: 0 }, { reminder_max_attempts: 11 }, { reminder_first_after_days: 1.5 }, { timezone: 'Mars/Base' }]) {
    assert.equal((await api(a.token, 'PUT', '/api/admin/dealership-settings', { ...d, ...bad })).status, 400, JSON.stringify(bad));
  }
  const saved = await api(a.token, 'PUT', '/api/admin/dealership-settings', { ...d, reminders_sms_enabled: '1', reminder_interval_days: 5, timezone: 'America/Chicago' });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.dealership.reminders_sms_enabled, saved.body.dealership.reminder_interval_days, saved.body.dealership.timezone], [1, 5, 'America/Chicago']);
  const viewer = addUser(a.dealershipId, ['deals_view']);
  assert.equal((await api(viewer.token, 'PUT', '/api/admin/dealership-settings', { name: 'x', reminders_sms_enabled: 1 })).status, 403);
});

test('consent: deals_manage records with attestation; view-only and other dealerships refused; addresses masked', async () => {
  const a = await dealer();
  const b = await dealer();
  const viewer = addUser(a.dealershipId, ['deals_view']);
  const manager = addUser(a.dealershipId, ['deals_view', 'deals_manage']);
  const { dealId } = addDeal(a.dealershipId);
  assert.equal((await api(viewer.token, 'POST', `/api/deals/${dealId}/communications/consent`, { channel: 'sms', status: 'opted_in', attested: true })).status, 403);
  assert.equal((await api(b.token, 'POST', `/api/deals/${dealId}/communications/consent`, { channel: 'sms', status: 'opted_in', attested: true })).status, 404);
  assert.equal((await api(b.token, 'GET', `/api/deals/${dealId}/communications`)).status, 404);
  assert.equal((await api(manager.token, 'POST', `/api/deals/${dealId}/communications/consent`, { channel: 'sms', status: 'opted_in' })).status, 400, 'attestation required');
  const ok = await api(manager.token, 'POST', `/api/deals/${dealId}/communications/consent`, { channel: 'sms', status: 'opted_in', attested: true });
  assert.equal(ok.status, 200);
  const sms = ok.body.channels.find(c => c.channel === 'sms');
  assert.deepEqual([sms.consent, sms.provider_configured, sms.has_address], ['opted_in', true, true]);
  withDb(db => db.prepare("INSERT INTO communication_messages (dealership_id, deal_id, customer_id, channel, purpose, status, to_address, body, created_at) VALUES (?, ?, 0, 'sms', 'missing_documents', 'sent', '+18015550177', 'body text', datetime('now'))").run(a.dealershipId, dealId));
  const view = await api(viewer.token, 'GET', `/api/deals/${dealId}/communications`);
  assert.equal(view.body.messages[0].to_address, '•••0177');
  assert.ok(!view.text.includes('+18015550177') && !view.text.includes('body text'), 'full address and body not returned');
});

test('SMS webhook: unsigned or tampered requests are refused; a signed STOP opts out', async () => {
  const a = await dealer();
  const { dealId, customerId } = addDeal(a.dealershipId, '(801) 555-0188');
  await api(a.token, 'POST', `/api/deals/${dealId}/communications/consent`, { channel: 'sms', status: 'opted_in', attested: true });
  const params = { Body: 'STOP', From: '+18015550188' };
  const form = new URLSearchParams(params).toString();
  const sign = p => crypto.createHmac('sha1', TWILIO_TOKEN).update('https://unitnavigator.com/api/public/sms/inbound' + Object.keys(p).sort().map(k => k + p[k]).join('')).digest('base64');
  const formHeaders = sig => ({ 'Content-Type': 'application/x-www-form-urlencoded', ...(sig ? { 'X-Twilio-Signature': sig } : {}) });
  assert.equal((await api(null, 'POST', '/api/public/sms/inbound', form, formHeaders())).status, 403);
  assert.equal((await api(null, 'POST', '/api/public/sms/inbound', form, formHeaders(sign({ ...params, Body: 'HELLO' })))).status, 403);
  assert.equal(withDb(db => reminders.latestConsent(db, a.dealershipId, customerId, 'sms').status), 'opted_in');
  const res = await api(null, 'POST', '/api/public/sms/inbound', form, formHeaders(sign(params)));
  assert.equal(res.status, 200);
  assert.match(res.text, /<Message>You have been unsubscribed/);
  assert.equal(withDb(db => reminders.latestConsent(db, a.dealershipId, customerId, 'sms').source), 'sms_stop');
});

test('email unsubscribe link: valid token opts out; forged token refused', async () => {
  const a = await dealer();
  const { customerId } = addDeal(a.dealershipId);
  const token = reminders.unsubscribeToken(JWT_SECRET, a.dealershipId, customerId);
  assert.equal((await api(null, 'GET', `/api/public/unsubscribe?d=${a.dealershipId}&c=${customerId}&t=forged`)).status, 400);
  assert.equal((await api(null, 'GET', `/api/public/unsubscribe?d=${a.dealershipId}&c=${customerId + 1}&t=${token}`)).status, 400);
  const page = await api(null, 'GET', `/api/public/unsubscribe?d=${a.dealershipId}&c=${customerId}&t=${token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<form method="post"/);
  assert.equal(withDb(db => reminders.latestConsent(db, a.dealershipId, customerId, 'email')), null, 'GET (link scanners) changes nothing');
  assert.equal((await api(null, 'POST', '/api/public/unsubscribe', `d=${a.dealershipId}&c=${customerId}&t=forged`, { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 400);
  const ok = await api(null, 'POST', '/api/public/unsubscribe', `d=${a.dealershipId}&c=${customerId}&t=${token}`, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(ok.status, 200);
  assert.equal(withDb(db => reminders.latestConsent(db, a.dealershipId, customerId, 'email').status), 'opted_out');
});

test('escalated reminders appear in the dashboard metric; cleanup removes communications rows', async () => {
  const a = await dealer();
  const keep = await dealer();
  const { dealId, customerId } = addDeal(a.dealershipId);
  const kept = addDeal(keep.dealershipId);
  await api(a.token, 'POST', `/api/deals/${dealId}/checklist/standard`);
  await api(a.token, 'POST', `/api/deals/${dealId}/communications/consent`, { channel: 'email', status: 'opted_in', attested: true });
  await api(keep.token, 'POST', `/api/deals/${kept.dealId}/communications/consent`, { channel: 'email', status: 'opted_in', attested: true });
  withDb(db => db.prepare("INSERT INTO deal_reminder_state (dealership_id, deal_id, attempts, last_attempt_at, escalated_at) VALUES (?, ?, 3, datetime('now'), datetime('now'))").run(a.dealershipId, dealId));
  assert.equal((await api(a.token, 'GET', '/api/dashboard')).body.metrics.reminders_escalated, 1);
  assert.equal((await api(keep.token, 'GET', '/api/dashboard')).body.metrics.reminders_escalated, 0);

  assert.equal((await api(a.token, 'DELETE', `/api/customers/${customerId}`)).status, 200);
  const count = id => withDb(db => ['communication_consents', 'communication_messages', 'deal_reminder_state']
    .reduce((n, t) => n + db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE dealership_id = ?`).get(id).n, 0));
  assert.equal(count(a.dealershipId), 0, 'customer delete removed consent and reminder state');
  await api(keep.token, 'POST', '/api/auth/demo-clear');
  assert.equal(count(keep.dealershipId), 0, 'demo cleanup removed communications rows');
});
