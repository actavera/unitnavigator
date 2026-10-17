#!/usr/bin/env node
'use strict';
// Controlled live-provider validation for AI Follow-Up Drafts.
//
// Runs the real server code in throwaway data directories with temporary demo
// dealerships and SYNTHETIC deals (sentinel names, contact details, a fake VIN,
// fake prices). It makes only a handful of tiny provider requests and deletes
// everything it created. Nothing is sent to any customer.
//
//   node live-followup-validation.js [--repo <app dir>] [--key-from-pm2] [--stub-provider]
//
//   --repo <dir>      the Unit Navigator checkout to test (default: this file's parent)
//   --key-from-pm2    read OPENAI_API_KEY (and OPENAI_DESCRIPTION_MODEL) from the
//                     `unitnavigator` process in the CURRENT user's PM2 (root on the
//                     droplet). The key stays in memory, goes only to the servers that
//                     need it, and is never printed or written to disk.
//   --stub-provider   rehearse the whole flow against a fake provider; no key needed.
//
// Four test servers are started: one with the real key (the main checks), one
// with a deliberately invalid key (a real provider rejection), one with a 1 ms
// provider timeout, and one with no key. The real key is never removed or altered.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const STUB = flag('--stub-provider');
const repo = path.resolve(option('--repo') || path.join(__dirname, '..'));

function fatal(message) {
  console.error(`[followup-validation] ${message}`);
  process.exit(2);
}

if (!fs.existsSync(path.join(repo, 'server.js'))) fatal(`${repo} does not look like a Unit Navigator checkout (no server.js).`);
if (!fs.existsSync(path.join(repo, 'services', 'followUpDraft.js'))) fatal(`${repo} does not contain AI Follow-Up Drafts yet (services/followUpDraft.js is missing). Update that checkout first.`);
const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));

let apiKey = STUB ? 'stub-key-not-a-real-key' : process.env.OPENAI_API_KEY;
let model = process.env.OPENAI_DESCRIPTION_MODEL;
if (!apiKey && flag('--key-from-pm2')) {
  try {
    const raw = execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const list = JSON.parse(raw.slice(raw.indexOf('[{')));
    const env = (list.find(p => p.name === 'unitnavigator') || {}).pm2_env || {};
    apiKey = env.OPENAI_API_KEY;
    model = model || env.OPENAI_DESCRIPTION_MODEL;
  } catch {
    fatal('Could not read the unitnavigator process from PM2. Run this as the account that owns it (root on the droplet).');
  }
}
if (!apiKey) fatal('OPENAI_API_KEY is not available. Provide it in the environment, use --key-from-pm2, or rehearse with --stub-provider.');
console.log(`[followup-validation] OPENAI_API_KEY: set (${STUB ? 'stub; no real provider is contacted' : 'real; value not shown'})`);
console.log(`[followup-validation] app under test: ${repo}`);

// Preload injected into every test server. It records each provider request
// body (never headers, so never the key) and every outbound host, and in stub
// mode answers instead of the provider.
const PRELOAD = `
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const logFile = process.env.LIVE_VALIDATION_LOG;
const stub = process.env.LIVE_VALIDATION_STUB === '1';
const log = entry => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + '\\n'); };

const originalHttpsRequest = https.request;
const originalHttpRequest = http.request;
const originalFetch = globalThis.fetch;
const hostOf = options => (typeof options === 'string' ? new URL(options).hostname : (options && (options.hostname || options.host)) || '');

http.request = function (options) { log({ kind: 'outbound', host: hostOf(options), via: 'http' }); return originalHttpRequest.apply(this, arguments); };
if (originalFetch) globalThis.fetch = function (input) { log({ kind: 'outbound', host: (() => { try { return new URL(typeof input === 'string' ? input : input.url).hostname; } catch { return ''; } })(), via: 'fetch' }); return originalFetch.apply(this, arguments); };

function stubAnswer(input) {
  const facts = JSON.parse((input.match(/^Facts: (.*)$/m) || [])[1] || '{}');
  const email = facts.channel === 'email';
  const vehicle = facts.vehicle ? 'the ' + facts.vehicle : 'your search';
  return email
    ? { subject: 'Checking in about ' + (facts.vehicle || 'your search'), body: 'Hi {{customer_first_name}},\\n\\nI wanted to check in about ' + vehicle + '. Let me know if I can answer any questions.\\n\\nBest,\\n{{sender_name}}\\n{{dealership_name}}' }
    : { body: 'Hi {{customer_first_name}}, it is {{sender_name}} at {{dealership_name}} checking in about ' + vehicle + '. Any questions?' };
}

https.request = function (options, callback) {
  const host = hostOf(options);
  if (host !== 'api.openai.com') { log({ kind: 'outbound', host, via: 'https' }); return originalHttpsRequest.apply(this, arguments); }
  const chunks = [];
  const record = () => { log({ kind: 'openai', body: Buffer.concat(chunks).toString() }); };
  if (!stub) {
    const req = originalHttpsRequest.apply(this, arguments);
    const write = req.write.bind(req);
    const end = req.end.bind(req);
    req.write = (d, ...rest) => { chunks.push(Buffer.from(d)); return write(d, ...rest); };
    req.end = (d, ...rest) => { if (d && typeof d !== 'function') chunks.push(Buffer.from(d)); record(); return end(d, ...rest); };
    return req;
  }
  const req = new EventEmitter();
  let timeoutCb = null;
  req.write = d => { chunks.push(Buffer.from(d)); return true; };
  req.setTimeout = (ms, cb) => { if (ms <= 5) timeoutCb = cb; return req; };
  req.destroy = err => { setImmediate(() => req.emit('error', err)); };
  req.end = d => {
    if (d && typeof d !== 'function') chunks.push(Buffer.from(d));
    record();
    if (timeoutCb) return setImmediate(timeoutCb);
    const res = new Readable({ read() {} });
    const invalid = /invalid/i.test(String(options.headers && options.headers.Authorization));
    res.statusCode = invalid ? 401 : 200;
    const payload = invalid ? { error: { message: 'Incorrect API key provided' } } : { output_text: JSON.stringify(stubAnswer(JSON.parse(Buffer.concat(chunks).toString()).input)) };
    res.push(Buffer.from(JSON.stringify(payload)));
    res.push(null);
    setImmediate(() => callback(res));
  };
  return req;
};
`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
  return ok;
};

// Synthetic data only. Every value below must NEVER reach the provider.
const S = {
  first: 'Valfirstone', last: 'Vallastone', phone: '801-555-0917', email: 'valsentinel.one@example.invalid',
  address: '917 Sentinel Avenue', idNumber: 'VALID-917-SENTINEL', employer: 'ValEmployer Sentinel Co', income: '8123.45',
  vin: 'VALVIN00000000917', price: '23987.65', minPrice: '19876.54', cost: '17654.32', notes: 'VAL-NOTES-SENTINEL private note', dealType: 'bhph',
};
const VEHICLE = '2021 Toyota Camry';

const children = [];
let tmp;

function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

async function startServer({ tag, key, timeoutMs }) {
  const dataDir = path.join(tmp, `${tag}-data`);
  const logFile = path.join(tmp, `${tag}.log.jsonl`);
  fs.writeFileSync(logFile, '');
  const port = 7600 + Math.floor(Math.random() * 900);
  // Minimal explicit environment: no server inherits a key it should not have.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
    PORT: String(port), NODE_ENV: 'test', UNITNAV_DATA_DIR: dataDir, JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    NODE_OPTIONS: `--require ${path.join(tmp, 'preload.js')}`, LIVE_VALIDATION_LOG: logFile,
    ...(STUB ? { LIVE_VALIDATION_STUB: '1' } : {}),
    ...(key ? { OPENAI_API_KEY: key, ...(model ? { OPENAI_DESCRIPTION_MODEL: model } : {}) } : {}),
    ...(timeoutMs ? { UNITNAV_PROVIDER_TIMEOUT_MS: String(timeoutMs) } : {}),
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  children.push(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try { await fetch(`${baseUrl}/api/public/dealer`); break; } catch { /* not up yet */ }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`test server (${tag}) did not start: ${stderr.slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 150));
  }
  const api = async (token, method, urlPath, body) => {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  };
  const demo = await api(null, 'POST', '/api/auth/demo-login');
  if (demo.status !== 200) throw new Error(`demo login failed (${demo.status})`);
  const dealershipId = decodeJwt(demo.body.token).dealership_id;

  const db = new Database(path.join(dataDir, 'unitnavigator.db'));
  const deals = {};
  let dealershipName;
  try {
    db.prepare('DELETE FROM deals WHERE dealership_id = ?').run(dealershipId);
    db.prepare('DELETE FROM customers WHERE dealership_id = ?').run(dealershipId);
    dealershipName = db.prepare('SELECT name FROM dealerships WHERE id = ?').get(dealershipId).name;
    const customer = (first, last) => Number(db.prepare(`
      INSERT INTO customers (dealership_id, first_name, last_name, phone, email, address, id_number, employer, monthly_income)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(dealershipId, first, last, S.phone, S.email, S.address, S.idNumber, S.employer, S.income).lastInsertRowid);
    const unit = Number(db.prepare(`
      INSERT INTO units (dealership_id, vin, year, make, model, stage, asking_price, minimum_price, acquisition_cost, notes)
      VALUES (?, ?, 2021, 'Toyota', 'Camry', 'ready', ?, ?, ?, ?)
    `).run(dealershipId, S.vin, S.price, S.minPrice, S.cost, S.notes).lastInsertRowid);
    const deal = (customerId, status, followUp) => Number(db.prepare(`
      INSERT INTO deals (dealership_id, customer_id, unit_id, deal_type, status, next_follow_up_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-5 days'))
    `).run(dealershipId, customerId, unit, S.dealType, status, followUp).lastInsertRowid);
    deals.checkIn = deal(customer(S.first, S.last), 'pending', null);
    deals.overdue = deal(customer('Valfirsttwo', 'Vallasttwo'), 'pending', '2020-01-01');
    deals.closed = deal(customer('Valfirstthree', 'Vallastthree'), 'closed', null);
  } finally {
    db.close();
  }

  const snapshot = () => {
    const handle = new Database(path.join(dataDir, 'unitnavigator.db'), { readonly: true });
    try {
      return JSON.stringify(['dealerships', 'users', 'customers', 'units', 'deals', 'documents', 'activity_logs'].map(t => handle.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
    } finally { handle.close(); }
  };
  const entries = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const providerCalls = () => entries().filter(e => e.kind === 'openai').map(e => JSON.parse(e.body));
  const hosts = () => [...new Set(entries().filter(e => e.kind === 'outbound').map(e => e.host))];
  const draft = (id, body) => api(demo.body.token, 'POST', `/api/deals/${id}/follow-up-draft`, body);
  return { draft, snapshot, providerCalls, hosts, deals, dealershipName, senderName: 'Demo Dealer', token: demo.body.token, api };
}

const FORBIDDEN = [[/https?:\/\/|www\./i, 'a link'], [/[^\s@]+@[^\s@]+\.[^\s@]+/, 'an email address'], [/\+?\d[\d\s().-]{6,}\d/, 'a phone number'], [/[$€£]|%/, 'a price or rate'], [/\b(apr|discount|rebate|guarantee[ds]?)\b/i, 'a promise term']];
const clean = text => FORBIDDEN.every(([re]) => !re.test(text));

async function main() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-followup-live-'));
  fs.writeFileSync(path.join(tmp, 'preload.js'), PRELOAD);
  console.log(`[followup-validation] temporary directory: ${tmp} (removed at the end)`);

  console.log('\n== Server with the real provider key (temporary demo dealership, synthetic deals)');
  const s = await startServer({ tag: 'real', key: apiKey });
  const before = s.snapshot();
  const calls = () => s.providerCalls().length;
  const sentinels = Object.values(S).concat([s.dealershipName, s.senderName]);

  console.log('\nTemplate drafts (no provider call)');
  const tEmail = await s.draft(s.deals.checkIn, { channel: 'email' });
  const tText = await s.draft(s.deals.checkIn, { channel: 'text' });
  check('template email and text both succeed', tEmail.status === 200 && tText.status === 200);
  check('no provider request was made for template drafts', calls() === 0, `${calls()} request(s)`);
  const te = tEmail.body.draft;
  const tt = tText.body.draft;
  check('template email: names filled locally, no leftover placeholders', te.source === 'template' && te.body.includes(S.first) && te.body.includes(s.senderName) && te.body.includes(s.dealershipName) && !/\{\{/.test(te.subject + te.body));
  check('template email within limits (subject <= 90, body <= 900)', te.subject.length <= 90 && te.body.length <= 900, `${te.subject.length} / ${te.body.length}`);
  check('template text within limit (<= 320) with no subject', tt.body.length <= 320 && tt.subject === undefined, `${tt.body.length}`);
  check('overdue deal selects the overdue purpose', (await s.draft(s.deals.overdue, { channel: 'text' })).body.draft.purpose === 'overdue_follow_up');
  check('a closed deal is refused (409) with no provider request', (await s.draft(s.deals.closed, { channel: 'email', ai: true })).status === 409 && calls() === 0);

  console.log('\nRewrite with AI: Email');
  let mark = calls();
  const aiEmail = await s.draft(s.deals.checkIn, { channel: 'email', ai: true });
  const ae = aiEmail.body && aiEmail.body.draft;
  check('exactly one provider request', calls() - mark === 1, `${calls() - mark} request(s)`);
  check('the live model output was accepted (source: ai)', Boolean(ae) && ae.source === 'ai' && !aiEmail.body.ai_unavailable, aiEmail.body && aiEmail.body.ai_unavailable ? `fell back: ${aiEmail.body.reason}` : '');
  check('email within limits (subject <= 90, body <= 900)', Boolean(ae && ae.subject) && ae.subject.length <= 90 && ae.body.length <= 900, ae ? `${(ae.subject || '').length} / ${ae.body.length}` : '');
  check('names substituted locally; no placeholder left', Boolean(ae) && ae.body.includes(S.first) && ae.body.includes(s.senderName) && !/\{\{/.test((ae.subject || '') + ae.body));
  check('no link, contact detail, price, or promise in the text', Boolean(ae) && clean(`${ae.subject}\n${ae.body.replace(S.first, '').replace(s.senderName, '').replace(s.dealershipName, '')}`));

  console.log('\nRewrite with AI: Text');
  mark = calls();
  const aiText = await s.draft(s.deals.checkIn, { channel: 'text', ai: true });
  const at = aiText.body && aiText.body.draft;
  check('exactly one provider request', calls() - mark === 1, `${calls() - mark} request(s)`);
  check('the live model output was accepted (source: ai)', Boolean(at) && at.source === 'ai' && !aiText.body.ai_unavailable, aiText.body && aiText.body.ai_unavailable ? `fell back: ${aiText.body.reason}` : '');
  check('text within limit (<= 320) with no subject', Boolean(at) && at.body.length <= 320 && at.subject === undefined, at ? `${at.body.length}` : '');
  check('names substituted locally; no placeholder left', Boolean(at) && at.body.includes(S.first) && at.body.includes(s.senderName) && !/\{\{/.test(at.body));

  console.log('\nWhat the provider received');
  const payloads = s.providerCalls();
  check('two provider requests in total (one per AI action)', payloads.length === 2, `${payloads.length}`);
  const allSent = JSON.stringify(payloads);
  const leaked = sentinels.filter(v => allSent.includes(v));
  check('none of the names, phone, email, address, ID, employer, income, VIN, prices, notes, deal type, dealership or sender name were sent', leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${sentinels.length} values checked`);
  check('the prompts use the three placeholders', payloads.every(p => ['{{customer_first_name}}', '{{sender_name}}', '{{dealership_name}}'].every(ph => p.input.includes(ph))));
  const facts = payloads.map(p => JSON.parse(p.input.match(/^Facts: (.*)$/m)[1]));
  check('the only facts sent are channel, purpose, vehicle, and days since started', facts.every(f => JSON.stringify(Object.keys(f)) === JSON.stringify(['channel', 'purpose', 'vehicle', 'days_since_started'])) && facts.every(f => f.vehicle === VEHICLE), JSON.stringify(facts[0]));

  console.log('\nNothing is sent or written');
  check('the only outbound host contacted was api.openai.com', JSON.stringify(s.hosts().filter(h => h !== 'api.openai.com')) === '[]', s.hosts().join(', ') || 'none');
  check('the draft responses contain no mailto or send field', ![tEmail, tText, aiEmail, aiText].some(r => /mailto|sent|send/i.test(JSON.stringify(Object.keys(r.body || {})))));
  check('no draft, activity, status, or customer data was written (all tables identical)', s.snapshot() === before);

  console.log('\n== Provider failures fall back to the template');
  const failing = [
    { tag: 'invalid', label: 'a real rejection (deliberately invalid key)', key: 'sk-invalid-validation-key-not-real', expect: 'unavailable', expectCall: true },
    { tag: 'timeout', label: 'a 1 ms provider timeout', key: apiKey, timeoutMs: 1, expect: 'timeout', expectCall: true },
    { tag: 'nokey', label: 'no key configured', key: null, expect: 'not_configured', expectCall: false },
  ];
  for (const f of failing) {
    const server = await startServer({ tag: f.tag, key: f.key, timeoutMs: f.timeoutMs });
    const snap = server.snapshot();
    const template = (await server.draft(server.deals.checkIn, { channel: 'email' })).body.draft;
    const res = await server.draft(server.deals.checkIn, { channel: 'email', ai: true });
    check(`${f.label}: HTTP 200 with reason "${f.expect}"`, res.status === 200 && res.body.ai_unavailable === true && res.body.reason === f.expect, `HTTP ${res.status}, reason ${res.body && res.body.reason}`);
    check(`${f.label}: the template draft is returned unchanged`, JSON.stringify(res.body.draft) === JSON.stringify(template) && res.body.draft.source === 'template');
    check(`${f.label}: a clear message is shown`, /standard draft/.test(res.body.message || ''));
    if (!f.expectCall) check(`${f.label}: no provider request was attempted`, server.providerCalls().length === 0);
    check(`${f.label}: nothing was written`, server.snapshot() === snap);
  }
}

async function cleanup() {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    }
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n[followup-validation] cleanup: test servers stopped, temporary directory ${fs.existsSync(tmp || '') ? 'STILL EXISTS (remove it manually)' : 'removed'}`);
}

main()
  .catch(err => { check(`unexpected error: ${err.message}`, false); })
  .finally(cleanup)
  .then(() => {
    const failed = results.filter(r => !r).length;
    console.log(`\n[followup-validation] ${results.length - failed}/${results.length} checks passed${failed ? ` - ${failed} FAILED` : ''}${STUB ? ' (STUB provider: this was a rehearsal, not a live test)' : ''}`);
    process.exit(failed ? 1 : 0);
  });
