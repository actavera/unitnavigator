'use strict';
// Service-level coverage for missing-document reminders (services/reminders.js)
// and the provider adapters (services/messaging.js). No provider is contacted:
// sends go to an in-test fake and adapter requests to a fake transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const reminders = require('../services/reminders');
const messaging = require('../services/messaging');
const checklist = require('../services/dealChecklist');

const DAY = 86400000;
// 2026-10-19 18:00 UTC = noon in Denver (inside the 9am-6pm window).
const NOON = Date.parse('2026-10-19T18:00:00Z');
const ENV = { POSTMARK_SERVER_TOKEN: 'pm-test', REMINDER_EMAIL_FROM: 'dealer@example.com', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tw-secret', TWILIO_FROM_NUMBER: '+18015550000' };

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dealerships (id INTEGER PRIMARY KEY, name TEXT, legal_name TEXT, status TEXT DEFAULT 'active', phone TEXT, address TEXT, city TEXT, state TEXT, zip TEXT,
      reminders_email_enabled INTEGER DEFAULT 0, reminders_sms_enabled INTEGER DEFAULT 0, reminder_first_after_days INTEGER DEFAULT 2,
      reminder_interval_days INTEGER DEFAULT 3, reminder_max_attempts INTEGER DEFAULT 3, timezone TEXT DEFAULT 'America/Denver');
    CREATE TABLE users (id INTEGER PRIMARY KEY, dealership_id INTEGER, name TEXT);
    CREATE TABLE customers (id INTEGER PRIMARY KEY, dealership_id INTEGER, first_name TEXT, last_name TEXT, email TEXT, phone TEXT);
    CREATE TABLE deals (id INTEGER PRIMARY KEY, dealership_id INTEGER, customer_id INTEGER, unit_id INTEGER, deal_type TEXT, status TEXT DEFAULT 'pending');
    CREATE TABLE esign_envelopes (id INTEGER PRIMARY KEY, dealership_id INTEGER, deal_id INTEGER, status TEXT, title TEXT);
    CREATE TABLE activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, dealership_id INTEGER, entity_type TEXT, entity_id INTEGER, action TEXT, note TEXT, user_id INTEGER, created_at TEXT);
  `);
  db.exec(checklist.SCHEMA_SQL);
  db.exec(reminders.SCHEMA_SQL);
  db.prepare("INSERT INTO dealerships (id, name, phone, address, city, state, zip, reminders_email_enabled, reminders_sms_enabled) VALUES (1, 'A Motors', '801-555-0100', '1 Main', 'Provo', 'UT', '84601', 1, 1), (2, 'B Motors', NULL, NULL, NULL, NULL, NULL, 1, 1)").run();
  db.prepare("INSERT INTO customers (id, dealership_id, first_name, email, phone) VALUES (1, 1, 'Casey', 'casey@example.com', '(801) 555-0123'), (2, 2, 'Other', 'other@example.com', '801-555-0123')").run();
  db.prepare("INSERT INTO deals (id, dealership_id, customer_id, deal_type) VALUES (1, 1, 1, 'we_finance'), (2, 2, 2, 'cash')").run();
  return db;
}

function seedOutstanding(db, { dealershipId = 1, dealId = 1, daysAgo = 3, note } = {}) {
  checklist.addStandardItems(db, { dealershipId, dealId, actorId: null, now: NOON - daysAgo * DAY });
  if (note) checklist.addItem(db, { dealershipId, dealId, actorId: null, body: { item_key: 'pay_stubs', label: 'Extra stubs', note }, now: NOON - daysAgo * DAY });
}

const optIn = (db, channel, customerId = 1, dealershipId = 1) => reminders.recordConsent(db, { dealershipId, customerId, channel, status: 'opted_in', source: 'dealer_recorded' });

function fakeSend() {
  const sent = [];
  const send = { email: async m => { sent.push(['email', m]); return { provider: 'fake', provider_message_id: 'e1' }; }, sms: async m => { sent.push(['sms', m]); return { provider: 'fake', provider_message_id: 's1' }; } };
  return { sent, send };
}

const run = (db, opts = {}) => reminders.runReminders(db, { now: NOON, env: ENV, secret: 'secret', ...opts });

test('nothing is sent without consent, an enabled channel, a configured provider, or inside quiet hours', async () => {
  const db = freshDb();
  seedOutstanding(db);
  const { sent, send } = fakeSend();
  assert.equal((await run(db, { send })).sent, 0, 'no consent');
  optIn(db, 'email');
  assert.equal((await run(db, { send, env: {} })).sent, 0, 'no provider configured');
  db.prepare('UPDATE dealerships SET reminders_email_enabled = 0, reminders_sms_enabled = 0 WHERE id = 1').run();
  assert.equal((await run(db, { send })).sent, 0, 'channel disabled');
  db.prepare('UPDATE dealerships SET reminders_email_enabled = 1 WHERE id = 1').run();
  assert.equal((await run(db, { send, now: Date.parse('2026-10-19T04:00:00Z') })).sent, 0, '10pm in Denver is outside the window');
  assert.equal(sent.length, 0);
  assert.equal((await run(db, { send })).sent, 1);
  assert.deepEqual(sent.map(s => s[0]), ['email'], 'only the consented channel');
});

test('timing: first reminder after the delay, then the interval; resolved items stop reminders', async () => {
  const db = freshDb();
  seedOutstanding(db, { daysAgo: 1 });
  optIn(db, 'sms');
  const { sent, send } = fakeSend();
  assert.equal((await run(db, { send })).sent, 0, 'items only 1 day old; default first delay is 2');
  assert.equal((await run(db, { send, now: NOON + DAY })).sent, 1);
  assert.equal((await run(db, { send, now: NOON + 2 * DAY })).sent, 0, 'interval not reached');
  assert.equal((await run(db, { send, now: NOON + 4 * DAY })).sent, 1);
  db.prepare("UPDATE deal_checklist_items SET status = 'approved'").run();
  assert.equal((await run(db, { send, now: NOON + 8 * DAY })).sent, 0, 'nothing outstanding');
  assert.equal(sent.length, 2);
});

test('attempts are limited, failures are recorded and retried, then staff are alerted once', async () => {
  const db = freshDb();
  seedOutstanding(db);
  optIn(db, 'email');
  let fail = true;
  const send = { email: async () => { if (fail) throw new Error('Provider rejected the message (500)'); return { provider: 'fake' }; } };
  const r1 = await run(db, { send });
  assert.deepEqual([r1.sent, r1.failed], [0, 1]);
  const failed = db.prepare('SELECT status, error FROM communication_messages').get();
  assert.deepEqual([failed.status, /500/.test(failed.error)], ['failed', true]);
  fail = false;
  assert.equal((await run(db, { send, now: NOON + 3 * DAY })).sent, 1, 'retried on the next interval');
  assert.equal((await run(db, { send, now: NOON + 6 * DAY })).sent, 1);
  const r4 = await run(db, { send, now: NOON + 9 * DAY });
  assert.deepEqual([r4.sent, r4.escalated], [0, 1], 'three attempts used; escalated');
  assert.equal((await run(db, { send, now: NOON + 12 * DAY })).escalated, 0, 'escalates only once');
  assert.ok(db.prepare("SELECT 1 FROM activity_logs WHERE action = 'Reminders escalated to staff' AND entity_id = 1").get());
  assert.equal(db.prepare('SELECT attempts FROM deal_reminder_state WHERE deal_id = 1').get().attempts, 3);
});

test('message content names only outstanding items: no notes, no resolved items, opt-out included', async () => {
  const db = freshDb();
  seedOutstanding(db, { note: 'PRIVATE NOTE employer details' });
  db.prepare("UPDATE deal_checklist_items SET status = 'approved' WHERE item_key = 'insurance'").run();
  optIn(db, 'email');
  optIn(db, 'sms');
  const { sent, send } = fakeSend();
  await run(db, { send });
  const [[, email], [, sms]] = sent;
  for (const m of [email, sms]) {
    assert.ok(!m.text.includes('PRIVATE NOTE'), 'notes never included');
    assert.ok(!m.text.includes('Insurance'), 'resolved items not listed');
    assert.match(m.text, /Proof of residence/);
  }
  assert.match(email.text, /api\/public\/unsubscribe\?d=1&c=1&t=/);
  assert.match(email.text, /1 Main, Provo, UT, 84601/);
  assert.match(sms.text, /Reply STOP to opt out\.$/);
  assert.equal(sms.to, '+18015550123');
  const stored = db.prepare("SELECT body FROM communication_messages WHERE channel = 'sms'").get().body;
  assert.equal(stored, sms.text, 'the exact text sent is recorded');
});

test('STOP opts out every matching customer; START restores only prior opt-ins; unknown words do nothing', async () => {
  const db = freshDb();
  optIn(db, 'sms', 1, 1);
  assert.equal(reminders.handleInboundSms(db, { from: '+18015550199', body: 'hello' }), null);
  assert.match(reminders.handleInboundSms(db, { from: '+1 (801) 555-0123', body: ' Stop ' }), /unsubscribed/);
  assert.equal(reminders.latestConsent(db, 1, 1, 'sms').status, 'opted_out');
  assert.equal(reminders.latestConsent(db, 2, 2, 'sms').status, 'opted_out', 'same number at another dealership also stops');
  reminders.handleInboundSms(db, { from: '+18015550123', body: 'START' });
  assert.equal(reminders.latestConsent(db, 1, 1, 'sms').status, 'opted_in', 'prior opt-in restored');
  assert.equal(reminders.latestConsent(db, 2, 2, 'sms').status, 'opted_out', 'START never opts in someone without recorded consent');
  seedOutstanding(db);
  reminders.handleInboundSms(db, { from: '+18015550123', body: 'STOP' });
  const { sent, send } = fakeSend();
  await run(db, { send });
  assert.equal(sent.length, 0, 'opted-out customers are not messaged');
});

test('dealer consent requires attestation; unsubscribe tokens are customer-specific', () => {
  const db = freshDb();
  assert.throws(() => reminders.setDealConsent(db, { dealershipId: 1, dealId: 1, actorId: 1, body: { channel: 'sms', status: 'opted_in' } }), e => e.statusCode === 400);
  reminders.setDealConsent(db, { dealershipId: 1, dealId: 1, actorId: 1, body: { channel: 'sms', status: 'opted_in', attested: true } });
  assert.equal(reminders.latestConsent(db, 1, 1, 'sms').source, 'dealer_recorded');
  reminders.setDealConsent(db, { dealershipId: 1, dealId: 1, actorId: 1, body: { channel: 'sms', status: 'opted_out' } });
  assert.throws(() => reminders.setDealConsent(db, { dealershipId: 2, dealId: 1, actorId: 1, body: { channel: 'sms', status: 'opted_out' } }), e => e.statusCode === 404, 'tenant scoped');
  const token = reminders.unsubscribeToken('secret', 1, 1);
  assert.equal(reminders.validUnsubscribeToken('secret', 1, 1, token), true);
  assert.equal(reminders.validUnsubscribeToken('secret', 1, 2, token), false);
  assert.equal(reminders.validUnsubscribeToken('other', 1, 1, token), false);
});

test('adapters: request shapes, configuration checks, signature validation, address normalization', async () => {
  const requests = [];
  messaging.setTransport(async req => { requests.push(req); return { status: 200, body: JSON.stringify(req.hostname.includes('twilio') ? { sid: 'SM1' } : { MessageID: 'pm-1' }) }; });
  try {
    assert.deepEqual(await messaging.sendEmail({ to: 'a@example.com', subject: 'S', text: 'T' }, ENV), { provider: 'postmark', provider_message_id: 'pm-1' });
    assert.deepEqual(await messaging.sendSms({ to: '+18015550123', text: 'T' }, ENV), { provider: 'twilio', provider_message_id: 'SM1' });
    assert.equal(requests[0].hostname, 'api.postmarkapp.com');
    assert.equal(JSON.parse(requests[0].body).To, 'a@example.com');
    assert.equal(requests[1].path, '/2010-04-01/Accounts/AC123/Messages.json');
    assert.equal(new URLSearchParams(requests[1].body).get('From'), '+18015550000');
    await assert.rejects(messaging.sendSms({ to: '+1', text: 'x' }, {}), e => e.code === 'not_configured');
    messaging.setTransport(async () => ({ status: 400, body: '{"message":"bad number"}' }));
    await assert.rejects(messaging.sendSms({ to: '+1', text: 'x' }, ENV), /bad number/);
  } finally {
    messaging.setTransport(null);
  }
  assert.deepEqual(messaging.providerStatus({}), { email: false, sms: false });
  const params = { Body: 'STOP', From: '+18015550123' };
  const url = 'https://unitnavigator.com/api/public/sms/inbound';
  const signature = crypto.createHmac('sha1', 'tw-secret').update(url + 'BodySTOPFrom+18015550123').digest('base64');
  assert.equal(messaging.validTwilioSignature({ url, params, signature }, ENV), true);
  assert.equal(messaging.validTwilioSignature({ url, params: { ...params, Body: 'START' }, signature }, ENV), false);
  assert.equal(messaging.validTwilioSignature({ url, params, signature }, {}), false, 'unconfigured never validates');
  assert.equal(messaging.normalizePhone('801.555.0123'), '+18015550123');
  assert.equal(messaging.normalizePhone('555-0123'), null);
  assert.equal(messaging.normalizeEmail('x@example.invalid'), null);
});

test('tenant isolation in the runner and cleanup helpers', async () => {
  const db = freshDb();
  seedOutstanding(db, { dealershipId: 1, dealId: 1 });
  seedOutstanding(db, { dealershipId: 2, dealId: 2 });
  optIn(db, 'email', 1, 1);
  const { sent, send } = fakeSend();
  await run(db, { send });
  assert.deepEqual(sent.map(([, m]) => m.to), ['casey@example.com'], 'only the consented customer of dealership 1');
  reminders.deleteForDealership(db, 1);
  for (const t of ['communication_messages', 'communication_consents', 'deal_reminder_state']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE dealership_id = 1`).get().n, 0);
  }
});
