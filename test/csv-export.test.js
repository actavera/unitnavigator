'use strict';
// Formula-injection hardening for the inventory CSV export. The export carries
// user-controlled text (make, model, notes, stock number, ...), so any cell a
// spreadsheet would run as a formula must be inert, while real numbers, normal
// text, and CSV quoting are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { csvCell } = require('../services/csv');

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

// --- the cell writer ---

test('formula triggers are neutralized with a leading apostrophe and the text is preserved', () => {
  for (const value of ['=1+1', '+SUM(A1)', '-2+3', '@SUM(1)', '\t=cmd', '\r=cmd', '\n=cmd', '  =HYPERLINK("http://evil.example","x")', ' \t@x', '\n  +1']) {
    const [cell] = parseCsv(csvCell(value))[0];
    assert.ok(!FORMULA_START.test(cell), `${JSON.stringify(value)} -> ${JSON.stringify(cell)}`);
    assert.equal(cell, `'${value}`);
  }
});

test('ordinary text, real numbers, empties and quoting are unchanged', () => {
  assert.equal(csvCell('Honda'), 'Honda');
  assert.equal(csvCell('A-100'), 'A-100');
  assert.equal(csvCell('2019 F-150'), '2019 F-150');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(41000), '41000');
  assert.equal(csvCell(-250.5), '-250.5', 'a real negative number is data, not a formula');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(['/uploads/a.jpg', '/uploads/b.jpg']), '"/uploads/a.jpg\n/uploads/b.jpg"');
});

test('a number stored as TEXT is treated as text, and a quoted formula keeps its quoting', () => {
  assert.equal(csvCell('-100'), "'-100");
  assert.equal(csvCell('=A1,B1'), '"\'=A1,B1"');
  assert.deepEqual(parseCsv(csvCell('=A1,B1'))[0], ["'=A1,B1"]);
});

// --- the export route ---

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

async function api(token, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* csv */ }
  return { status: res.status, body: json, raw, headers: res.headers };
}

async function demo() {
  const res = await api(null, 'POST', '/api/auth/demo-login');
  return { token: res.body.token, dealershipId: jwt.decode(res.body.token).dealership_id };
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-csv-export-test-'));
  const port = 8100 + Math.floor(Math.random() * 300);
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

test('the export neutralizes hostile fields, keeps numbers and normal text intact, and keeps the header and row shape', async () => {
  const dealer = await demo();
  const imported = await api(dealer.token, 'POST', '/api/inventory/import', {
    rows: [
      {
        vin: 'EXPORTVIN0000001', year: 2020, make: '=HYPERLINK("http://evil.example","x")', model: '@SUM(1,2)',
        trim: '+cmd|calc', color: '-2+3', body_style: '  =1+1', stock_number: '\t=A1', notes: '\n=evil()',
        mileage: 41000, price: 15995,
      },
      { vin: 'EXPORTVIN0000002', year: 2019, make: 'Honda', model: 'Civic', trim: 'EX', color: 'Blue', stock_number: 'A-100', notes: 'Clean, one owner', mileage: 52000, price: 12500 },
    ],
  });
  assert.equal(imported.status, 201);

  const res = await api(dealer.token, 'GET', '/api/inventory/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const rows = parseCsv(res.raw.replace(/^﻿/, ''));
  const header = rows[0];
  assert.deepEqual(header.slice(0, 6), ['vin', 'stock_number', 'year', 'make', 'model', 'trim']);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.length, header.length, 'a hostile value cannot add or remove columns');
    for (const cell of row) assert.ok(!FORMULA_START.test(cell), `formula cell in export: ${JSON.stringify(cell)}`);
  }

  const col = name => header.indexOf(name);
  const hostile = rows.find(r => r[col('vin')] === 'EXPORTVIN0000001');
  assert.equal(hostile[col('make')], '\'=HYPERLINK("http://evil.example","x")', 'content is preserved after the apostrophe');
  assert.equal(hostile[col('model')], "'@SUM(1,2)");
  assert.equal(hostile[col('mileage')], '41000');
  assert.equal(hostile[col('asking_price')], '15995');

  const plain = rows.find(r => r[col('vin')] === 'EXPORTVIN0000002');
  assert.deepEqual(
    [plain[col('make')], plain[col('model')], plain[col('stock_number')], plain[col('notes')], plain[col('mileage')]],
    ['Honda', 'Civic', 'A-100', 'Clean, one owner', '52000'],
    'ordinary data is exported exactly as before',
  );
});

test('the export is still permission-gated and tenant-scoped', async () => {
  const a = await demo();
  const b = await demo();
  await api(a.token, 'POST', '/api/inventory/import', { rows: [{ vin: 'TENANTEXPORT0001', year: 2020, make: 'OnlyInA', model: 'Row' }] });

  const exportB = await api(b.token, 'GET', '/api/inventory/export');
  assert.equal(exportB.status, 200);
  assert.ok(!exportB.raw.includes('OnlyInA') && !exportB.raw.includes('TENANTEXPORT0001'));

  const db = new Database(path.join(tmpDataDir, 'unitnavigator.db'));
  let viewerToken;
  try {
    const id = Number(db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, status)
      VALUES (?, 'No Export', 'no-export@example.test', ?, 'staff', '["inventory_view"]', 'active')
    `).run(a.dealershipId, bcrypt.hashSync('x', 4)).lastInsertRowid);
    viewerToken = jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' });
  } finally {
    db.close();
  }
  assert.equal((await api(viewerToken, 'GET', '/api/inventory/export')).status, 403);
  assert.equal((await api(null, 'GET', '/api/inventory/export')).status, 401);
});
