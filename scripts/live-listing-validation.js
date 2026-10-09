#!/usr/bin/env node
'use strict';
// Controlled live-provider validation for the AI Listing Suite.
//
// Runs the real server code in a throwaway data directory (never the real
// one), with one temporary demo dealership and two SYNTHETIC vehicles that
// have no real VIN, customer data, or private pricing. It makes at most two
// real provider requests (one per variant) and deletes everything it created.
//
//   node live-listing-validation.js [--repo <app dir>] [--key-from-pm2] [--stub-provider]
//
//   --repo <dir>      the Unit Navigator checkout to test (default: this file's parent)
//   --key-from-pm2    read OPENAI_API_KEY (and OPENAI_DESCRIPTION_MODEL) from the
//                     `unitnavigator` process in the CURRENT user's PM2. On the
//                     droplet that is root's PM2, so run this as root. The key is
//                     held in memory, handed only to the one test server that
//                     needs it, and never printed or written to disk.
//   --stub-provider   rehearse the whole flow against a fake provider; no key
//                     is needed and nothing leaves the machine.
//
// Without --stub-provider the key must come from OPENAI_API_KEY or
// --key-from-pm2. The "missing key" check runs against a second server that is
// started WITHOUT the key, so the real key is never removed or modified.
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
  console.error(`[live-validation] ${message}`);
  process.exit(2);
}

if (!fs.existsSync(path.join(repo, 'server.js'))) fatal(`${repo} does not look like a Unit Navigator checkout (no server.js).`);
if (!fs.existsSync(path.join(repo, 'services', 'listingSuite.js'))) fatal(`${repo} does not contain the AI Listing Suite yet (services/listingSuite.js is missing). Update that checkout first.`);
const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));

// --- key handling: presence only, never printed ---
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
console.log(`[live-validation] OPENAI_API_KEY: set (${STUB ? 'stub; no real provider is contacted' : 'real; value not shown'})`);
console.log(`[live-validation] app under test: ${repo}`);

// --- preload injected into the test servers: counts (and, in stub mode, fakes) provider requests ---
const PRELOAD = `
'use strict';
const https = require('https');
const fs = require('fs');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const counterFile = process.env.LIVE_VALIDATION_COUNTER_FILE;
const stub = process.env.LIVE_VALIDATION_STUB === '1';
const original = https.request;

function record(body) {
  let input = '';
  try { input = JSON.parse(body).input || ''; } catch { /* not json */ }
  const vehicles = (input.match(/"ref":"v\\d+"/g) || []).length;
  if (counterFile) fs.appendFileSync(counterFile, JSON.stringify({ at: Date.now(), vehicles }) + '\\n');
  return input;
}

function stubAnswer(input) {
  const line = (input.match(/^Vehicles: (.*)$/m) || [])[1];
  const vehicles = line ? JSON.parse(line) : [];
  const short = /Length: 20 to 40 words/.test(input);
  const items = vehicles.map(v => {
    const f = v.facts;
    const name = [f.year, f.make, f.model, f.trim].filter(Boolean).join(' ');
    const description = short
      ? 'Check out this ' + name + '. Clean, ready to go, and priced to move. Message us today!'
      : 'This ' + name + ' is a great pick for anyone who wants a dependable ride. With ' + (f.mileage || 'honest mileage') + ' and a color that turns heads, it delivers comfort, value, and everyday confidence. Come take a closer look and see why it stands out from the rest of the lot today.';
    return { ref: v.ref, description };
  });
  return { output_text: JSON.stringify(items) };
}

https.request = function (options, callback) {
  if (!options || options.hostname !== 'api.openai.com') return original.apply(this, arguments);
  const chunks = [];
  if (!stub) {
    const req = original.apply(this, arguments);
    const write = req.write.bind(req);
    const end = req.end.bind(req);
    req.write = (d, ...rest) => { chunks.push(Buffer.from(d)); return write(d, ...rest); };
    req.end = (d, ...rest) => { if (d && typeof d !== 'function') chunks.push(Buffer.from(d)); record(Buffer.concat(chunks).toString()); return end(d, ...rest); };
    return req;
  }
  const req = new EventEmitter();
  req.write = d => { chunks.push(Buffer.from(d)); return true; };
  req.setTimeout = () => req;
  req.destroy = () => {};
  req.end = d => {
    if (d && typeof d !== 'function') chunks.push(Buffer.from(d));
    const input = record(Buffer.concat(chunks).toString());
    const res = new Readable({ read() {} });
    res.statusCode = 200;
    res.push(Buffer.from(JSON.stringify(stubAnswer(input))));
    res.push(null);
    setImmediate(() => callback(res));
  };
  return req;
};
`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
  return ok;
}

const children = [];
let tmp;

function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

async function startServer({ tag, withKey }) {
  const dataDir = path.join(tmp, `${tag}-data`);
  const counterFile = path.join(tmp, `${tag}-provider-calls.jsonl`);
  fs.writeFileSync(counterFile, '');
  const port = 7000 + Math.floor(Math.random() * 900);
  // A minimal, explicit environment: the no-key server must not inherit the
  // key, and neither server needs any other secret.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
    PORT: String(port), NODE_ENV: 'test', UNITNAV_DATA_DIR: dataDir,
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    NODE_OPTIONS: `--require ${path.join(tmp, 'preload.js')}`,
    LIVE_VALIDATION_COUNTER_FILE: counterFile,
    ...(STUB ? { LIVE_VALIDATION_STUB: '1' } : {}),
    ...(withKey ? { OPENAI_API_KEY: apiKey, ...(model ? { OPENAI_DESCRIPTION_MODEL: model } : {}) } : {}),
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
    return { status: res.status, body: json };
  };
  const demo = await api(null, 'POST', '/api/auth/demo-login');
  if (demo.status !== 200) throw new Error(`demo login failed (${demo.status})`);
  const dealershipId = decodeJwt(demo.body.token).dealership_id;

  // Two synthetic vehicles. The VIN column is required by the schema, so a
  // clearly fake placeholder is used; no cost or minimum price is set.
  const db = new Database(path.join(dataDir, 'unitnavigator.db'));
  let unitA;
  let unitB;
  try {
    const insert = db.prepare(`
      INSERT INTO units (dealership_id, vin, year, make, model, trim, color, mileage, asking_price, notes, photos)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `);
    unitA = Number(insert.run(dealershipId, 'TEST-ONLY-NOT-A-VIN-A', 2019, 'Toyota', 'Camry', 'SE', 'Silver', 62000, 17995, '["/uploads/units/synthetic-a.jpg"]').lastInsertRowid);
    unitB = Number(insert.run(dealershipId, 'TEST-ONLY-NOT-A-VIN-B', 2021, 'Ford', 'F-150', null, null, 0, null, '[]').lastInsertRowid);
  } finally {
    db.close();
  }
  const snapshot = () => {
    const handle = new Database(path.join(dataDir, 'unitnavigator.db'), { readonly: true });
    try { return handle.prepare('SELECT * FROM units ORDER BY id').all(); } finally { handle.close(); }
  };
  const calls = () => fs.readFileSync(counterFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { api, token: demo.body.token, unitA, unitB, snapshot, calls, dataDir };
}

async function main() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-listing-live-'));
  fs.writeFileSync(path.join(tmp, 'preload.js'), PRELOAD);
  console.log(`[live-validation] temporary directory: ${tmp} (removed at the end)`);

  console.log('\n== Server WITH the provider key (temporary demo dealership, 2 synthetic vehicles)');
  const s = await startServer({ tag: 'with-key', withKey: true });
  const bulk = body => s.api(s.token, 'POST', '/api/inventory/description-suggestions/bulk', { unit_ids: [s.unitA, s.unitB], ...body });
  const before = s.snapshot();
  const ownText = (unit, text) => (unit === 'A' ? /toyota|camry|2019/i : /ford|f-150|2021/i).test(text);
  const otherText = (unit, text) => (unit === 'A' ? /ford|f-150/i : /toyota|camry/i).test(text);

  console.log('\nStandard variant');
  let mark = s.calls().length;
  const standard = await bulk({ variant: 'standard' });
  const stdA = standard.body && standard.body.units.find(u => u.id === s.unitA);
  const stdB = standard.body && standard.body.units.find(u => u.id === s.unitB);
  check('request succeeded and the provider was available', standard.status === 200 && standard.body.ai_unavailable === false, `HTTP ${standard.status}`);
  check('both vehicles received a suggestion', Boolean(stdA && stdB && stdA.status === 'suggested' && stdB.status === 'suggested'));
  const stdCalls = s.calls().slice(mark);
  check('exactly one provider request, carrying both vehicles', stdCalls.length === 1 && stdCalls[0].vehicles === 2, `${stdCalls.length} request(s), ${stdCalls[0] ? stdCalls[0].vehicles : 0} vehicle(s)`);
  check('each suggestion is mapped to the right vehicle', Boolean(stdA && stdB && ownText('A', stdA.suggestion) && !otherText('A', stdA.suggestion) && ownText('B', stdB.suggestion) && !otherText('B', stdB.suggestion)));
  check('standard length limit respected (<= 700 characters)', Boolean(stdA && stdB && stdA.suggestion.length <= 700 && stdB.suggestion.length <= 700), stdA ? `${stdA.suggestion.length} and ${stdB.suggestion.length} characters` : '');
  check('the complete vehicle has no warnings; the incomplete one flags price, mileage, and photos',
    Boolean(stdA && stdB && stdA.warnings.length === 0 && JSON.stringify(stdB.warnings.map(w => w.field)) === JSON.stringify(['asking_price', 'mileage', 'photos'])));

  console.log('\nFacebook variant');
  mark = s.calls().length;
  const facebook = await bulk({ variant: 'facebook' });
  const fbA = facebook.body && facebook.body.units.find(u => u.id === s.unitA);
  const fbB = facebook.body && facebook.body.units.find(u => u.id === s.unitB);
  check('request succeeded and both vehicles received a suggestion', Boolean(facebook.status === 200 && fbA && fbB && fbA.status === 'suggested' && fbB.status === 'suggested'));
  const fbCalls = s.calls().slice(mark);
  check('exactly one provider request, carrying both vehicles', fbCalls.length === 1 && fbCalls[0].vehicles === 2, `${fbCalls.length} request(s), ${fbCalls[0] ? fbCalls[0].vehicles : 0} vehicle(s)`);
  check('each suggestion is mapped to the right vehicle', Boolean(fbA && fbB && ownText('A', fbA.suggestion) && !otherText('A', fbA.suggestion) && ownText('B', fbB.suggestion) && !otherText('B', fbB.suggestion)));
  check('Facebook length limit respected (<= 300 characters) and shorter than Standard', Boolean(fbA && fbB && stdA && stdB && fbA.suggestion.length <= 300 && fbB.suggestion.length <= 300 && fbA.suggestion.length + fbB.suggestion.length < stdA.suggestion.length + stdB.suggestion.length),
    fbA ? `${fbA.suggestion.length} and ${fbB.suggestion.length} characters` : '');

  console.log('\nCaching, and generation alone writes nothing');
  mark = s.calls().length;
  const repeat = await bulk({ variant: 'standard' });
  check('repeating an identical request is served from cache with no new provider request', s.calls().length === mark && Boolean(repeat.body && repeat.body.units.every(u => u.cached === true)));
  check('generation performed no database write (the units table is byte-identical)', JSON.stringify(s.snapshot()) === JSON.stringify(before));

  console.log('\nEditing and explicit saving (one suggestion only)');
  const edited = `${stdA.suggestion} (edited during validation)`;
  const saved = await s.api(s.token, 'PUT', `/api/inventory/${s.unitA}`, { notes: edited });
  check('saving one reviewed, edited suggestion succeeded', saved.status === 200, `HTTP ${saved.status}`);
  const after = s.snapshot();
  const rowA = after.find(r => r.id === s.unitA);
  const rowB = after.find(r => r.id === s.unitB);
  const beforeA = before.find(r => r.id === s.unitA);
  const changed = Object.keys(rowA).filter(k => JSON.stringify(rowA[k]) !== JSON.stringify(beforeA[k]));
  check('the saved vehicle now holds exactly the edited text', rowA.notes === edited);
  check('only the description changed on that vehicle', JSON.stringify(changed) === JSON.stringify(['notes']), `changed columns: ${changed.join(', ') || 'none'}`);
  check('the other vehicle is completely untouched', JSON.stringify(rowB) === JSON.stringify(before.find(r => r.id === s.unitB)));

  console.log('\nExisting descriptions are preserved');
  mark = s.calls().length;
  const preserved = await bulk({ variant: 'standard' });
  const keptA = preserved.body && preserved.body.units.find(u => u.id === s.unitA);
  check('the saved vehicle is identified and skipped by default', Boolean(keptA && keptA.status === 'skipped_existing' && keptA.has_description && keptA.current_description === edited));
  check('no new provider request was needed', s.calls().length === mark);
  check('the saved description is still unchanged in the database', s.snapshot().find(r => r.id === s.unitA).notes === edited);

  console.log('\n== Second server started WITHOUT the key (the real key is neither removed nor reused)');
  const n = await startServer({ tag: 'no-key', withKey: false });
  const fallback = await n.api(n.token, 'POST', '/api/inventory/description-suggestions/bulk', { unit_ids: [n.unitA, n.unitB], variant: 'standard' });
  const fbWarn = fallback.body && fallback.body.units && fallback.body.units.find(u => u.id === n.unitB);
  check('responds 200 with a clear not-configured message', fallback.status === 200 && fallback.body.ai_unavailable === true && fallback.body.reason === 'not_configured' && /not configured/i.test(fallback.body.message || ''));
  check('quality warnings are still shown', Boolean(fbWarn && fbWarn.warnings.length === 3));
  check('no provider request was attempted', n.calls().length === 0);
  check('nothing was written', JSON.stringify(n.snapshot().map(r => r.notes)) === JSON.stringify([null, null]));
}

async function cleanup() {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    }
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n[live-validation] cleanup: test servers stopped, temporary directory ${fs.existsSync(tmp || '') ? 'STILL EXISTS (remove it manually)' : 'removed'}`);
}

main()
  .catch(err => { check(`unexpected error: ${err.message}`, false); })
  .finally(cleanup)
  .then(() => {
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n[live-validation] ${results.length - failed}/${results.length} checks passed${failed ? ` - ${failed} FAILED` : ''}${STUB ? ' (STUB provider: this was a rehearsal, not a live test)' : ''}`);
    process.exit(failed ? 1 : 0);
  });
