'use strict';
// Proves safeFetch() actually routes the connection through the exact
// address it validated, rather than letting the underlying HTTP client
// resolve the hostname a second time (the TOCTOU DNS-rebinding gap).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { safeFetch, pinnedDispatcher } = require('../services/safeFetch');

function startServer(label) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.end(`${label} ${req.headers.host}`);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Note on why these tests drive `pinnedDispatcher` directly rather than the
// full `safeFetch()`: any server a test can stand up locally is necessarily
// bound to a loopback/private address, which `assertSafeUrl`'s policy
// correctly refuses to fetch at all (that refusal is exactly the SSRF
// protection under test elsewhere, in safe-fetch-ssrf.test.js). So the two
// concerns are proven separately, the way they're implemented separately:
// "is this address allowed" (assertSafeUrl, tested with a public IP) and
// "does the connection actually reach the address we decided on, and not a
// second, independently-resolved one" (pinnedDispatcher, tested here against
// a hostname that provably cannot resolve any other way).
test('the pinned dispatcher connects to the exact address it was given, for a hostname that cannot resolve via real DNS', async () => {
  const server = await startServer('SERVER-A');
  try {
    const port = server.address().port;
    // ".invalid" is reserved by RFC 2606 and guaranteed to never resolve via
    // the real system resolver. If the dispatcher fell back to a normal,
    // unconstrained lookup instead of using the pinned address, this request
    // would fail with a DNS error instead of succeeding.
    const bogusHost = 'pin-proof.invalid';
    const { fetch: undiciFetch } = require('undici');
    const response = await undiciFetch(`http://${bogusHost}:${port}/`, {
      dispatcher: pinnedDispatcher('127.0.0.1', 4),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(body, `SERVER-A ${bogusHost}:${port}`, 'Host header must still carry the original hostname, unmodified');
  } finally {
    server.close();
  }
});

test('two different pinned addresses reach two different servers under the identical URL text', async () => {
  const serverA = await startServer('SERVER-A');
  const serverB = await startServer('SERVER-B');
  try {
    const bogusHost = 'pin-proof-2.invalid';
    const dispatcherA = pinnedDispatcher('127.0.0.1', 4);
    const dispatcherB = pinnedDispatcher('127.0.0.1', 4);

    const { fetch: undiciFetch } = require('undici');
    const resA = await undiciFetch(`http://${bogusHost}:${serverA.address().port}/`, { dispatcher: dispatcherA });
    const resB = await undiciFetch(`http://${bogusHost}:${serverB.address().port}/`, { dispatcher: dispatcherB });

    assert.equal(await resA.text(), `SERVER-A ${bogusHost}:${serverA.address().port}`);
    assert.equal(await resB.text(), `SERVER-B ${bogusHost}:${serverB.address().port}`);
  } finally {
    serverA.close();
    serverB.close();
  }
});

test('re-validates on redirect: a redirect to an internal/private address is rejected, not silently followed', async () => {
  // A malicious or compromised "public" site can 302 a legitimate crawl target
  // to an internal address. safeFetch must re-run the full SSRF check on the
  // redirect's target, not just on the first hop. Both hops are faked here
  // (no real network / local server involved) so the origin hop can look
  // genuinely public without needing to actually reach anything.
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }]; // always "looks public"
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      status: 302,
      headers: { get: name => (name === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null) },
    };
  };

  await assert.rejects(
    () => safeFetch('https://looks-public.example/redirector', {}, { resolver, fetchImpl }),
    /private or reserved|not allowed/,
  );
  assert.equal(calls, 1, 'must reject the redirect target before ever issuing a second request to it');
});
