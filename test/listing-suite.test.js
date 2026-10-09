'use strict';
// Service-level coverage for bulk listing-description suggestions. The
// provider transport is always replaced (`requestOverride` / an injected
// `generate`), so these tests can never contact a real provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  runBulkSuggestions, parseRequest, ListingSuiteError, createCache, createInflight, MAX_UNITS,
} = require('../services/listingSuite');
const {
  generateBatchDescriptions, promptFor, batchPrompt, validateBatch, VARIANTS,
} = require('../services/vehicleDescription');

const SECRET_VIN = 'SECRETVIN0123456X';
const SECRET_MIN = 7771.23;
const SECRET_COST = 5559.87;
const SECRET_NOTE = 'PRIVATE-DEALER-NOTE-DO-NOT-SEND';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dealership_id INTEGER, vin TEXT, year INTEGER, make TEXT, model TEXT, trim TEXT,
      body_style TEXT, color TEXT, mileage INTEGER, asking_price REAL, minimum_price REAL,
      acquisition_cost REAL, notes TEXT, photos TEXT DEFAULT '[]'
    );
  `);
  return db;
}

function addUnit(db, dealership, overrides = {}) {
  const unit = {
    vin: SECRET_VIN, year: 2020, make: 'Honda', model: 'Accord', trim: 'EX', body_style: 'Sedan', color: 'Blue',
    mileage: 41000, asking_price: 15995, minimum_price: SECRET_MIN, acquisition_cost: SECRET_COST,
    notes: null, photos: '["/uploads/units/a.jpg"]', ...overrides,
  };
  return Number(db.prepare(`
    INSERT INTO units (dealership_id, vin, year, make, model, trim, body_style, color, mileage, asking_price, minimum_price, acquisition_cost, notes, photos)
    VALUES (@dealership_id, @vin, @year, @make, @model, @trim, @body_style, @color, @mileage, @asking_price, @minimum_price, @acquisition_cost, @notes, @photos)
  `).run({ dealership_id: dealership, ...unit }).lastInsertRowid);
}

// Builds a provider-shaped response from the prompt the service sent, so the
// fake provider answers for exactly the refs it was given.
function fakeProvider({ transform } = {}) {
  const calls = [];
  const requestOverride = async (_options, body) => {
    calls.push(body);
    const refs = [...body.input.matchAll(/"ref":"(v\d+)"/g)].map(m => m[1]);
    const items = refs.map(ref => ({ ref, description: `Suggestion for ${ref}.` }));
    return { output_text: JSON.stringify(transform ? transform(items) : items) };
  };
  return { calls, requestOverride };
}

function generateWith(requestOverride) {
  return (units, opts) => generateBatchDescriptions(units, { ...opts, requestOverride });
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

const snapshot = db => JSON.stringify(db.prepare('SELECT * FROM units ORDER BY id').all());

// --- request validation ---

test('ten-unit enforcement: 10 units are accepted, 11 are rejected with a 400 and no provider call', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => i + 1);
  assert.equal(parseRequest({ unit_ids: ids }).unitIds.length, MAX_UNITS);
  assert.throws(() => parseRequest({ unit_ids: [...ids, 11] }), err => err instanceof ListingSuiteError && err.statusCode === 400 && /up to 10/.test(err.message));

  const db = makeDb();
  let called = 0;
  await assert.rejects(
    () => runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [...ids, 11] }, generate: async () => { called += 1; return []; } }),
    ListingSuiteError,
  );
  assert.equal(called, 0);
});

test('duplicates are collapsed before the cap is applied; empty, non-integer and bad variants are rejected', () => {
  assert.equal(parseRequest({ unit_ids: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5] }).unitIds.length, 1);
  for (const bad of [undefined, [], 'abc', [0], [-1], [1.5], ['x'], [null]]) {
    assert.throws(() => parseRequest({ unit_ids: bad }), ListingSuiteError, `unit_ids=${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseRequest({ unit_ids: [1], variant: 'tiktok' }), /variant must be one of/);
  assert.equal(parseRequest({ unit_ids: [1] }).variant, 'standard');
  assert.equal(parseRequest({ unit_ids: [1], variant: 'facebook' }).variant, 'facebook');
  assert.equal(parseRequest({ unit_ids: [1], include_existing: 'true' }).includeExisting, false, 'only a literal true opts in');
});

test('variant names are matched as own properties only: inherited names like "constructor" are rejected', () => {
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => parseRequest({ unit_ids: [1], variant: bad }), ListingSuiteError, bad);
  }
  assert.throws(() => parseRequest({ unit_ids: [1], variant: 5 }), ListingSuiteError);
  assert.throws(() => parseRequest({ unit_ids: [1], variant: null }), ListingSuiteError);
});

test('unit_ids accepts only whole numbers and digit strings, never values that merely coerce', () => {
  assert.deepEqual(parseRequest({ unit_ids: [3, '4', 5] }).unitIds, [3, 4, 5]);
  for (const bad of [[true], [[5]], [{}], ['1e1'], ['0x10'], [' 7'], ['7 '], ['007'], [Number.MAX_SAFE_INTEGER + 2], [NaN], [Infinity]]) {
    assert.throws(() => parseRequest({ unit_ids: bad }), ListingSuiteError, JSON.stringify(bad));
  }
});

test('an oversized unit_ids array is rejected up front without per-id work', () => {
  const huge = Array.from({ length: 1_000_000 }, (_, i) => i + 1);
  const started = Date.now();
  assert.throws(() => parseRequest({ unit_ids: huge }), /up to 10/);
  assert.ok(Date.now() - started < 200, 'must reject immediately');
  assert.throws(() => parseRequest({ unit_ids: Array(51).fill(1) }), /up to 10/);
});

// --- tenant isolation ---

test('tenant isolation: another dealership\'s ids are silently excluded and never sent to the provider', withKey(async () => {
  const db = makeDb();
  const mine = addUnit(db, 1);
  const theirs = addUnit(db, 2, { make: 'Toyota', model: 'Camry' });
  const provider = fakeProvider();

  const result = await runBulkSuggestions({
    db, dealershipId: 1, body: { unit_ids: [mine, theirs, 99999] }, generate: generateWith(provider.requestOverride), cache: createCache(),
  });
  assert.deepEqual(result.units.map(u => u.id), [mine]);
  assert.equal(provider.calls.length, 1);
  assert.ok(!provider.calls[0].input.includes('Toyota') && !provider.calls[0].input.includes('Camry'), 'the foreign unit must never reach the provider');

  // A foreign id and a nonexistent id are indistinguishable.
  const withForeign = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [mine, theirs] }, generate: async () => [], cache: createCache() });
  const withMissing = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [mine, 424242] }, generate: async () => [], cache: createCache() });
  assert.deepEqual(withForeign, withMissing);

  const onlyForeign = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [theirs] }, generate: async () => assert.fail('no provider call for no units'), cache: createCache() });
  assert.deepEqual(onlyForeign.units, []);
}));

// --- payload minimization / batching ---

test('payload minimization: no VIN, notes, costs, minimum price, ids, or tenant metadata reaches the provider', withKey(async () => {
  const db = makeDb();
  for (let i = 0; i < 40; i += 1) addUnit(db, 99); // push real unit ids well away from the v1/v2 refs
  const a = addUnit(db, 7, { notes: SECRET_NOTE });
  const b = addUnit(db, 7, { make: 'Ford', model: 'F-150', notes: SECRET_NOTE });
  assert.ok(a > 2 && b > 2, 'sanity: ids differ from ref indexes');
  const provider = fakeProvider();

  await runBulkSuggestions({
    db, dealershipId: 7, body: { unit_ids: [a, b], include_existing: true }, generate: generateWith(provider.requestOverride), cache: createCache(),
  });
  assert.equal(provider.calls.length, 1);
  const sent = JSON.stringify(provider.calls[0]);
  for (const secret of [SECRET_VIN, 'SECRETVIN', String(SECRET_MIN), String(SECRET_COST), SECRET_NOTE, '"dealership_id"', 'minimum_price', 'acquisition_cost', 'vin']) {
    assert.ok(!sent.includes(secret), `provider payload must not contain ${secret}`);
  }
  assert.ok(sent.includes('Honda') && sent.includes('Ford'), 'sanity: the permitted vehicle facts are sent');
  assert.deepEqual([...provider.calls[0].input.matchAll(/"ref":"(v\d+)"/g)].map(m => m[1]), ['v1', 'v2'], 'only opaque per-request refs identify units');
  assert.ok(!sent.includes(`"${a}"`) && !sent.includes(`"${b}"`) && !sent.includes(`:${a},`) && !sent.includes(`:${b},`), 'database ids are not sent in any form');
  assert.ok(!/"id"\s*:/.test(provider.calls[0].input), 'no id field is sent');
}));

test('one-call batching: ten units produce exactly one provider call', withKey(async () => {
  const db = makeDb();
  const ids = Array.from({ length: 10 }, (_, i) => addUnit(db, 1, { model: `Model${i}` }));
  const provider = fakeProvider();
  const result = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: ids }, generate: generateWith(provider.requestOverride), cache: createCache() });
  assert.equal(provider.calls.length, 1);
  assert.equal(result.units.filter(u => u.status === 'suggested').length, 10);
}));

// --- variants and caps ---

test('variant behavior: standard and facebook use different length rules, and a shorter output cap', withKey(async () => {
  const db = makeDb();
  const id = addUnit(db, 1);
  const standard = fakeProvider();
  const facebook = fakeProvider();
  await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id], variant: 'standard' }, generate: generateWith(standard.requestOverride), cache: createCache() });
  await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id], variant: 'facebook' }, generate: generateWith(facebook.requestOverride), cache: createCache() });
  assert.match(standard.calls[0].input, /Length: 55 to 90 words\./);
  assert.match(facebook.calls[0].input, /Length: 20 to 40 words/);
  assert.match(facebook.calls[0].input, /Facebook/);
  assert.ok(facebook.calls[0].max_output_tokens < standard.calls[0].max_output_tokens);
  assert.ok(VARIANTS.facebook.maxChars < VARIANTS.standard.maxChars);
}));

test('output lengths are capped per variant, and control characters and surrounding quotes are removed', withKey(async () => {
  const db = makeDb();
  const id = addUnit(db, 1);
  const long = ('This is a sentence about the vehicle. ').repeat(60);
  const mk = text => fakeProvider({ transform: items => items.map(i => ({ ...i, description: text })) });

  const standard = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id], variant: 'standard' }, generate: generateWith(mk(long).requestOverride), cache: createCache() });
  const facebook = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id], variant: 'facebook' }, generate: generateWith(mk(long).requestOverride), cache: createCache() });
  assert.ok(standard.units[0].suggestion.length <= VARIANTS.standard.maxChars);
  assert.ok(facebook.units[0].suggestion.length <= VARIANTS.facebook.maxChars);
  assert.ok(facebook.units[0].suggestion.length > 50, 'truncation keeps a useful amount of text');

  const messy = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id] }, generate: generateWith(mk('"Clean car\u0000 here."').requestOverride), cache: createCache() });
  assert.equal(messy.units[0].suggestion, 'Clean car here.');
}));

// --- cache ---

test('stale-cache prevention: any change to a permitted fact, the variant, or the dealership is a cache miss', withKey(async () => {
  const db = makeDb();
  const id = addUnit(db, 1);
  const twin = addUnit(db, 2); // identical facts, different dealership
  const cache = createCache();
  const provider = fakeProvider();
  const run = (dealershipId, unitId, variant = 'standard') => runBulkSuggestions({
    db, dealershipId, body: { unit_ids: [unitId], variant }, generate: generateWith(provider.requestOverride), cache,
  });

  const first = await run(1, id);
  const second = await run(1, id);
  assert.equal(provider.calls.length, 1, 'identical facts, variant and dealership are served from cache');
  assert.equal(second.units[0].cached, true);
  assert.equal(second.units[0].suggestion, first.units[0].suggestion);

  db.prepare('UPDATE units SET asking_price = ? WHERE id = ?').run(14500, id);
  await run(1, id);
  assert.equal(provider.calls.length, 2, 'an edited price must not be served a stale suggestion');

  db.prepare('UPDATE units SET mileage = ? WHERE id = ?').run(52000, id);
  await run(1, id);
  assert.equal(provider.calls.length, 3, 'an edited mileage must not be served a stale suggestion');

  await run(1, id, 'facebook');
  assert.equal(provider.calls.length, 4, 'a different variant is a different cache entry');

  await run(2, twin);
  assert.equal(provider.calls.length, 5, 'another dealership with identical facts never shares an entry');

  // Facts the provider never sees do not invalidate the cache.
  db.prepare('UPDATE units SET minimum_price = 1, acquisition_cost = 2, vin = ? WHERE id = ?').run('CHANGEDVIN00000001', id);
  const afterPrivate = await run(1, id, 'facebook');
  assert.equal(provider.calls.length, 5);
  assert.equal(afterPrivate.units[0].cached, true);
}));

test('cache entries expire, and only successful suggestions are ever cached', withKey(async () => {
  const db = makeDb();
  const id = addUnit(db, 1);
  const cache = createCache();
  const provider = fakeProvider();
  const gen = generateWith(provider.requestOverride);
  let clock = 1_000_000;
  const run = () => runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id] }, generate: gen, cache, now: () => clock });

  await run();
  clock += 60 * 1000;
  await run();
  assert.equal(provider.calls.length, 1, 'still fresh after a minute');
  clock += 10 * 60 * 1000;
  await run();
  assert.equal(provider.calls.length, 2, 'expired entries are regenerated');

  const failingCache = createCache();
  await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id] }, generate: async () => { throw new Error('boom'); }, cache: failingCache });
  assert.equal(failingCache.size, 0, 'a failed call caches nothing');
}));

// --- failure handling ---

test('failed or malformed provider responses fall back cleanly without throwing', withKey(async () => {
  const db = makeDb();
  const ids = [addUnit(db, 1), addUnit(db, 1, { model: 'Civic' })];
  const run = override => runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: ids }, generate: generateWith(override), cache: createCache() });

  const notJson = await run(async () => ({ output_text: 'Sorry, I cannot help with that.' }));
  assert.equal(notJson.ai_unavailable, true);
  assert.equal(notJson.reason, 'unavailable');
  assert.ok(notJson.message);
  assert.deepEqual(notJson.units.map(u => u.status), ['unavailable', 'unavailable']);
  assert.ok(notJson.units.every(u => Array.isArray(u.warnings)), 'warnings are still returned');

  const notArray = await run(async () => ({ output_text: '{"ref":"v1","description":"x"}' }));
  assert.equal(notArray.ai_unavailable, true);

  const providerError = await run(async () => { throw new Error('upstream 500'); });
  assert.equal(providerError.ai_unavailable, true);
  assert.equal(providerError.reason, 'unavailable');

  const fenced = await run(async () => ({ output_text: '```json\n[{"ref":"v1","description":"Fenced one."},{"ref":"v2","description":"Fenced two."}]\n```' }));
  assert.deepEqual(fenced.units.map(u => u.suggestion), ['Fenced one.', 'Fenced two.']);

  const partial = await run(async () => ({ output_text: JSON.stringify([{ ref: 'v1', description: 'Only the first.' }, { ref: 'v2', description: '   ' }]) }));
  assert.deepEqual(partial.units.map(u => u.status), ['suggested', 'failed']);
  assert.equal(partial.ai_unavailable, false);
}));

test('ID tampering: refs that were not requested, duplicates, and wrong types are ignored', () => {
  const parsed = [
    { ref: 'v1', description: 'Real one.' },
    { ref: 'v1', description: 'Duplicate must lose.' },
    { ref: 'v9', description: 'Not requested.' },
    { ref: 'v0', description: 'Not requested.' },
    { ref: 'v-1', description: 'Not requested.' },
    { ref: 'unit:3', description: 'Not requested.' },
    { ref: 2, description: 'Wrong type.' },
    { ref: 'v2', description: { toString: 'object' } },
    null,
    'string',
  ];
  assert.deepEqual(validateBatch(parsed, 2, 700), ['Real one.', null]);
  assert.throws(() => validateBatch({ ref: 'v1' }, 2, 700), /JSON array/);
});

test('through the full path, a response naming unrequested refs cannot add units or change ids', withKey(async () => {
  const db = makeDb();
  const id = addUnit(db, 1);
  const provider = fakeProvider({ transform: items => [...items, { ref: 'v77', description: 'Injected.' }, { ref: String(id), description: 'Real db id guess.' }] });
  const result = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id] }, generate: generateWith(provider.requestOverride), cache: createCache() });
  assert.deepEqual(result.units.map(u => u.id), [id]);
  assert.equal(result.units[0].suggestion, 'Suggestion for v1.');
}));

// --- no key ---

test('without an API key: warnings and a clear not-configured message are returned, with no provider call possible', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const db = makeDb();
    const incomplete = addUnit(db, 1, { asking_price: null, mileage: 0, photos: '[]' });
    const result = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [incomplete] }, cache: createCache() });
    assert.equal(result.ai_unavailable, true);
    assert.equal(result.reason, 'not_configured');
    assert.match(result.message, /not configured/i);
    assert.equal(result.units[0].status, 'unavailable');
    assert.deepEqual(result.units[0].warnings.map(w => w.field), ['asking_price', 'mileage', 'photos']);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

// --- warnings are non-blocking ---

test('missing price, mileage, photos, year, make or model only warns: the unit still gets a suggestion', withKey(async () => {
  const db = makeDb();
  const id = addUnit(db, 1, { asking_price: null, mileage: null, photos: '[]', year: null, make: null, model: null });
  const provider = fakeProvider();
  const result = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id] }, generate: generateWith(provider.requestOverride), cache: createCache() });
  assert.equal(result.units[0].status, 'suggested');
  assert.deepEqual(result.units[0].warnings.map(w => w.field).sort(), ['asking_price', 'make', 'mileage', 'model', 'photos', 'year']);
  assert.equal(provider.calls.length, 1);
}));

// --- no writes, existing descriptions ---

test('generation never writes: the units table is byte-identical before and after, including with include_existing', withKey(async () => {
  const db = makeDb();
  const ids = [addUnit(db, 1), addUnit(db, 1, { notes: 'Dealer wrote this by hand.' })];
  addUnit(db, 2);
  const before = snapshot(db);
  const provider = fakeProvider();
  for (const include of [false, true]) {
    await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: ids, include_existing: include }, generate: generateWith(provider.requestOverride), cache: createCache() });
  }
  assert.equal(snapshot(db), before);
}));

test('existing descriptions are identified, skipped by default (not even sent), and only included on explicit opt-in', withKey(async () => {
  const db = makeDb();
  const bare = addUnit(db, 1, { model: 'Bare' });
  const written = addUnit(db, 1, { model: 'Written', notes: '  Hand-written description.  ' });
  const provider = fakeProvider();

  const byDefault = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [bare, written] }, generate: generateWith(provider.requestOverride), cache: createCache() });
  const skipped = byDefault.units.find(u => u.id === written);
  assert.equal(skipped.status, 'skipped_existing');
  assert.equal(skipped.has_description, true);
  assert.equal(skipped.current_description, 'Hand-written description.');
  assert.equal(skipped.suggestion, undefined);
  assert.equal(byDefault.units.find(u => u.id === bare).has_description, false);
  assert.ok(!provider.calls[0].input.includes('Written'), 'a unit that already has a description is not sent to the provider by default');

  const optedIn = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [bare, written], include_existing: true }, generate: generateWith(provider.requestOverride), cache: createCache() });
  const replaced = optedIn.units.find(u => u.id === written);
  assert.equal(replaced.status, 'suggested');
  assert.equal(replaced.has_description, true);
  assert.equal(replaced.current_description, 'Hand-written description.', 'the current text is still shown next to the suggestion');
  assert.equal(db.prepare('SELECT notes FROM units WHERE id = ?').get(written).notes, '  Hand-written description.  ', 'and is never overwritten');
}));

test('when every selected unit already has a description, no provider call is made at all', withKey(async () => {
  const db = makeDb();
  const id = addUnit(db, 1, { notes: 'Already written.' });
  let called = 0;
  const result = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id] }, generate: async () => { called += 1; return []; }, cache: createCache() });
  assert.equal(called, 0);
  assert.equal(result.ai_unavailable, false);
}));

// --- single-vehicle compatibility (service level) ---

test('the standard single-vehicle prompt is unchanged, word for word', () => {
  const unit = { year: 2020, make: 'Honda', model: 'Accord', trim: 'EX', body_style: 'Sedan', color: 'Blue', mileage: 41000, asking_price: 15995, vin: SECRET_VIN };
  const original = [
    'Write a short used-car listing description for a dealership.',
    'Style: catchy, confident, plain-spoken, and sales-friendly. Keep it punchy, not too wordy.',
    'Length: 55 to 90 words.',
    'Only use facts provided. Do not invent condition, accident history, title status, ownership history, warranty, service records, financing, discounts, or availability.',
    'Do not include contact information, phone numbers, email, address, hashtags, emoji, or generic obvious features like seatbelts.',
    'Focus on useful differentiators from trim, body style, mileage, color, and price when available.',
    'Return only the description text.',
    '',
    `Vehicle facts: ${JSON.stringify({ year: '2020', make: 'Honda', model: 'Accord', trim: 'EX', body_style: 'Sedan', color: 'Blue', mileage: '41,000 miles', price: '$15,995' })}`,
  ].join('\n');
  assert.equal(promptFor(unit), original);
  assert.equal(promptFor(unit, 'standard'), original);
  assert.notEqual(promptFor(unit, 'facebook'), original);
  assert.ok(!batchPrompt([unit], 'standard').includes(SECRET_VIN));
});

// --- in-flight request coalescing ---

// A provider that does not answer until released, so tests can start several
// requests while the first call is still outstanding.
function gatedProvider({ fail = false } = {}) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const requestOverride = async (_options, body) => {
    calls.push(body);
    const callNumber = calls.length;
    await gate;
    if (fail) throw new Error('upstream failure');
    const refs = [...body.input.matchAll(/"ref":"(v\d+)"/g)].map(m => m[1]);
    return { output_text: JSON.stringify(refs.map(ref => ({ ref, description: `Result for ${ref} from call ${callNumber}.` }))) };
  };
  return { calls, release, requestOverride };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const vehiclesIn = call => (call.input.match(/"ref":"v\d+"/g) || []).length;

test('simultaneous identical requests make exactly one provider call and share one result', withKey(async () => {
  const db = makeDb();
  const id = addUnit(db, 1);
  const cache = createCache();
  const inflight = createInflight();
  const provider = gatedProvider();
  const run = () => runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id] }, generate: generateWith(provider.requestOverride), cache, inflight });

  const first = run();
  const second = run();
  const third = run();
  assert.equal(inflight.size, 1, 'one in-flight entry for the shared key');
  await tick();
  assert.equal(provider.calls.length, 1, 'still just one provider call while all three wait');

  provider.release();
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.equal(provider.calls.length, 1);
  assert.equal(a.units[0].status, 'suggested');
  assert.equal(a.units[0].suggestion, 'Result for v1 from call 1.');
  assert.deepEqual(b, a, 'both callers receive the same successful result');
  assert.deepEqual(c, a);
  assert.equal(inflight.size, 0, 'the in-flight entry is removed on success');
  assert.equal(cache.size, 1, 'and the result is now in the completed-response cache');

  const later = await run();
  assert.equal(provider.calls.length, 1, 'a later identical request is a cache hit, not a new call');
  assert.equal(later.units[0].cached, true);
}));

test('a failed provider call fails every waiter, clears the in-flight entry, caches nothing, and a retry calls the provider again', withKey(async () => {
  const db = makeDb();
  const id = addUnit(db, 1);
  const cache = createCache();
  const inflight = createInflight();
  const failing = gatedProvider({ fail: true });
  const runWith = provider => runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [id] }, generate: generateWith(provider.requestOverride), cache, inflight });

  const first = runWith(failing);
  const second = runWith(failing);
  await tick();
  assert.equal(failing.calls.length, 1, 'the two waiters share the one failing call');
  failing.release();
  const [a, b] = await Promise.all([first, second]);
  for (const result of [a, b]) {
    assert.equal(result.ai_unavailable, true);
    assert.equal(result.reason, 'unavailable');
    assert.equal(result.units[0].status, 'unavailable');
  }
  assert.equal(inflight.size, 0, 'the in-flight entry is removed on failure');
  assert.equal(cache.size, 0, 'failures are never cached');

  const working = gatedProvider();
  working.release();
  const retry = await runWith(working);
  assert.equal(working.calls.length, 1, 'the retry reaches the provider again');
  assert.equal(retry.units[0].status, 'suggested');
  assert.equal(inflight.size, 0);
  assert.equal(cache.size, 1);
}));

test('a provider that throws synchronously also clears the in-flight entry', withKey(async () => {
  const db = makeDb();
  const id = addUnit(db, 1);
  const inflight = createInflight();
  const result = await runBulkSuggestions({
    db, dealershipId: 1, body: { unit_ids: [id] }, generate: () => { throw new Error('sync boom'); }, cache: createCache(), inflight,
  });
  assert.equal(result.ai_unavailable, true);
  assert.equal(inflight.size, 0);
}));

test('requests with different facts, variants, or dealerships never coalesce', withKey(async () => {
  const db = makeDb();
  const accord = addUnit(db, 1, { model: 'Accord' });
  const civic = addUnit(db, 1, { model: 'Civic' });
  const twinOfAccord = addUnit(db, 2, { model: 'Accord' }); // identical facts, other dealership
  const cache = createCache();
  const inflight = createInflight();

  const scenario = async (label, requests, expectedCalls) => {
    const provider = gatedProvider();
    const pending = requests.map(({ dealershipId, unitId, variant = 'standard' }) => runBulkSuggestions({
      db, dealershipId, body: { unit_ids: [unitId], variant }, generate: generateWith(provider.requestOverride), cache, inflight,
    }));
    await tick();
    assert.equal(provider.calls.length, expectedCalls, label);
    provider.release();
    await Promise.all(pending);
    cache.clear();
  };

  await scenario('different vehicle facts', [{ dealershipId: 1, unitId: accord }, { dealershipId: 1, unitId: civic }], 2);
  await scenario('different variants of the same unit', [{ dealershipId: 1, unitId: accord, variant: 'standard' }, { dealershipId: 1, unitId: accord, variant: 'facebook' }], 2);
  await scenario('identical facts in different dealerships', [{ dealershipId: 1, unitId: accord }, { dealershipId: 2, unitId: twinOfAccord }], 2);
  await scenario('the same unit and variant', [{ dealershipId: 1, unitId: accord }, { dealershipId: 1, unitId: accord }], 1);

  // A fact edited while a call is in flight changes the fingerprint, so the
  // newer request does not join the older one.
  const provider = gatedProvider();
  const before = runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [accord] }, generate: generateWith(provider.requestOverride), cache, inflight });
  db.prepare('UPDATE units SET asking_price = ? WHERE id = ?').run(13999, accord);
  const after = runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [accord] }, generate: generateWith(provider.requestOverride), cache, inflight });
  await tick();
  assert.equal(provider.calls.length, 2, 'an edited price must not join the request that used the old price');
  provider.release();
  await Promise.all([before, after]);
  assert.equal(inflight.size, 0);
}));

test('overlapping requests share the units they have in common and only send the rest', withKey(async () => {
  const db = makeDb();
  const u1 = addUnit(db, 1, { model: 'One' });
  const u2 = addUnit(db, 1, { model: 'Two' });
  const u3 = addUnit(db, 1, { model: 'Three' });
  const cache = createCache();
  const inflight = createInflight();
  const provider = gatedProvider();
  const run = ids => runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: ids }, generate: generateWith(provider.requestOverride), cache, inflight });

  const a = run([u1, u2]);
  const b = run([u2, u3]);
  await tick();
  assert.equal(provider.calls.length, 2, 'one call per request at most');
  assert.deepEqual(provider.calls.map(vehiclesIn), [2, 1], 'the second request sends only the unit nobody else is already fetching');
  assert.ok(provider.calls[1].input.includes('Three') && !provider.calls[1].input.includes('Two'));

  provider.release();
  const [ra, rb] = await Promise.all([a, b]);
  const shared = id => [ra, rb].map(r => r.units.find(u => u.id === id).suggestion);
  assert.equal(shared(u2)[0], shared(u2)[1], 'the shared unit gets the same text in both responses');
  assert.ok(ra.units.every(u => u.status === 'suggested') && rb.units.every(u => u.status === 'suggested'));
  assert.equal(inflight.size, 0);
}));

test('units with identical facts inside one request are sent once and share the suggestion', withKey(async () => {
  const db = makeDb();
  const twinA = addUnit(db, 1, { model: 'Accord' });
  const twinB = addUnit(db, 1, { model: 'Accord' });
  const provider = gatedProvider();
  provider.release();
  const result = await runBulkSuggestions({ db, dealershipId: 1, body: { unit_ids: [twinA, twinB] }, generate: generateWith(provider.requestOverride), cache: createCache(), inflight: createInflight() });
  assert.equal(provider.calls.length, 1);
  assert.equal(vehiclesIn(provider.calls[0]), 1);
  assert.equal(result.units[0].suggestion, result.units[1].suggestion);
  assert.deepEqual(result.units.map(u => u.id), [twinA, twinB]);
}));
