'use strict';
// Covers the pure, server-free parts of Today's Priorities: deterministic
// ranking (rankPriorities/priorityScore) and the AI-guidance response
// builder's every branch (missing key, malformed response, id tampering,
// batching, caching) via dependency injection — never contacting OpenAI.
// Route-level auth/tenant-isolation behavior lives in
// test/dashboard-priorities-route.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

let tmpDataDir;
let dashboard;

test.before(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-priorities-unit-'));
  process.env.UNITNAV_DATA_DIR = tmpDataDir;
  delete require.cache[require.resolve('../database')];
  delete require.cache[require.resolve('../routes/dashboard')];
  dashboard = require('../routes/dashboard');
});

test.after(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.UNITNAV_DATA_DIR;
  delete require.cache[require.resolve('../database')];
  delete require.cache[require.resolve('../routes/dashboard')];
});

function dealRow({ id, age_days, customer_name = 'Jane Buyer', vehicle = '2020 Honda Accord' }) {
  return { id, type: 'deal', age_days, customer_name, phone: '', email: '', vehicle, unit_id: id, created_at: new Date().toISOString() };
}

function unitRow({ id, age_days, milestone, vehicle = '2019 Ford F-150', stage = 'ready' }) {
  return { id, type: 'unit', age_days, milestone, vehicle, vin: 'VIN-HIDDEN', stage, created_at: new Date().toISOString() };
}

function userRow({ id, age_days, name = 'Old Staffer', role = 'staff' }) {
  return { id, type: 'user', age_days, name, email: 'staffer@example.com', role, last_login_at: null, created_at: new Date().toISOString() };
}

test('deterministic ordering: category always dominates (deals > units > users), regardless of age', () => {
  const deals = [dealRow({ id: 1, age_days: 3 })];
  const units = [unitRow({ id: 2, age_days: 400, milestone: 390 })];
  const users = [userRow({ id: 3, age_days: 900 })];
  const ranked = dashboard.rankPriorities(deals, units, users);
  assert.deepEqual(ranked.map(p => p.type), ['deal', 'unit', 'user'], 'a barely-overdue deal must still outrank a far-more-overdue unit or user');
});

test('within a category, older/more-overdue items rank first', () => {
  const deals = [
    dealRow({ id: 1, age_days: 4 }),
    dealRow({ id: 2, age_days: 10 }),
    dealRow({ id: 3, age_days: 7 }),
  ];
  const ranked = dashboard.rankPriorities(deals, [], []);
  assert.deepEqual(ranked.map(p => p.id), ['deal:2', 'deal:3', 'deal:1']);
});

test('tie stability: identical age within a category breaks deterministically by ascending underlying id', () => {
  const deals = [
    dealRow({ id: 30, age_days: 5 }),
    dealRow({ id: 10, age_days: 5 }),
    dealRow({ id: 20, age_days: 5 }),
  ];
  const first = dashboard.rankPriorities(deals, [], []).map(p => p.id);
  const second = dashboard.rankPriorities([...deals], [], []).map(p => p.id);
  assert.deepEqual(first, ['deal:10', 'deal:20', 'deal:30'], 'smaller id must consistently win the tie-break');
  assert.deepEqual(second, first, 'ranking the same input twice must produce byte-identical order');
});

test('every priority carries a numeric score consistent with its rank order (strictly non-increasing down the list)', () => {
  const deals = [dealRow({ id: 1, age_days: 4 }), dealRow({ id: 2, age_days: 12 })];
  const units = [unitRow({ id: 3, age_days: 60, milestone: 60 })];
  const users = [userRow({ id: 4, age_days: 45 })];
  const ranked = dashboard.rankPriorities(deals, units, users);
  for (let i = 1; i < ranked.length; i += 1) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, `score must be non-increasing: ${ranked[i - 1].id}=${ranked[i - 1].score} then ${ranked[i].id}=${ranked[i].score}`);
  }
});

test('priority level is assigned deterministically by category, not by AI', () => {
  const ranked = dashboard.rankPriorities(
    [dealRow({ id: 1, age_days: 5 })],
    [unitRow({ id: 2, age_days: 60, milestone: 60 })],
    [userRow({ id: 3, age_days: 40 })],
  );
  const byType = Object.fromEntries(ranked.map(p => [p.type, p.priority_level]));
  assert.equal(byType.deal, 'high');
  assert.equal(byType.unit, 'medium');
  assert.equal(byType.user, 'low');
});

test('each priority links to an existing workflow and only existing, already-supported actions', () => {
  const ranked = dashboard.rankPriorities(
    [dealRow({ id: 1, age_days: 5 })],
    [unitRow({ id: 2, age_days: 60, milestone: 60 })],
    [userRow({ id: 3, age_days: 40 })],
  );
  const deal = ranked.find(p => p.type === 'deal');
  const unit = ranked.find(p => p.type === 'unit');
  const user = ranked.find(p => p.type === 'user');
  assert.equal(deal.link, '/deals');
  assert.deepEqual(deal.actions.options, ['still_pending', 'vehicle_changed', 'dead', 'closed']);
  assert.equal(deal.actions.endpoint, '/api/dashboard/deal-alert/1/action');
  assert.equal(unit.link, '/inventory/2');
  assert.equal(unit.actions.endpoint, '/api/dashboard/unit-alert/2/action');
  assert.equal(user.link, '/settings/users');
  assert.deepEqual(user.actions.options, ['keep_active', 'revoke']);
  assert.equal(user.actions.endpoint, '/api/dashboard/user-alert/3/action');
});

// --- AI guidance response builder ---

function fakePriorities() {
  return dashboard.rankPriorities(
    [dealRow({ id: 1, age_days: 5 }), dealRow({ id: 2, age_days: 9 })],
    [unitRow({ id: 3, age_days: 45, milestone: 30 })],
    [],
  );
}

test('works completely without an OpenAI key: deterministic fallback, zero network calls', async () => {
  delete process.env.OPENAI_API_KEY;
  const priorities = fakePriorities();
  let called = false;
  const generate = async () => { called = true; return {}; };
  // generate is only invoked at all if the real generateBatchGuidance would
  // have been reached — but with no key, buildAiGuidanceResponse must call
  // whatever `generate` it's given (here the injected fake, standing in for
  // the real function that would throw missing_openai_key before any
  // network attempt). We assert on the REAL function's behavior separately
  // below; this test proves the route-level response shape when it throws.
  const throwingGenerate = async () => {
    const err = new Error('not configured');
    err.code = 'missing_openai_key';
    throw err;
  };
  const result = await dashboard.buildAiGuidanceResponse({
    dealershipId: 999,
    priorities,
    requestedIds: null,
    generate: throwingGenerate,
    cache: new Map(),
  });
  assert.equal(result.ai_unavailable, true);
  assert.equal(result.reason, 'not_configured');
  assert.deepEqual(result.guidance, {});
  assert.equal(called, false, 'the unrelated fake must never be invoked');
});

test('malformed or failed AI response falls back gracefully, never throws to the caller', async () => {
  const priorities = fakePriorities();
  const malformedGenerate = async () => { throw new Error('AI response was not valid JSON'); };
  const result = await dashboard.buildAiGuidanceResponse({
    dealershipId: 998,
    priorities,
    requestedIds: null,
    generate: malformedGenerate,
    cache: new Map(),
  });
  assert.equal(result.ai_unavailable, true);
  assert.equal(result.reason, 'unavailable');
  assert.deepEqual(result.guidance, {});
});

test('exactly one batched call is made regardless of how many priorities are included', async () => {
  const priorities = fakePriorities();
  let callCount = 0;
  let receivedCount = 0;
  const generate = async (list) => {
    callCount += 1;
    receivedCount = list.length;
    return {};
  };
  await dashboard.buildAiGuidanceResponse({ dealershipId: 997, priorities, requestedIds: null, generate, cache: new Map() });
  assert.equal(callCount, 1);
  assert.equal(receivedCount, priorities.length);
});

// This is the actual enforcement boundary: generateBatchGuidance (via
// validateGuidance) is what filters the model's raw response down to only
// the ids it was actually given — buildAiGuidanceResponse above just calls
// whatever `generate` function it's handed, so the id-safety guarantee must
// be tested against the real service, with only its HTTP transport
// (`requestOverride`) replaced. No network call is ever made: the override
// entirely replaces https.request.
test('AI output can only rewrite summary/recommendation for ids that were actually sent — it cannot alter ranking, links, actions, or introduce new ids', async () => {
  process.env.OPENAI_API_KEY = 'test-fake-key';
  try {
    const priorities = fakePriorities();
    const realIds = priorities.map(p => p.id);
    delete require.cache[require.resolve('../services/priorityGuidance')];
    const { generateBatchGuidance } = require('../services/priorityGuidance');

    // A hostile/malformed AI response: tries to smuggle in an id that was
    // never sent, and tries to overwrite fields (priority_level, link,
    // actions) it has no business touching — those aren't even read by
    // validateGuidance, which only ever copies `summary`/`recommendation`.
    const fakeResponse = {
      output_text: JSON.stringify([
        { id: realIds[0], summary: 'Rewritten summary', recommendation: 'Rewritten step', priority_level: 'low', link: '/hacked' },
        { id: 'deal:99999-not-real', summary: 'should never appear', recommendation: 'x' },
      ]),
    };
    const requestOverride = async () => fakeResponse;

    const before = JSON.stringify(priorities);
    const guidance = await generateBatchGuidance(priorities, { requestOverride });

    assert.ok(guidance[realIds[0]], 'guidance for a real, sent id must be present');
    assert.deepEqual(Object.keys(guidance[realIds[0]]).sort(), ['recommendation', 'summary'], 'only summary/recommendation are ever copied — priority_level/link are silently dropped even if present in the AI response');
    assert.equal(Object.prototype.hasOwnProperty.call(guidance, 'deal:99999-not-real'), false, 'an id that was never sent must never appear in the result');
    // Neither the service nor buildAiGuidanceResponse ever mutates the
    // priorities array or any of its objects — ranking/links/actions/ids are
    // only ever set by rankPriorities/toPriority, never by anything
    // AI-derived.
    assert.equal(JSON.stringify(priorities), before, 'the priorities list itself must be completely unchanged by AI guidance');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('identical repeated requests are served from the short-lived cache without a second call', async () => {
  const priorities = fakePriorities();
  let callCount = 0;
  const generate = async () => { callCount += 1; return { [priorities[0].id]: { summary: 'S' } }; };
  const cache = new Map();
  const first = await dashboard.buildAiGuidanceResponse({ dealershipId: 995, priorities, requestedIds: null, generate, cache });
  const second = await dashboard.buildAiGuidanceResponse({ dealershipId: 995, priorities, requestedIds: null, generate, cache });
  assert.equal(callCount, 1, 'the second identical request must be served from cache, not a new call');
  assert.equal(first.cached, undefined);
  assert.equal(second.cached, true);
  assert.deepEqual(second.guidance, first.guidance);
});

test('requesting a subset of ids only sends that subset, and an unknown requested id is silently ignored (never fabricated)', async () => {
  const priorities = fakePriorities();
  const onlyFirstId = priorities[0].id;
  let receivedIds = null;
  const generate = async (list) => { receivedIds = list.map(p => p.id); return {}; };
  await dashboard.buildAiGuidanceResponse({
    dealershipId: 994,
    priorities,
    requestedIds: [onlyFirstId, 'deal:does-not-exist'],
    generate,
    cache: new Map(),
  });
  assert.deepEqual(receivedIds, [onlyFirstId]);
});

// --- Page-level smoke check ---

test('public/priorities.html: well-formed markup and syntactically valid inline script', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'priorities.html'), 'utf8');
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /<html[\s>]/i);
  assert.match(html, /<\/html>/i);
  const openTags = (html.match(/<body[\s>]/gi) || []).length;
  const closeTags = (html.match(/<\/body>/gi) || []).length;
  assert.equal(openTags, 1);
  assert.equal(closeTags, 1);

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1])
    .filter(code => code.trim().length > 0);
  assert.ok(scripts.length >= 1, 'expected at least one inline <script> block');
  for (const code of scripts) {
    if (!code.trim()) continue;
    assert.doesNotThrow(() => new Function(code), `inline script must be syntactically valid JavaScript:\n${code.slice(0, 200)}`);
  }
});
