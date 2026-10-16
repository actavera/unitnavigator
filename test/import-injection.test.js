'use strict';
// Hostile-value coverage for the import UI: the downloadable issue report must
// be inert in a spreadsheet, and the history page and retry editor must
// HTML-escape the same values. The page scripts are executed in a minimal
// sandbox with a stub DOM, so this tests real rendered markup rather than the
// source text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const importPage = read('inventory-import.html');
const historyPage = read('import-history.html');
const scriptOf = html => [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(c => c.trim() && !/^\(function\(\)\{var t=/.test(c.trim())).join('\n');

function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `function ${name} must exist`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Minimal CSV reader (RFC 4180 quoting) so assertions run on parsed cells.
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
  row.push(cell);
  rows.push(row);
  return rows;
}

const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r\n]/;

const csvContext = vm.createContext({});
vm.runInContext(`${extractFunction(importPage, 'csvSafeCell')}\n${extractFunction(importPage, 'buildIssueReportCsv')}`, csvContext);
const csvSafeCell = value => csvContext.csvSafeCell(value);
const buildReport = issues => csvContext.buildIssueReportCsv(issues);

test('every formula trigger is neutralized, with the original text kept readable', () => {
  const dangerous = [
    '=1+1', '+SUM(A1:A9)', '-2+3', '@SUM(1)', '\t=cmd', '\r=cmd', '\n=cmd',
    '  =HYPERLINK("http://evil.example","click")', ' \t @x', '\n  +1', '=cmd|\' /C calc\'!A0',
  ];
  for (const value of dangerous) {
    const out = csvSafeCell(value);
    const [cell] = parseCsv(out)[0];
    assert.ok(!FORMULA_START.test(cell), `${JSON.stringify(value)} must not start a formula, got ${JSON.stringify(cell)}`);
    assert.equal(cell, `'${value}`, 'the content is preserved, only prefixed');
    assert.ok(out.startsWith('"\''), 'and it is quoted');
  }
});

test('ordinary values are untouched and proper CSV quoting is kept', () => {
  assert.equal(csvSafeCell('Honda Accord'), '"Honda Accord"');
  assert.equal(csvSafeCell('A-100'), '"A-100"', 'a hyphen inside a value is fine');
  assert.equal(csvSafeCell('2019 Ford F-150'), '"2019 Ford F-150"');
  assert.equal(csvSafeCell(''), '""');
  assert.equal(csvSafeCell(null), '""');
  assert.equal(csvSafeCell(undefined), '""');
  assert.equal(csvSafeCell(7), '"7"');
  assert.equal(csvSafeCell('He said "hi", then left'), '"He said ""hi"", then left"');
  assert.equal(csvSafeCell('line one\nline two'), '"line one\nline two"');
  assert.deepEqual(parseCsv(csvSafeCell('a,"b"\nc'))[0], ['a,"b"\nc']);
});

test('a whole report built from hostile stock numbers, vehicle labels, and messages has no formula cells', () => {
  const issues = [
    { row_number: 1, severity: 'error', vehicle: '=HYPERLINK("http://evil.example")', stock_number: '=1+1', vin_tail: '+ABCDE', message: '@SUM(1,2)' },
    { row_number: 2, severity: 'warning', vehicle: '-cmd|calc', stock_number: '\t=A1', vin_tail: 'ZZZZZZ', message: '\r\n=evil()' },
    { row_number: 3, severity: 'error', vehicle: '  +1', stock_number: '"=quoted"', vin_tail: '', message: 'a "quoted", comma' },
  ];
  const rows = parseCsv(buildReport(issues));
  assert.deepEqual(rows[0], ['row', 'type', 'vehicle', 'stock_number', 'vin_last_6', 'details']);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.length, 6, 'every row keeps exactly six cells, so a hostile value cannot add columns');
    for (const cell of row) assert.ok(!FORMULA_START.test(cell), `cell would start a formula: ${JSON.stringify(cell)}`);
  }
  assert.equal(rows[1][2], '\'=HYPERLINK("http://evil.example")');
  assert.equal(rows[1][3], "'=1+1");
  assert.equal(rows[3][3], '"=quoted"', 'a value that merely contains =, not starting with it, is unchanged');
  assert.equal(rows[3][5], 'a "quoted", comma');
});

// --- escaping, by running the page scripts against a stub DOM ---

function stubDocument() {
  const elements = {};
  const make = () => ({
    innerHTML: '', textContent: '', value: '', style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    scrollIntoView() {},
  });
  return { elements, document: { getElementById: id => (elements[id] ||= make()) } };
}

const EVIL = {
  img: '<img src=x onerror=alert(1)>',
  script: '<script>alert(1)</script>',
  svg: '<svg onload=alert(1)>',
  breakout: '"><img src=x onerror=alert(2)>',
  bold: '<b>bold</b>',
};

function assertNoLiveMarkup(html, label) {
  for (const tag of ['<img', '<script', '<svg', '<b>', '</b>', '<iframe', '<i>']) {
    assert.ok(!html.includes(tag), `${label}: unescaped "${tag}" in rendered markup`);
  }
  assert.ok(!html.includes('"><'), `${label}: an attribute was broken out of`);
}

test('history page: hostile values in sources, file names, users, and issues render escaped', async () => {
  const { elements, document } = stubDocument();
  const batch = {
    id: 5, kind: 'csv', source: EVIL.img, file_name: EVIL.breakout, status: 'completed_with_errors',
    total_rows: 2, created: 1, updated: 0, skipped: 1, error_count: 1, warning_count: 0, issues_truncated: 0,
    retry_of: null, failure_message: EVIL.script, imported_by: EVIL.bold, created_at: '2026-10-01 10:00:00',
    issues: [
      { row_number: 2, severity: 'error', code: 'missing_identity', message: EVIL.breakout, stock_number: '=HYPERLINK("x")' + EVIL.script, vin_tail: EVIL.svg, vehicle: EVIL.img },
    ],
  };
  const context = vm.createContext({
    document, toast() {}, console, Number, String, Date, JSON,
    UN: {
      requireAuth: () => true, renderNav() {}, can: () => true,
      api: async (_method, url) => (/batches\/\d+/.test(url) ? { batch, retention_days: 180 } : { batches: [batch], retention_days: 180 }),
    },
  });
  vm.runInContext(scriptOf(historyPage), context);
  await new Promise(resolve => setImmediate(resolve));
  await vm.runInContext('openBatch(5)', context);

  const list = elements.batchList.innerHTML;
  const detail = elements.batchDetail.innerHTML;
  assert.ok(list.includes('&lt;img'), 'the list shows the hostile text, escaped');
  assert.ok(detail.includes('&lt;script&gt;'));
  assert.ok(detail.includes('&quot;&gt;&lt;img'));
  assertNoLiveMarkup(list, 'history list');
  assertNoLiveMarkup(detail, 'history detail');
});

test('retry editor and result table: hostile row values render escaped, and cannot break out of attributes', () => {
  const { elements, document } = stubDocument();
  const source = [
    'let lastBatch = null;', 'let retryDrafts = [];',
    ['escapeHtml', 'renderRetryPanel', 'updateRetryDraft', 'handleImportResult'].map(n => extractFunction(importPage, n)).join('\n'),
  ].join('\n');
  const context = vm.createContext({
    document, toast() {}, setTimeout() {}, location: {}, Number, String, console,
  });
  vm.runInContext(source, context);

  const sentRows = [
    { vin: EVIL.breakout, stock_number: "=cmd|' /C calc'!A0", year: EVIL.svg, make: EVIL.img, model: EVIL.script },
  ];
  const result = {
    created: 0, updated: 0, skipped: 1, batch_id: 9,
    issues: [{ row_number: 1, severity: 'error', code: 'missing_identity', message: EVIL.script, stock_number: EVIL.bold, vin_tail: EVIL.img, vehicle: EVIL.svg }],
  };
  context.sentRows = sentRows;
  context.result = result;
  vm.runInContext('handleImportResult(result, sentRows)', context);

  const retry = elements.retryRows.innerHTML;
  const issues = elements.importResultIssues.innerHTML;
  assert.ok(retry.includes('value="&quot;&gt;&lt;img'), 'the VIN input value is escaped inside its attribute');
  assert.ok(retry.includes('&lt;script&gt;'));
  assertNoLiveMarkup(retry, 'retry editor');
  assertNoLiveMarkup(issues, 'result table');
  assert.equal(vm.runInContext('retryDrafts.length', context), 1);
  assert.equal(vm.runInContext('retryDrafts[0].row.vin', context), EVIL.breakout, 'the underlying data is untouched; only rendering is escaped');
});
