#!/usr/bin/env node
'use strict';
// Consistent online backup of the Unit Navigator SQLite database.
//
//   node scripts/backup-db.js <backup-dir> [--keep 14]
//
// Uses SQLite's backup API (safe while the app is running, WAL included),
// writes `unitnavigator-YYYYMMDD-HHMMSS.db` with mode 0600 into a 0700
// directory, verifies the copy with an integrity check, and deletes backups
// beyond the newest `--keep` (default 14). Run as the account that owns
// data/ (root on the droplet), e.g. nightly from root's crontab. Copy the
// directory off the droplet for disaster recovery.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--'));
const keepIdx = args.indexOf('--keep');
const keep = keepIdx >= 0 ? Math.max(1, Number(args[keepIdx + 1]) || 14) : 14;
if (!dir) { console.error('usage: node scripts/backup-db.js <backup-dir> [--keep N]'); process.exit(2); }

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const dataDir = process.env.UNITNAV_DATA_DIR || path.join(__dirname, '..', 'data');
const source = path.join(dataDir, 'unitnavigator.db');

(async () => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const target = path.join(dir, `unitnavigator-${stamp}.db`);
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
  fs.chmodSync(target, 0o600);
  const check = new Database(target, { readonly: true });
  const result = check.pragma('integrity_check', { simple: true });
  check.close();
  if (result !== 'ok') { console.error(`Backup integrity check failed: ${result}`); process.exit(1); }
  const backups = fs.readdirSync(dir).filter(f => /^unitnavigator-\d{8}-\d{6}\.db$/.test(f)).sort();
  backups.slice(0, Math.max(0, backups.length - keep)).forEach(f => fs.unlinkSync(path.join(dir, f)));
  console.log(`Backup written: ${target} (integrity ok; keeping ${Math.min(keep, backups.length)})`);
})().catch(err => { console.error(`Backup failed: ${err.message}`); process.exit(1); });
