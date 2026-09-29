#!/usr/bin/env node
'use strict';
// Pre-flight sanity check before a controlled DocuSeal/Stirling integration
// test run. Not read-only or zero-write: loading database.js creates the
// isolated SQLite database and runs migrations, and the writability check
// creates esign-archives/ and writes/deletes a probe file. What it DOES
// guarantee:
//   - no network requests
//   - no provider contact
//   - no DocuSeal submission
//   - every filesystem write is confined to the validated isolated test
//     directory (never the repository, production, or home directory —
//     see scripts/lib/isolatedDataDir.js)
// Never prints a secret value. See docs/DOCUSEAL_INTEGRATION_TEST.md.
//
// Usage:
//   export UNITNAV_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/unitnav-esign-test-XXXXXX")"
//   export DOCUSEAL_API_KEY=... STIRLING_PDF_URL=... JWT_SECRET=...
//   node scripts/preflight-esign.js
const path = require('path');
const fs = require('fs');
const { requireIsolatedDataDir, IsolatedDataDirError } = require('./lib/isolatedDataDir');

// Only http/https are accepted for a provider base URL — new URL() alone
// would also happily accept file:, ftp:, etc.
function parseHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'could not be parsed as a URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `scheme "${parsed.protocol}" is not allowed here — only http/https` };
  }
  return { ok: true, host: parsed.host };
}

// Runs every check and returns the results without printing or exiting —
// the CLI entry point below handles both of those. `env` defaults to the
// real process.env but can be overridden for testing. `_injectFailure` is a
// test-only hook (never used by the CLI) that, if provided, is invoked right
// after process.env.UNITNAV_DATA_DIR is set — used to prove restoration
// still happens when something throws mid-flight.
function runPreflightChecks({ dataDir, env = process.env, _injectFailure } = {}) {
  const results = [];
  const add = (label, ok, detail) => { results.push({ label, ok, detail }); return ok; };

  // This MUST happen before database.js (or anything that requires it) is
  // ever loaded — database.js creates/opens its SQLite file as a side
  // effect of being required, and that must never happen against an
  // unvalidated path.
  const resolvedDataDir = requireIsolatedDataDir(dataDir ?? env.UNITNAV_DATA_DIR);
  add('UNITNAV_DATA_DIR is an isolated, uniquely-named test directory', true, resolvedDataDir);

  // Installing the validated path into process.env is a real, observable
  // mutation of a global for the duration of this call — restore whatever
  // was there before, on every exit path, success or thrown failure alike.
  const originalEnvDataDir = process.env.UNITNAV_DATA_DIR;
  process.env.UNITNAV_DATA_DIR = resolvedDataDir;
  try {
    // Safe to load now — only after the validated path has been installed.
    const db = require('../database');

    if (_injectFailure) _injectFailure();

    const esignColumns = db.prepare("PRAGMA table_info(esign_envelopes)").all().map(c => c.name);
    add('esign_envelopes.audit_log_path migration present', esignColumns.includes('audit_log_path'));

    const dealershipColumns = db.prepare("PRAGMA table_info(dealerships)").all().map(c => c.name);
    add('dealerships.representative_email migration present', dealershipColumns.includes('representative_email'));

    const archiveDir = path.join(db.dataDir, 'esign-archives');
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      const probe = path.join(archiveDir, `.preflight-probe-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probe, 'preflight-probe');
      fs.readFileSync(probe);
      fs.unlinkSync(probe);
      add('esign-archives directory is writable', true, archiveDir);
    } catch (err) {
      add('esign-archives directory is writable', false, err.message);
    }

    const docusealKey = env.DOCUSEAL_API_KEY;
    add('DOCUSEAL_API_KEY is set', Boolean(docusealKey && docusealKey.trim()), docusealKey ? '(value not printed)' : 'missing');

    const docusealBaseUrl = env.DOCUSEAL_BASE_URL;
    if (docusealBaseUrl) {
      const result = parseHttpUrl(docusealBaseUrl);
      add('DOCUSEAL_BASE_URL is a valid http(s) URL', result.ok, result.ok ? result.host : result.error);
    } else {
      add('DOCUSEAL_BASE_URL not set', true, 'will default to https://api.docuseal.com');
    }

    const stirlingUrl = env.STIRLING_PDF_URL;
    if (stirlingUrl) {
      const result = parseHttpUrl(stirlingUrl);
      add('STIRLING_PDF_URL is a valid http(s) URL', result.ok, result.ok ? result.host : result.error);
    } else {
      add('STIRLING_PDF_URL is set', false, 'required — packet flattening will fail without it');
    }

    add('STIRLING_PDF_API_KEY', true, env.STIRLING_PDF_API_KEY ? 'set (value not printed)' : 'not set — only needed if your Stirling instance requires auth');

    const timeoutMs = env.UNITNAV_PROVIDER_TIMEOUT_MS;
    if (timeoutMs !== undefined) {
      const n = Number(timeoutMs);
      add('UNITNAV_PROVIDER_TIMEOUT_MS is a positive number', Number.isFinite(n) && n > 0, `${timeoutMs}ms`);
    } else {
      add('UNITNAV_PROVIDER_TIMEOUT_MS not set', true, 'will default to 20000ms for Stirling, DocuSeal, and document/audit downloads');
    }

    // The app itself falls back to an insecure default JWT_SECRET outside
    // NODE_ENV=production — but this integration-test workflow requires a
    // real, explicitly-set secret regardless, so it never runs even a
    // throwaway test session on the dev fallback.
    add('JWT_SECRET is set', Boolean(env.JWT_SECRET && env.JWT_SECRET.trim()), env.JWT_SECRET ? '(value not printed)' : 'missing — required for this integration-test workflow even though development mode has an insecure fallback');

    return { allOk: results.every(r => r.ok), results };
  } finally {
    // All checks above have either completed or thrown by this point.
    if (originalEnvDataDir === undefined) delete process.env.UNITNAV_DATA_DIR;
    else process.env.UNITNAV_DATA_DIR = originalEnvDataDir;
  }
}

function main() {
  let outcome;
  try {
    outcome = runPreflightChecks();
  } catch (err) {
    if (err instanceof IsolatedDataDirError) {
      console.error(`[preflight-esign] REFUSED: ${err.message}`);
      console.error('[preflight-esign] Nothing was read, written, or imported beyond this check.');
      process.exit(1);
    }
    throw err;
  }

  for (const { label, ok, detail } of outcome.results) {
    console.log(`[${ok ? ' OK ' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  }
  console.log('');
  if (outcome.allOk) {
    console.log('[preflight-esign] ALL CHECKS PASSED. No network requests were made and no provider was contacted.');
  } else {
    console.log('[preflight-esign] ONE OR MORE CHECKS FAILED — resolve the above before starting the app for a live test.');
  }
  process.exit(outcome.allOk ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { runPreflightChecks, parseHttpUrl };
