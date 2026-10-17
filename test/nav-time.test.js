'use strict';
// UN.fmt.ago / UN.fmt.parseTime in public/js/nav.js: SQLite UTC timestamps
// without a zone marker must be read as UTC (not local time), and ISO values
// with a zone are unchanged. A past event never shows a negative age.
// Force a non-UTC zone so a regression to local-time parsing would fail here.
process.env.TZ = 'America/Denver';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadUN(timezone) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'nav.js'), 'utf8');
  const store = {};
  const element = () => ({ dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, style: {}, setAttribute() {}, querySelectorAll: () => [] });
  const context = {
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { documentElement: element(), querySelectorAll: () => [], getElementById: () => null, createElement: element, body: element(), addEventListener() {} },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { pathname: '/', href: '/' },
    navigator: {},
    setTimeout, clearTimeout, console, Date, Math, Number, String, JSON, Object, Array, URLSearchParams,
  };
  context.window.localStorage = context.localStorage;
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__UN = UN;`, context);
  return context.__UN;
}

test('SQLite "YYYY-MM-DD HH:MM:SS" timestamps are treated as UTC', () => {
  const UN = loadUN();
  const tenMinutesAgo = new Date(Date.now() - 10 * 60000);
  const sqlite = tenMinutesAgo.toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(UN.fmt.parseTime(sqlite), Math.floor(tenMinutesAgo.getTime() / 1000) * 1000);
  assert.equal(UN.fmt.ago(sqlite), '10m ago');
});

test('ISO timestamps with a zone keep their meaning', () => {
  const UN = loadUN();
  const iso = new Date(Date.now() - 3 * 3600000).toISOString();
  assert.equal(UN.fmt.parseTime(iso), Date.parse(iso));
  assert.equal(UN.fmt.ago(iso), '3h ago');
  const offset = '2026-01-01T05:00:00-07:00';
  assert.equal(UN.fmt.parseTime(offset), Date.parse('2026-01-01T12:00:00Z'));
});

test('a past event never shows a negative relative time', () => {
  const UN = loadUN();
  const sqliteNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
  assert.doesNotMatch(UN.fmt.ago(sqliteNow), /^-/);
  assert.doesNotMatch(UN.fmt.ago(new Date(Date.now() + 5000).toISOString()), /^-/);
  assert.equal(UN.fmt.ago(null), '—');
});
