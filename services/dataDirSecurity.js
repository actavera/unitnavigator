'use strict';
// Keeps the SQLite data directory private to the runtime account.
//
// Design (narrow on purpose): protect `data/` with a 0700 directory and the
// database files with 0600 — never a process-wide umask. A restrictive global
// umask would also change the mode of every unrelated file the process
// creates (uploaded photos served from public/uploads, for instance).
//
// The WAL and shared-memory files need no separate handling: SQLite creates
// `-wal`, `-shm` and `-journal` with the same permissions as the main database
// file, so once the main file is 0600, every file SQLite recreates after a
// restart or reboot is 0600 as well. These helpers are re-run on every start
// (database.js) and as a final gate before the server accepts traffic
// (server.js), so a loosened mode is repaired, and an unfixable one stops the
// process instead of serving.
const fs = require('fs');

const DB_FILE_SUFFIXES = ['', '-wal', '-shm', '-journal'];
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GROUP_AND_OTHER = 0o077;

class DataDirSecurityError extends Error {}

// Permission bits are meaningful only on POSIX systems.
function enforced() {
  return process.platform !== 'win32' && typeof process.getuid === 'function';
}

function fail(message) {
  throw new DataDirSecurityError(`Data directory security check failed: ${message}`);
}

function requireOwnedByRuntimeAccount(stat, target) {
  if (stat.uid !== process.getuid()) {
    fail(`${target} is owned by uid ${stat.uid}, not the runtime account (uid ${process.getuid()}). Refusing to start rather than run with a data directory another account controls.`);
  }
}

// Creates the directory if needed and makes it exactly 0700. Refuses a
// directory owned by anyone other than the runtime account, since chmod
// could not secure it and another account would still control it.
function ensurePrivateDataDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (!enforced()) return;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) fail(`${dir} is not a directory`);
  requireOwnedByRuntimeAccount(stat, dir);
  if ((stat.mode & 0o777) !== PRIVATE_DIR_MODE) fs.chmodSync(dir, PRIVATE_DIR_MODE);
}

// Removes group/other access from the database, WAL, SHM and journal files
// that currently exist. Call it before opening (files left by an older
// deployment), after opening but before enabling WAL (so the files SQLite
// creates next inherit 0600), and again afterwards.
function ensurePrivateDbFiles(dbPath) {
  if (!enforced()) return;
  for (const suffix of DB_FILE_SUFFIXES) {
    const file = dbPath + suffix;
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`${file} is not a regular file`);
    requireOwnedByRuntimeAccount(stat, file);
    if (stat.mode & GROUP_AND_OTHER) fs.chmodSync(file, PRIVATE_FILE_MODE);
  }
}

// Verification only: throws unless the directory and every existing database
// file are free of group/other access and owned by the runtime account.
function assertPrivate(dir, dbPath) {
  if (!enforced()) return;
  const dirStat = fs.statSync(dir);
  requireOwnedByRuntimeAccount(dirStat, dir);
  if (dirStat.mode & GROUP_AND_OTHER) {
    fail(`${dir} is accessible to group/other (mode ${(dirStat.mode & 0o777).toString(8)}); expected 700`);
  }
  for (const suffix of DB_FILE_SUFFIXES) {
    const file = dbPath + suffix;
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    requireOwnedByRuntimeAccount(stat, file);
    if (stat.mode & GROUP_AND_OTHER) {
      fail(`${file} is accessible to group/other (mode ${(stat.mode & 0o777).toString(8)}); expected 600`);
    }
  }
}

module.exports = {
  DataDirSecurityError,
  DB_FILE_SUFFIXES,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateDataDir,
  ensurePrivateDbFiles,
  assertPrivate,
};
