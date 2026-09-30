#!/usr/bin/env node
'use strict';
// Deletes EXACTLY the integration-test data directory it's pointed at — and
// nothing else. Reuses the same validator as preflight-esign.js and
// stirling-smoke.js, so this can only ever target a path that already
// passed the "isolated, uniquely-named, real (non-symlink) directory,
// outside the repo/production/home" check. Deliberately has no
// recursive/broad delete fallback, and re-runs the full validation a SECOND
// time immediately before the actual delete, closing the window between an
// initial check and the delete itself (e.g. something replacing the
// directory with a symlink in between).
//
// Usage:
//   UNITNAV_DATA_DIR=<the exact test directory> node scripts/cleanup-esign-test-dir.js
const fs = require('fs');
const { requireIsolatedDataDir, IsolatedDataDirError } = require('./lib/isolatedDataDir');

function main() {
  let target;
  try {
    target = requireIsolatedDataDir();
  } catch (err) {
    if (err instanceof IsolatedDataDirError) {
      console.error(`[cleanup-esign-test-dir] REFUSED: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`[cleanup-esign-test-dir] Validated target: ${target}`);

  // Re-validate immediately before deleting. requireIsolatedDataDir() itself
  // re-lstats and re-canonicalizes from scratch, so this closes the TOCTOU
  // gap between the check above and the delete below.
  let targetAtDeleteTime;
  try {
    targetAtDeleteTime = requireIsolatedDataDir();
  } catch (err) {
    if (err instanceof IsolatedDataDirError) {
      console.error(`[cleanup-esign-test-dir] REFUSED at delete time: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Belt-and-suspenders explicit re-check right at the point of deletion,
  // even though requireIsolatedDataDir() already guarantees this internally.
  const lstat = fs.lstatSync(targetAtDeleteTime);
  if (lstat.isSymbolicLink()) {
    console.error(`[cleanup-esign-test-dir] REFUSED: ${targetAtDeleteTime} is a symbolic link at deletion time. Refusing to delete through a symlink.`);
    process.exit(1);
  }
  if (!lstat.isDirectory()) {
    console.error(`[cleanup-esign-test-dir] REFUSED: ${targetAtDeleteTime} is not a directory at deletion time.`);
    process.exit(1);
  }
  if (targetAtDeleteTime !== target) {
    console.error(`[cleanup-esign-test-dir] REFUSED: the canonical path changed between the two validation passes (${target} -> ${targetAtDeleteTime}). Refusing as a precaution.`);
    process.exit(1);
  }

  console.log(`[cleanup-esign-test-dir] Deleting exactly this directory and nothing else:\n  ${targetAtDeleteTime}`);
  fs.rmSync(targetAtDeleteTime, { recursive: true, force: true });
  console.log('[cleanup-esign-test-dir] Done. (DocuSeal-side cleanup, if any, is separate — see the runbook.)');
}

main();
