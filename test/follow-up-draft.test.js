'use strict';
// Service-level coverage for follow-up drafts. The provider transport is
// always replaced, so no test can contact OpenAI.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  buildFollowUpDraft, FollowUpError, templateDraft, renderDraft, promptFor, validateAiDraft, generateAiDraft, PLACEHOLDERS,
} = require('../services/followUpDraft');

const SECRETS = {
  last: 'LASTNAME-SENTINEL', first: 'FIRSTNAME-SENTINEL', phone: '801-555-0173', email: 'secret-person@example.com',
  address: 'ADDRESS-SENTINEL 99 Hidden Rd', idNumber: 'IDNUM-SENTINEL-8812', employer: 'EMPLOYER-SENTINEL', income: 6543.21,
  vin: 'VINSENTINEL0000009', price: 23987.65, minPrice: 19876.54, cost: 17654.32, dealType: 'bhph',
  sender: 'SENDER-SENTINEL', dealership: 'DEALERSHIP-SENTINEL Motors',
};

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dealerships (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, dealership_id INTEGER, name TEXT, email TEXT);
    CREATE TABLE customers (id INTEGER PRIMARY KEY, dealership_id INTEGER, first_name TEXT, last_name TEXT, phone TEXT, email TEXT, address TEXT, id_number TEXT, employer TEXT, monthly_income REAL);
    CREATE TABLE units (id INTEGER PRIMARY KEY, dealership_id INTEGER, vin TEXT, year INTEGER, make TEXT, model TEXT, asking_price REAL, minimum_price REAL, acquisition_cost REAL);
    CREATE TABLE deals (id INTEGER PRIMARY KEY, dealership_id INTEGER, customer_id INTEGER, unit_id INTEGER, deal_type TEXT, status TEXT, next_follow_up_at TEXT, last_status_check_at TEXT, created_at TEXT, closed_at TEXT);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, dealership_id INTEGER, deal_id INTEGER, status TEXT);
    CREATE TABLE activity_logs (id INTEGER PRIMARY KEY, dealership_id INTEGER, entity_type TEXT, entity_id INTEGER, action TEXT, note TEXT, user_id INTEGER);
  `);
  db.prepare('INSERT INTO dealerships (id, name) VALUES (1, ?), (2, ?)').run(SECRETS.dealership, 'Other Dealer');
  db.prepare('INSERT INTO users (id, dealership_id, name, email) VALUES (10, 1, ?, ?), (20, 2, ?, ?)').run(SECRETS.sender, 'sender@example.com', 'Other Sender', 'o@example.com');
  return db;
}

function addDeal(db, o = {}) {
  const dealership = o.dealership || 1;
  const customer = Number(db.prepare(`
    INSERT INTO customers (dealership_id, first_name, last_name, phone, email, address, id_number, employer, monthly_income)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(dealership, o.first === undefined ? 'Pat' : o.first, o.last === undefined ? SECRETS.last : o.last, SECRETS.phone, SECRETS.email, SECRETS.address, SECRETS.idNumber, SECRETS.employer, SECRETS.income).lastInsertRowid);
  const unit = o.noUnit ? null : Number(db.prepare(`
    INSERT INTO units (dealership_id, vin, year, make, model, asking_price, minimum_price, acquisition_cost)
    VALUES (?, ?, 2020, 'Honda', 'Accord', ?, ?, ?)
  `).run(dealership, SECRETS.vin, SECRETS.price, SECRETS.minPrice, SECRETS.cost).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO deals (dealership_id, customer_id, unit_id, deal_type, status, next_follow_up_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(dealership, o.customerId || customer, unit, SECRETS.dealType, o.status || 'pending', o.followUp === undefined ? null : o.followUp, o.createdAt || '2026-10-01 12:00:00').lastInsertRowid);
}

const NOW = new Date('2026-10-10T12:00:00Z').getTime();
const base = (db, dealId, extra = {}) => ({ db, dealershipId: 1, userId: 10, dealId, channel: 'email', now: NOW, ...extra });

function provider(responseText) {
  const calls = [];
  const requestOverride = async (_options, body) => {
    calls.push(body);
    if (typeof responseText === 'function') return responseText(body);
    return { output_text: responseText };
  };
  return { calls, generate: (channel, facts) => generateAiDraft(channel, facts, { requestOverride }) };
}

function withKey(fn) {
  return async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-fake-key-never-sent-anywhere';
    try { await fn(); } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  };
}

const snapshot = db => JSON.stringify(['dealerships', 'users', 'customers', 'units', 'deals', 'documents', 'activity_logs'].map(t => db.prepare(`SELECT * FROM ${t}`).all()));

// --- template drafts ---

test('the template draft fills names locally, uses the vehicle, and is available without AI or a key', async () => {
  const db = makeDb();
  const id = addDeal(db);
  const result = await buildFollowUpDraft(base(db, id));
  assert.equal(result.draft.source, 'template');
  assert.equal(result.draft.channel, 'email');
  assert.equal(result.ai_unavailable, undefined);
  assert.match(result.draft.subject, /2020 Honda Accord/);
  assert.match(result.draft.body, /^Hi Pat,/);
  assert.ok(result.draft.body.includes(`${SECRETS.sender} at ${SECRETS.dealership}`));
  assert.ok(result.draft.body.includes('the 2020 Honda Accord'));
  assert.ok(!/\{\{/.test(result.draft.subject + result.draft.body), 'every placeholder was filled');
});

test('text drafts have no subject and fit a text message', async () => {
  const db = makeDb();
  const id = addDeal(db);
  const result = await buildFollowUpDraft(base(db, id, { channel: 'text' }));
  assert.equal(result.draft.subject, undefined);
  assert.ok(result.draft.body.length <= 320);
  assert.match(result.draft.body, /Hi Pat/);
});

test('an overdue follow-up date selects the overdue purpose; otherwise it is a check-in', async () => {
  const db = makeDb();
  const overdue = addDeal(db, { followUp: '2026-10-05' });
  const upcoming = addDeal(db, { followUp: '2026-10-20' });
  const none = addDeal(db);
  assert.equal((await buildFollowUpDraft(base(db, overdue))).draft.purpose, 'overdue_follow_up');
  assert.equal((await buildFollowUpDraft(base(db, upcoming))).draft.purpose, 'check_in');
  assert.equal((await buildFollowUpDraft(base(db, none))).draft.purpose, 'check_in');
  assert.match((await buildFollowUpDraft(base(db, overdue))).draft.body, /little while/);
  assert.ok(!(await buildFollowUpDraft(base(db, overdue))).draft.purpose.includes('documents'), 'there is no documents-needed purpose');
});

test('a deal without a vehicle and a customer without a usable name still produce a sensible draft', async () => {
  const db = makeDb();
  const noVehicle = addDeal(db, { noUnit: true });
  const unnamed = addDeal(db, { first: 'New', last: 'Customer' });
  const blank = addDeal(db, { first: '', last: '' });
  const a = await buildFollowUpDraft(base(db, noVehicle));
  assert.match(a.draft.subject, /your vehicle search/);
  assert.match(a.draft.body, /the vehicle you were looking at/);
  for (const id of [unnamed, blank]) {
    assert.match((await buildFollowUpDraft(base(db, id))).draft.body, /^Hi there,/);
  }
});

test('names are cleaned: placeholder delimiters and control characters never survive, and only the first name is used', async () => {
  const db = makeDb();
  const id = addDeal(db, { first: 'Mary {{sender_name}} Ann\n', last: 'Smith' });
  const out = (await buildFollowUpDraft(base(db, id))).draft.body;
  assert.match(out, /^Hi Mary,/);
  const id2 = addDeal(db, { first: '{{x}}Zed', last: 'Q' });
  assert.match((await buildFollowUpDraft(base(db, id2))).draft.body, /^Hi xZed,/);
});

test('every template passes the same safety validator the AI output must pass', () => {
  for (const channel of ['email', 'text']) {
    for (const purpose of ['check_in', 'overdue_follow_up']) {
      for (const vehicle of ['2020 Honda Accord', '']) {
        const draft = templateDraft(channel, { purpose, vehicle });
        assert.doesNotThrow(() => validateAiDraft(JSON.stringify(draft), channel), `${channel}/${purpose}/${vehicle || 'no vehicle'}`);
      }
    }
  }
});

// --- request validation, scope, tenancy ---

test('invalid channels, missing deals, foreign deals, and non-pending deals are rejected', async () => {
  const db = makeDb();
  const mine = addDeal(db);
  const theirs = addDeal(db, { dealership: 2 });
  const closed = addDeal(db, { status: 'closed' });
  const dead = addDeal(db, { status: 'dead' });
  const changed = addDeal(db, { status: 'vehicle_changed' });

  await assert.rejects(() => buildFollowUpDraft(base(db, mine, { channel: 'sms' })), err => err instanceof FollowUpError && err.statusCode === 400);
  await assert.rejects(() => buildFollowUpDraft(base(db, mine, { channel: undefined })), FollowUpError);
  for (const bad of [999999, 'abc', -1, 0, null]) {
    await assert.rejects(() => buildFollowUpDraft(base(db, bad)), err => err instanceof FollowUpError && err.statusCode === 404, String(bad));
  }
  await assert.rejects(() => buildFollowUpDraft(base(db, theirs)), err => err.statusCode === 404, "another dealership's deal looks like a missing one");
  for (const id of [closed, dead, changed]) {
    await assert.rejects(() => buildFollowUpDraft(base(db, id)), err => err.statusCode === 409 && /pending/.test(err.message));
  }
});

test('data from another dealership is never used, even if a record points at it', async () => {
  const db = makeDb();
  const foreignCustomer = Number(db.prepare("INSERT INTO customers (dealership_id, first_name, last_name) VALUES (2, 'ForeignFirst', 'ForeignLast')").run().lastInsertRowid);
  const id = addDeal(db, { customerId: foreignCustomer });
  db.prepare('UPDATE deals SET unit_id = (SELECT id FROM units WHERE dealership_id = 1 LIMIT 1) WHERE id = ?').run(id);
  const foreignUnit = Number(db.prepare("INSERT INTO units (dealership_id, year, make, model) VALUES (2, 1999, 'ForeignMake', 'ForeignModel')").run().lastInsertRowid);
  db.prepare('UPDATE deals SET unit_id = ? WHERE id = ?').run(foreignUnit, id);
  const text = JSON.stringify((await buildFollowUpDraft(base(db, id))).draft);
  assert.ok(!text.includes('Foreign'), 'neither the foreign customer nor the foreign vehicle is used');
  assert.match(text, /Hi there/);
  const foreignSender = JSON.stringify((await buildFollowUpDraft(base(db, id, { userId: 20 }))).draft);
  assert.ok(!foreignSender.includes('Other Sender'), "another dealership's user is never used as the sender");
});

// --- no writes ---

test('building a draft, with or without AI, never writes: every table is identical before and after', withKey(async () => {
  const db = makeDb();
  const id = addDeal(db, { followUp: '2026-10-05' });
  const before = snapshot(db);
  const good = provider(JSON.stringify({ subject: 'Checking in', body: 'Hi {{customer_first_name}}, just checking in.\n{{sender_name}}\n{{dealership_name}}' }));
  await buildFollowUpDraft(base(db, id));
  await buildFollowUpDraft(base(db, id, { channel: 'text' }));
  await buildFollowUpDraft(base(db, id, { useAi: true, generate: good.generate }));
  await buildFollowUpDraft(base(db, id, { useAi: true, generate: provider('not json').generate }));
  assert.equal(snapshot(db), before);
}));

// --- what the provider receives ---

test('payload minimization: the provider receives no name, contact detail, VIN, price, deal type, or financial data', withKey(async () => {
  const db = makeDb();
  const id = addDeal(db, { followUp: '2026-10-05' });
  const p = provider(JSON.stringify({ subject: 'Checking in', body: 'Hi {{customer_first_name}},\n{{sender_name}}\n{{dealership_name}}' }));
  await buildFollowUpDraft(base(db, id, { useAi: true, generate: p.generate }));

  assert.equal(p.calls.length, 1);
  const sent = JSON.stringify(p.calls[0]);
  for (const secret of Object.values(SECRETS).map(String).concat(['Pat', 'sender@example.com', 'minimum_price', 'acquisition_cost', 'id_number', 'monthly_income', 'bhph', 'credit'])) {
    assert.ok(!sent.includes(secret), `the provider payload must not contain ${secret}`);
  }
  for (const placeholder of PLACEHOLDERS) assert.ok(sent.includes(`{{${placeholder}}}`), `the prompt uses the ${placeholder} placeholder`);
  assert.ok(sent.includes('2020 Honda Accord') && sent.includes('overdue_follow_up'), 'the permitted facts are sent');
  assert.match(p.calls[0].input, /Facts: \{"channel":"email","purpose":"overdue_follow_up","vehicle":"2020 Honda Accord","days_since_started":9\}/);
  assert.ok(p.calls[0].max_output_tokens <= 800);
}));

test('the prompt itself forbids prices, promises, contact details, and real names', () => {
  const prompt = promptFor('email', { purpose: 'check_in', vehicle: 'x', days_since_started: 1 });
  for (const phrase of ['Do not invent', 'prices, payments, discounts, financing', 'make no promises', 'phone numbers, email addresses, links', 'Never write a real name']) {
    assert.ok(prompt.includes(phrase), phrase);
  }
});

// --- AI success, one call, local substitution ---

test('an explicit AI request makes exactly one provider call and fills names in locally', withKey(async () => {
  const db = makeDb();
  const id = addDeal(db);
  const p = provider(JSON.stringify({
    subject: 'Checking in about your Accord',
    body: 'Hi {{customer_first_name}},\n\nI wanted to see how your search is going. Let me know if I can help.\n\nBest,\n{{sender_name}}\n{{dealership_name}}',
  }));
  const result = await buildFollowUpDraft(base(db, id, { useAi: true, generate: p.generate }));
  assert.equal(p.calls.length, 1);
  assert.equal(result.draft.source, 'ai');
  assert.equal(result.ai_unavailable, undefined);
  assert.equal(result.draft.subject, 'Checking in about your Accord');
  assert.ok(result.draft.body.startsWith('Hi Pat,'));
  assert.ok(result.draft.body.includes(SECRETS.sender) && result.draft.body.includes(SECRETS.dealership));
  assert.ok(!/\{\{/.test(result.draft.body));

  const none = provider('{}');
  await buildFollowUpDraft(base(db, id, { generate: none.generate }));
  assert.equal(none.calls.length, 0, 'no provider call unless AI is explicitly requested');
}));

test('a text-message AI draft carries no subject', withKey(async () => {
  const db = makeDb();
  const id = addDeal(db);
  const p = provider(JSON.stringify({ subject: 'ignored', body: 'Hi {{customer_first_name}}, checking in. {{sender_name}}, {{dealership_name}}' }));
  const result = await buildFollowUpDraft(base(db, id, { channel: 'text', useAi: true, generate: p.generate }));
  assert.equal(result.draft.source, 'ai');
  assert.equal(result.draft.subject, undefined);
}));

// --- fallbacks ---

test('missing key, timeout, malformed response, and provider error each fall back to the template with a clear reason', async () => {
  const db = makeDb();
  const id = addDeal(db);
  const run = generate => buildFollowUpDraft(base(db, id, { useAi: true, generate }));
  const cases = [
    ['not_configured', () => { const err = new Error('no key'); err.code = 'missing_openai_key'; throw err; }],
    ['timeout', () => { const err = new Error('OpenAI request timed out'); err.code = 'ETIMEDOUT'; throw err; }],
    ['unusable_response', () => { throw new Error('AI response was not valid JSON'); }],
    ['unavailable', () => { throw new Error('upstream 500'); }],
  ];
  const template = (await buildFollowUpDraft(base(db, id))).draft;
  for (const [reason, generate] of cases) {
    const result = await run(generate);
    assert.equal(result.ai_unavailable, true, reason);
    assert.equal(result.reason, reason);
    assert.match(result.message, /standard draft/);
    assert.deepEqual(result.draft, template, `${reason}: the deterministic draft is returned unchanged`);
  }
});

test('the real client without a key fails before any network use, and a successful key-less template request still works', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const db = makeDb();
    const id = addDeal(db);
    const viaAi = await buildFollowUpDraft(base(db, id, { useAi: true }));
    assert.equal(viaAi.reason, 'not_configured');
    assert.equal(viaAi.draft.source, 'template');
    assert.equal((await buildFollowUpDraft(base(db, id))).draft.source, 'template');
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

test('unusable AI output falls back with the unusable_response reason, for every bad shape', withKey(async () => {
  const db = makeDb();
  const id = addDeal(db);
  const bad = [
    'Sure! Here is a draft.', '[]', '"just a string"', '{}', '{"subject":"s"}', '{"body":"b"}', '{"subject":"s","body":""}',
    JSON.stringify({ subject: 's', body: 'x'.repeat(901) }), JSON.stringify({ subject: 'y'.repeat(91), body: 'ok' }),
    JSON.stringify({ subject: 's', body: 'Call me at 801-555-0100' }),
    JSON.stringify({ subject: 's', body: 'Email me at me@example.com' }),
    JSON.stringify({ subject: 's', body: 'See https://example.com/deal' }), JSON.stringify({ subject: 's', body: 'Visit www.example.com' }),
    JSON.stringify({ subject: 's', body: 'It is only $199 per month' }), JSON.stringify({ subject: 's', body: 'A 3% rate' }),
    JSON.stringify({ subject: 's', body: 'Big discount today' }), JSON.stringify({ subject: 's', body: 'Guaranteed approval' }),
    JSON.stringify({ subject: 's', body: '<b>Hi</b>' }),
    JSON.stringify({ subject: 's', body: 'Hi {{vehicle}}' }), JSON.stringify({ subject: 's', body: 'Hi {{customer_first_name' }),
    JSON.stringify({ subject: 's', body: 'Hi John, just checking in. {{sender_name}}' }),
    JSON.stringify({ subject: 's', body: 'Hi {{customer_first_name}}, just checking in.' }),
    JSON.stringify({ subject: '{{secret}}', body: 'ok' }),
    JSON.stringify({ subject: 5, body: 'ok' }), JSON.stringify({ subject: 's', body: { text: 'ok' } }),
  ];
  for (const raw of bad) {
    const result = await buildFollowUpDraft(base(db, id, { useAi: true, generate: provider(raw).generate }));
    assert.equal(result.reason, 'unusable_response', raw.slice(0, 60));
    assert.equal(result.draft.source, 'template');
  }
  const text = await buildFollowUpDraft(base(db, id, { channel: 'text', useAi: true, generate: provider(JSON.stringify({ body: 'y'.repeat(321) })).generate }));
  assert.equal(text.reason, 'unusable_response', 'a text over 320 characters is rejected');
}));

test('fenced JSON from the model is accepted; extra fields it adds are ignored', withKey(async () => {
  const db = makeDb();
  const id = addDeal(db);
  const raw = '```json\n' + JSON.stringify({ subject: 'Hello', body: 'Hi {{customer_first_name}}. {{sender_name}}', status: 'closed', price: 1, next_follow_up_at: '2030-01-01' }) + '\n```';
  const before = snapshot(db);
  const result = await buildFollowUpDraft(base(db, id, { useAi: true, generate: provider(raw).generate }));
  assert.equal(result.draft.source, 'ai');
  assert.deepEqual(Object.keys(result.draft).sort(), ['body', 'channel', 'purpose', 'source', 'subject'], 'AI can only supply subject and body');
  assert.equal(snapshot(db), before, 'and cannot change a deal status, price, or follow-up date');
}));

test('renderDraft leaves unknown placeholders empty rather than echoing them', () => {
  assert.equal(renderDraft({ body: 'A {{customer_first_name}} B {{nope}} C' }, { customer_first_name: 'Pat' }).body, 'A Pat B  C');
});
