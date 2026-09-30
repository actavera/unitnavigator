#!/usr/bin/env node
'use strict';
// Narrowly-scoped smoke test: generates a local test packet and flattens it
// through Stirling.
//
// Precise guarantee (requiring routes/paperwork.js loads the whole module,
// which also *defines* DocuSeal-related functions — so "never imports
// anything DocuSeal-related" would overstate it; this is the accurate claim):
//   - this script never INVOKES a DocuSeal function — it destructures and
//     calls only buildOfficialPacket and preparePacketWithStirling;
//   - it never reads or requires any DOCUSEAL_* configuration;
//   - test/stirling-smoke-test.test.js is the stronger, behavioral proof:
//     it intercepts every outbound request during a real run and asserts
//     each one's origin matches the Stirling mock exactly, nothing else.
//
// Usage:
//   export UNITNAV_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/unitnav-esign-test-XXXXXX")"
//   export STIRLING_PDF_URL=...   # STIRLING_PDF_API_KEY optional
//   node scripts/stirling-smoke.js
const path = require('path');
const fs = require('fs');
const { requireIsolatedDataDir } = require('./lib/isolatedDataDir');

const TEST_DEALERSHIP_NAME = 'UNIT NAVIGATOR TEST — Stirling Smoke Test (not a real business)';

async function runStirlingSmokeTest({ dataDir } = {}) {
  // Both the CLI entry point and any programmatic caller (including tests)
  // go through the SAME validation — there is no bypass. A caller-supplied
  // dataDir is validated exactly like the env var would be; the temp
  // directories tests create already follow the required naming convention,
  // so this doesn't change what a well-behaved test does, only closes the
  // gap for anything that isn't.
  const resolvedDataDir = requireIsolatedDataDir(dataDir);
  process.env.UNITNAV_DATA_DIR = resolvedDataDir;

  // Required only now, after the data directory is settled — same ordering
  // discipline as preflight-esign.js.
  const db = require('../database');
  const { buildOfficialPacket, preparePacketWithStirling } = require('../routes/paperwork');

  let row = db.prepare('SELECT id FROM dealerships WHERE name = ?').get(TEST_DEALERSHIP_NAME);
  const dealershipId = row
    ? row.id
    : db.prepare(`
        INSERT INTO dealerships (name, legal_name, representative_name, representative_email)
        VALUES (?, ?, ?, ?)
      `).run(
        TEST_DEALERSHIP_NAME,
        'UNIT NAVIGATOR TEST DEALERSHIP (not a real business)',
        'Test Representative (smoke test)',
        'test-representative@example.invalid',
      ).lastInsertRowid;

  const fixtureData = {
    dealNumber: 'STIRLING-SMOKE-TEST',
    packetType: 'cash',
    customer: { name: 'TEST CUSTOMER (Stirling smoke test)', email: 'test-customer@example.invalid' },
    vehicle: { year: 2020, make: 'TEST', model: 'SMOKE', vin: '1'.repeat(17) },
    pricing: { salePrice: 1, total: 1, amountFinanced: 0 },
    formAnswers: {},
    rules: {},
  };

  console.log('[stirling-smoke-test] generating local packet (no network call)...');
  const unflattened = await buildOfficialPacket(fixtureData, { user: { dealership_id: dealershipId } });
  console.log(`[stirling-smoke-test] generated ${unflattened.length} bytes (unflattened)`);

  console.log('[stirling-smoke-test] sending to Stirling for flattening — this script does not invoke any DocuSeal function and does not require DocuSeal configuration...');
  const flattened = await preparePacketWithStirling(unflattened, 'stirling-smoke-test.pdf');
  console.log(`[stirling-smoke-test] received ${flattened.length} bytes (flattened) from Stirling`);

  const outPath = path.join(resolvedDataDir, 'stirling-smoke-test-output.pdf');
  fs.writeFileSync(outPath, flattened);
  console.log(`[stirling-smoke-test] wrote flattened packet to ${outPath}`);
  console.log('[stirling-smoke-test] OK — Stirling flatten succeeded. No DocuSeal function was invoked by this script.');

  return { unflattenedBytes: unflattened.length, flattenedBytes: flattened.length, outputPath: outPath, dealershipId };
}

if (require.main === module) {
  runStirlingSmokeTest().catch(err => {
    console.error('[stirling-smoke-test] FAILED:', err.message);
    process.exit(1);
  });
}

module.exports = { runStirlingSmokeTest };
