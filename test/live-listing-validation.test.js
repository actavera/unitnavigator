'use strict';
// The live-provider validation script is only useful if it keeps working, so
// this rehearses it end to end against the built-in STUB provider: no key,
// no network, nothing leaves the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'live-listing-validation.js');

function run(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.OPENAI_API_KEY;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 120000 });
}

test('the stub rehearsal passes every check and cleans up everything it created', () => {
  const res = run(['--stub-provider']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const summary = /(\d+)\/(\d+) checks passed/.exec(res.stdout);
  assert.ok(summary && summary[1] === summary[2] && Number(summary[2]) >= 20, `unexpected summary: ${summary && summary[0]}`);
  assert.ok(!/\[FAIL\]/.test(res.stdout));
  assert.match(res.stdout, /STUB provider: this was a rehearsal/);
  const tmpDir = /temporary directory: (\S+)/.exec(res.stdout)[1];
  assert.ok(!fs.existsSync(tmpDir), 'the temporary directory must be removed');
  assert.match(res.stdout, /temporary directory removed/);
});

test('it never prints the key or any token', () => {
  const res = run(['--stub-provider']);
  const output = res.stdout + res.stderr;
  assert.ok(!output.includes('stub-key-not-a-real-key'));
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(output), 'no JWT in the output');
  assert.match(output, /OPENAI_API_KEY: set \(stub/);
});

test('without a key and without --stub-provider it refuses to run and starts nothing', () => {
  const res = run([]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /OPENAI_API_KEY is not available/);
  assert.ok(!/temporary directory/.test(res.stdout), 'no temporary directory is created before the key check');
});

test('it refuses a directory that is not a Unit Navigator checkout', () => {
  const res = run(['--stub-provider', '--repo', path.join(__dirname)]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /does not look like a Unit Navigator checkout/);
});
