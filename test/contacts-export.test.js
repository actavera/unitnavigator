'use strict';
// Formula-injection hardening for GET /api/deals/export/contacts.csv. Names,
// emails, and phone numbers are free text, so anything a spreadsheet would run
// as a formula must be inert, while legitimate international "+" phone numbers
// and ordinary rows are exported exactly as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { safeText, safePhone, csvCell } = require('../services/csv');

const REPO_ROOT = path.join(__dirname, '..');
const JWT_SECRET = 'test-only-secret-do-not-use-in-prod';
const FORMULA_START = /^\s*[=+\-@]|^[\t\r\n]/;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// --- writers ---

test('safeText neutralizes every formula trigger, keeps the text readable, and leaves ordinary text alone', () => {
  for (const value of ['=1+1', '+SUM(A1)', '-2+3', '@SUM(1)', '\t=cmd', '\r=cmd', '\n=cmd', '  =HYPERLINK("http://evil.example")', ' \t@x', '\n  +1']) {
    assert.equal(safeText(value), `'${value}`, JSON.stringify(value));
    assert.ok(!FORMULA_START.test(safeText(value)));
  }
  for (const value of ['Jane', "O'Brien", 'Mary-Ann', 'jane+tag@example.com', 'a=b', 'x@y.com', '', null, undefined, 'pending', 'cash']) {
    assert.equal(safeText(value), String(value ?? ''), String(value));
  }
  assert.equal(safeText(-5), '-5', 'a real number is data, not a formula');
});

test('safePhone keeps legitimate international numbers and formatted local numbers unchanged', () => {
  for (const phone of [
    '+18015550100', '+1 801 555 0100', '+1 (801) 555-0100', '+1.801.555.0100', '+44 20 7946 0958',
    '+52 55 1234 5678', '+61 2 9876 5432', '(801) 555-0100', '801-555-0100', '801.555.0100', '8015550100', '1 801 555 0100',
  ]) {
    assert.equal(safePhone(phone), phone, phone);
  }
});

test('safePhone neutralizes anything with a leading "+" that is not strictly a phone number, and any other trigger', () => {
  for (const value of [
    "+cmd|' /C calc'!A0", '+SUM(1,2)', '+1+1', '+1 801; =cmd', '+', '+ ', '+1', '+18015550100x', '+1 801 555 0100 ext. 5',
    ' +18015550100', '\t+18015550100', '+18015550100\n', '+' + '1'.repeat(40), '=1+1', '@SUM(1)', '-801 555 0100', '-1+1',
  ]) {
    const out = safePhone(value);
    assert.ok(!FORMULA_START.test(out), `${JSON.stringify(value)} -> ${JSON.stringify(out)}`);
    assert.equal(out, `'${value}`, 'readable content is preserved');
  }
});

test('csvCell still behaves as before (it now shares safeText)', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell(-250.5), '-250.5');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(['/a.jpg', '/b.jpg']), '"/a.jpg\n/b.jpg"');
});

// --- the route ---

let child;
let baseUrl;
let tmpDataDir;

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.status) return; } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function get(token, urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: bytes.toString('utf8') };
}

async function demo() {
  const res = await fetch(`${baseUrl}/api/auth/demo-login`, { method: 'POST' });
  const body = await res.json();
  return { token: body.token, dealershipId: jwt.decode(body.token).dealership_id };
}

function seed(dealershipId, customers) {
  const db = new Database(path.join(tmpDataDir, 'unitnavigator.db'));
  try {
    // Demo dealerships ship with sample customers; start from a known set.
    db.prepare('DELETE FROM deals WHERE dealership_id = ?').run(dealershipId);
    db.prepare('DELETE FROM customers WHERE dealership_id = ?').run(dealershipId);
    const addCustomer = db.prepare('INSERT INTO customers (dealership_id, first_name, last_name, email, phone) VALUES (?, ?, ?, ?, ?)');
    const addDeal = db.prepare("INSERT INTO deals (dealership_id, customer_id, deal_type, status) VALUES (?, ?, ?, ?)");
    for (const c of customers) {
      const id = Number(addCustomer.run(dealershipId, c.first, c.last, c.email, c.phone).lastInsertRowid);
      for (const [type, status] of c.deals || []) addDeal.run(dealershipId, id, type, status);
    }
  } finally {
    db.close();
  }
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-contacts-export-test-'));
  const port = 8500 + Math.floor(Math.random() * 300);
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), UNITNAV_DATA_DIR: tmpDataDir, JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(`${baseUrl}/api/public/dealer`);
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

const HEADER_LINE = '"First Name","Last Name","Email","Phone","Deal Status","Deal Type"';

test('shape, header, BOM, headers, and a normal row are exactly as before; duplicate and no-deal rows are pinned', async () => {
  const dealer = await demo();
  seed(dealer.dealershipId, [
    { first: 'Jane', last: 'Buyer', email: 'jane@example.com', phone: '(801) 555-0100', deals: [['cash', 'pending']] },
    { first: 'Two', last: 'Deals', email: 'two@example.com', phone: '+1 801 555 0100', deals: [['cash', 'closed'], ['bhph', 'pending']] },
    { first: 'No', last: 'Deal', email: 'no@example.com', phone: '', deals: [] },
  ]);
  const res = await get(dealer.token, '/api/deals/export/contacts.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="unit-navigator-contacts\.csv"/);
  assert.deepEqual([...res.bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'starts with the UTF-8 BOM, like the inventory export');

  const lines = res.text.replace(/^﻿/, '').split('\n');
  assert.equal(lines[0], HEADER_LINE);
  assert.ok(lines.includes('"Jane","Buyer","jane@example.com","(801) 555-0100","pending","cash"'), 'a normal row is byte-for-byte what it was before');

  const rows = parseCsv(res.text.replace(/^﻿/, ''));
  assert.deepEqual(rows.slice(1).map(r => r[1]), ['Buyer', 'Deal', 'Deals', 'Deals'], 'sorted by last name; one row per deal, and one row for a customer with none');
  assert.equal(rows.filter(r => r[1] === 'Deals').length, 2, 'a customer with two deals appears twice (existing behavior)');
  assert.deepEqual(rows.find(r => r[1] === 'Deal').slice(4), ['', ''], 'no deal gives empty status and type');
  for (const row of rows) assert.equal(row.length, 6);
  assert.ok(res.text.replace(/^﻿/, '').split('\n').slice(1).every(l => l.startsWith('"') && l.endsWith('"')), 'every cell stays quoted');
});

test('hostile names, emails and phones are inert; legitimate "+" phones and ordinary data are untouched', async () => {
  const dealer = await demo();
  seed(dealer.dealershipId, [
    { first: '=HYPERLINK("http://evil.example","x")', last: '@SUM(1,2)', email: '+cmd|calc@example.com', phone: "+cmd|' /C calc'!A0", deals: [['cash', 'pending']] },
    { first: '-2+3', last: '\t=A1', email: '  =1+1', phone: '=1+1', deals: [] },
    { first: 'Pat', last: 'International', email: 'pat+tag@example.com', phone: '+44 20 7946 0958', deals: [] },
    { first: 'Zoë', last: 'Éclair', email: 'zoe@example.com', phone: '+1 (801) 555-0100', deals: [] },
    { first: 'Quote', last: 'Test "Q", Jr.\nSecond line', email: 'q@example.com', phone: '801-555-0100', deals: [] },
  ]);
  const res = await get(dealer.token, '/api/deals/export/contacts.csv');
  const rows = parseCsv(res.text.replace(/^﻿/, ''));
  assert.equal(rows.length, 6);
  const LEGITIMATE_PHONES = new Set(['+44 20 7946 0958', '+1 (801) 555-0100']);
  for (const row of rows) {
    assert.equal(row.length, 6, 'a hostile value cannot add or remove columns');
    row.forEach((cell, column) => {
      const isKnownGoodPhone = column === 3 && LEGITIMATE_PHONES.has(cell);
      assert.ok(isKnownGoodPhone || !FORMULA_START.test(cell), `formula cell in export: ${JSON.stringify(cell)}`);
    });
  }
  const byLast = last => rows.find(r => r[1].replace(/^'/, '') === last);
  const hostile = byLast('@SUM(1,2)');
  assert.equal(hostile[0], '\'=HYPERLINK("http://evil.example","x")', 'content is preserved after the apostrophe');
  assert.equal(hostile[2], "'+cmd|calc@example.com");
  assert.equal(hostile[3], "'+cmd|' /C calc'!A0");

  assert.equal(byLast('International')[3], '+44 20 7946 0958', 'a legitimate international phone is unchanged');
  assert.equal(byLast('Éclair')[3], '+1 (801) 555-0100');
  assert.equal(byLast('Éclair')[0], 'Zoë', 'non-ASCII names survive');
  assert.equal(byLast('International')[2], 'pat+tag@example.com', 'an email with + inside is unchanged');
  assert.equal(rows.find(r => r[0] === 'Quote')[1], 'Test "Q", Jr.\nSecond line', 'quotes, commas and newlines round-trip');
  assert.equal(rows.find(r => r[0] === 'Quote')[3], '801-555-0100');
});

test('authentication and permission are still required', async () => {
  const dealer = await demo();
  assert.equal((await get(null, '/api/deals/export/contacts.csv')).status, 401);

  const db = new Database(path.join(tmpDataDir, 'unitnavigator.db'));
  let noReports;
  let reportsOnly;
  try {
    const add = (email, permissions) => Number(db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, status)
      VALUES (?, 'Test User', ?, ?, 'staff', ?, 'active')
    `).run(dealer.dealershipId, email, bcrypt.hashSync('x', 4), permissions).lastInsertRowid);
    noReports = jwt.sign({ id: add('no-reports@example.test', '["inventory_view"]') }, JWT_SECRET, { expiresIn: '1h' });
    reportsOnly = jwt.sign({ id: add('reports-only@example.test', '["reports_view"]') }, JWT_SECRET, { expiresIn: '1h' });
  } finally {
    db.close();
  }
  assert.equal((await get(noReports, '/api/deals/export/contacts.csv')).status, 403);
  assert.equal((await get(reportsOnly, '/api/deals/export/contacts.csv')).status, 200, 'permission rules are unchanged: reports_view still suffices');
});

test('tenant isolation: each dealership exports only its own contacts', async () => {
  const a = await demo();
  const b = await demo();
  seed(a.dealershipId, [{ first: 'OnlyInA', last: 'Alpha', email: 'alpha@example.com', phone: '+1 801 555 0111', deals: [['cash', 'pending']] }]);
  seed(b.dealershipId, [{ first: 'OnlyInB', last: 'Bravo', email: 'bravo@example.com', phone: '+1 801 555 0222', deals: [] }]);

  const exportA = (await get(a.token, '/api/deals/export/contacts.csv')).text;
  const exportB = (await get(b.token, '/api/deals/export/contacts.csv')).text;
  assert.ok(exportA.includes('OnlyInA') && !exportA.includes('OnlyInB') && !exportA.includes('555 0222'));
  assert.ok(exportB.includes('OnlyInB') && !exportB.includes('OnlyInA') && !exportB.includes('555 0111'));
});
