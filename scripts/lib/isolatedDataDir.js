'use strict';
// Shared safety gate for every script that touches an integration-test data
// directory (preflight, the Stirling smoke test, cleanup). This must be
// satisfied BEFORE database.js is ever required — database.js creates its
// data directory (and opens/creates the SQLite file in it) as a side effect
// of being loaded, so validating the path has to happen first, with zero
// fallback to any default.
//
// Throws (rather than calling process.exit) so it's a pure, unit-testable
// function; every CLI entry point that uses it is responsible for catching
// and exiting itself.
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

class IsolatedDataDirError extends Error {}

function isPathWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolves a path to its canonical, symlink-free form for comparison
// purposes. Falls back to the lexical path.resolve() if the path doesn't
// exist (a nonexistent path can't itself be a symlink to something else, so
// this is safe — it only matters for paths we're checking as *banned
// targets*, never for the directory being validated, which must exist).
function canonicalOrLexical(p) {
  const lexical = path.resolve(p);
  try {
    return (fs.realpathSync.native || fs.realpathSync)(lexical);
  } catch {
    return lexical;
  }
}

// Resolves and validates UNITNAV_DATA_DIR for integration-test use. The
// directory must already exist (created directly by `mktemp -d`, never by
// this function) as a real directory — not a symlink, which could point
// anywhere, including the repository or a production directory, entirely
// undetectable by a purely lexical path check. Every check below runs
// against the fully-resolved (realpath'd) canonical path, so a symlink
// anywhere in a parent path component is caught too, not just a symlink at
// the leaf.
//
// Throws IsolatedDataDirError with a specific, actionable message on any
// failure. Returns the canonical validated path on success.
function requireIsolatedDataDir(envValue = process.env.UNITNAV_DATA_DIR) {
  const fail = message => {
    throw new IsolatedDataDirError(message);
  };

  if (!envValue || !String(envValue).trim()) {
    fail(
      'UNITNAV_DATA_DIR must be set explicitly to a dedicated integration-test directory that already exists. There is no default — ' +
      'this deliberately never falls back to the repository\'s data/ directory. Example:\n' +
      '  export UNITNAV_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/unitnav-esign-test-XXXXXX")"',
    );
  }

  const lexicallyResolved = path.resolve(String(envValue).trim());

  // Must already exist, as a real (non-symlink) directory. This function
  // never creates it — that's the caller's job, via mktemp -d, precisely so
  // there's a real filesystem object here to lstat and realpath, not just a
  // string we're hoping is safe.
  let lstat;
  try {
    lstat = fs.lstatSync(lexicallyResolved);
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(
        `UNITNAV_DATA_DIR (${lexicallyResolved}) does not exist. Create it first, e.g.:\n` +
        '  export UNITNAV_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/unitnav-esign-test-XXXXXX")"',
      );
    }
    fail(`UNITNAV_DATA_DIR (${lexicallyResolved}) could not be inspected: ${err.message}`);
  }

  if (lstat.isSymbolicLink()) {
    fail(
      `UNITNAV_DATA_DIR (${lexicallyResolved}) is a symbolic link. Refusing — a symlink could point anywhere, including the ` +
      'repository or a production directory, without that being visible from the path text alone. Use a real directory created directly by mktemp -d.',
    );
  }

  if (!lstat.isDirectory()) {
    fail(`UNITNAV_DATA_DIR (${lexicallyResolved}) exists but is not a directory.`);
  }

  // Canonicalize. Every check from here on applies to THIS path, never the
  // lexical one, so a symlink in a parent component (not just the leaf,
  // already refused above) can't sneak a banned target past the checks.
  let resolved;
  try {
    resolved = (fs.realpathSync.native || fs.realpathSync)(lexicallyResolved);
  } catch (err) {
    fail(`UNITNAV_DATA_DIR (${lexicallyResolved}) could not be canonicalized: ${err.message}`);
  }

  const tmpRoot = canonicalOrLexical(os.tmpdir());
  const home = os.homedir() ? canonicalOrLexical(os.homedir()) : null;
  const prodDir = canonicalOrLexical('/var/www/unitnavigator');
  const repoDataDir = canonicalOrLexical(path.join(REPO_ROOT, 'data'));
  const repoRoot = canonicalOrLexical(REPO_ROOT);

  // Exact-match-only bans: containment is meaningless for the filesystem
  // root (every path is "within" it), and only the home directory itself is
  // banned, not everything under it (a legitimate temp root can be nested
  // under the home directory on some systems).
  const exactBans = [['filesystem root', '/']];
  if (home) exactBans.push(['a home directory', home]);
  for (const [label, banned] of exactBans) {
    if (resolved === banned) {
      fail(`UNITNAV_DATA_DIR (${resolved}) is exactly ${label}. Use a dedicated directory instead.`);
    }
  }

  // Containment bans: refuse the path itself AND anything nested under it.
  // Deliberately does NOT ban "/var" or "/var/www" as broad prefixes — on
  // macOS, os.tmpdir() itself resolves under /var/folders/..., which is
  // exactly the legitimate temp root this function requires paths to be
  // under below. The specific production directory is still banned.
  const containmentBans = [
    ['the production deployment directory', prodDir],
    ["the repository's own data directory", repoDataDir],
    ['the repository root', repoRoot],
  ];
  for (const [label, banned] of containmentBans) {
    if (resolved === banned || isPathWithin(banned, resolved)) {
      fail(`UNITNAV_DATA_DIR (${resolved}) resolves to or inside ${label} (${banned}). Use a dedicated directory instead.`);
    }
  }

  const segments = resolved.split(path.sep).filter(Boolean);
  if (segments.length <= 2) {
    fail(`UNITNAV_DATA_DIR (${resolved}) has too few path segments to be a dedicated test directory — this looks too broad.`);
  }

  if (!isPathWithin(tmpRoot, resolved)) {
    fail(`UNITNAV_DATA_DIR must be a uniquely-named directory beneath the system temp directory (${tmpRoot}). Got: ${resolved}`);
  }

  const leaf = path.basename(resolved);
  if (!/^unitnav-esign-test-.{4,}$/i.test(leaf)) {
    fail(
      `UNITNAV_DATA_DIR's leaf directory name ("${leaf}") doesn't look like a uniquely-generated integration-test directory. ` +
      'Expected a name matching unitnav-esign-test-<unique suffix>, e.g. from:\n' +
      '  export UNITNAV_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/unitnav-esign-test-XXXXXX")"',
    );
  }

  return resolved;
}

module.exports = { requireIsolatedDataDir, IsolatedDataDirError, isPathWithin, canonicalOrLexical, REPO_ROOT };
