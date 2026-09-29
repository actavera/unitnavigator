'use strict';
// Precise guarantee under test (requiring routes/paperwork.js loads the
// whole module, which also *defines* DocuSeal-related functions — so
// claiming the script is "structurally incapable" or "never imports
// anything DocuSeal-related" would overstate it):
//   - scripts/stirling-smoke.js's own code never INVOKES a DocuSeal
//     function and never references DOCUSEAL_* configuration;
//   - a real run's every outbound HTTP request goes to the Stirling
//     endpoint's exact origin — nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('node:http');

const REPO_ROOT = path.join(__dirname, '..');

test('the smoke-test script\'s own code never invokes a DocuSeal function or references DocuSeal configuration', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'stirling-smoke.js'), 'utf8');
  // Comments (including this file's own header, and the script's own header,
  // which name createDocusealSubmission specifically to document that it's
  // absent) and reassuring console.log strings ("no DocuSeal function was
  // invoked...") legitimately mention these words — that's documentation and
  // operator-facing output, not a code reference. Strip both comments and
  // string literals; what's left is the actual executable code.
  const withoutComments = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutStrings = withoutComments.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');

  for (const identifier of ['createDocusealSubmission', 'docusealSubmissionStatus', 'archiveDocusealSubmission', 'downloadProviderFile', 'DOCUSEAL_API_KEY', 'DOCUSEAL_BASE_URL']) {
    assert.ok(!withoutStrings.includes(identifier), `the executable code must never reference the identifier "${identifier}"`);
  }
});

test('a real run\'s every outbound request goes to the Stirling endpoint\'s exact origin, never anywhere else', async () => {
  // Every resource this test might acquire, tracked so the finally block
  // below can clean up correctly no matter how far setup got before a
  // failure — including a failure during setup itself, not just during the
  // assertions.
  let stirlingServer = null;
  let tmpDir = null;
  let fetchPatched = false;
  const originalFetch = global.fetch;
  const savedEnv = {
    UNITNAV_DATA_DIR: process.env.UNITNAV_DATA_DIR,
    STIRLING_PDF_URL: process.env.STIRLING_PDF_URL,
    DOCUSEAL_API_KEY: process.env.DOCUSEAL_API_KEY,
    DOCUSEAL_BASE_URL: process.env.DOCUSEAL_BASE_URL,
  };

  try {
    stirlingServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(Buffer.from('%PDF-1.4 fake-flattened-output-for-test'));
    });
    await new Promise((resolve, reject) => {
      stirlingServer.once('error', reject);
      stirlingServer.listen(0, '127.0.0.1', resolve);
    });
    const stirlingPort = stirlingServer.address().port;
    const stirlingOrigin = new URL(`http://127.0.0.1:${stirlingPort}`).origin;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-esign-test-smoketest-'));

    const seenUrls = [];
    global.fetch = async (input, ...rest) => {
      seenUrls.push(String(input?.url ?? input));
      return originalFetch(input, ...rest);
    };
    fetchPatched = true;

    process.env.UNITNAV_DATA_DIR = tmpDir;
    process.env.STIRLING_PDF_URL = stirlingOrigin;
    // Deliberately absent: proves this path never needs, and never touches, DocuSeal config.
    delete process.env.DOCUSEAL_API_KEY;
    delete process.env.DOCUSEAL_BASE_URL;

    delete require.cache[require.resolve('../database')];
    delete require.cache[require.resolve('../routes/paperwork')];
    delete require.cache[require.resolve('../scripts/stirling-smoke')];
    const { runStirlingSmokeTest } = require('../scripts/stirling-smoke');

    // No bypass: this goes through the exact same requireIsolatedDataDir()
    // validation a CLI invocation would (tmpDir already follows the
    // required naming convention, so it passes normally).
    const result = await runStirlingSmokeTest({ dataDir: tmpDir });

    assert.ok(result.flattenedBytes > 0);
    assert.ok(fs.existsSync(result.outputPath));
    // requireIsolatedDataDir() returns the canonical (realpath'd) form,
    // which can differ from tmpDir's lexical form (e.g. macOS: /tmp is
    // itself a symlink to /private/tmp) — compare canonical to canonical.
    const canonicalTmpDir = (fs.realpathSync.native || fs.realpathSync)(tmpDir);
    assert.ok(
      result.outputPath.startsWith(canonicalTmpDir + path.sep),
      `output must be written strictly inside the isolated temp dir, got: ${result.outputPath}`,
    );

    assert.ok(seenUrls.length > 0, 'sanity: the smoke test must have made at least one outbound request (to Stirling)');
    for (const rawUrl of seenUrls) {
      const origin = new URL(rawUrl).origin;
      assert.equal(origin, stirlingOrigin, `every outbound request's origin must exactly equal the Stirling mock's origin, got: ${rawUrl}`);
    }
  } finally {
    if (fetchPatched) global.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (stirlingServer) {
      await new Promise(resolve => stirlingServer.close(resolve));
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    delete require.cache[require.resolve('../database')];
    delete require.cache[require.resolve('../routes/paperwork')];
    delete require.cache[require.resolve('../scripts/stirling-smoke')];
  }
});
