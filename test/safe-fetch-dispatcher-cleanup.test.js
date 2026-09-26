'use strict';
// Proves the one-shot undici Agent (and its socket) created per request/
// redirect hop is never leaked, across every path: normal consumption, an
// oversized streamed body, a redirect hop, and the caller aborting/erroring
// mid-read.
//
// Two proof styles are used, deliberately:
//  - For the primitives that actually touch the network (releaseResponse,
//    readBodyWithLimit), the proof is a REAL server socket closing — the
//    thing that would actually leak in production if this were wrong.
//  - For safeFetch()'s redirect-loop CONTROL FLOW (does it call
//    releaseResponse on every intermediate hop before requesting the next
//    one?), the proof is the real, live undici Agent's own `.destroyed`
//    state, captured via the existing `fetchImpl` injection point — this
//    avoids the unavoidable conflict where any server a test can stand up
//    locally is on a private address, which safeFetch's own SSRF policy
//    (correctly, and separately tested) refuses to fetch in the first place.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { safeFetch, readBodyWithLimit, releaseResponse, pinnedDispatcher } = require('../services/safeFetch');
const { fetch: undiciFetch } = require('undici');

function trackedServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return { server, sockets };
}

async function waitForNoOpenSockets(sockets, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (sockets.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(sockets.size, 0, `expected no open sockets, but ${sockets.size} remained after ${timeoutMs}ms`);
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

// Fetches a local test server the same way safeFetch's internals do (a
// pinned dispatcher + manual redirect handling), without going through
// assertSafeUrl's public-address policy — that policy is what's under test
// in safe-fetch-ssrf.test.js, not here.
async function fetchLocal(port) {
  const dispatcher = pinnedDispatcher('127.0.0.1', 4);
  const response = await undiciFetch(`http://cleanup-test.invalid:${port}/`, { dispatcher, redirect: 'manual' });
  response.__dispatcher = dispatcher;
  return response;
}

test('releaseResponse/readBodyWithLimit close the real socket after successful body consumption', async () => {
  const { server, sockets } = trackedServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '5' });
    res.end('hello');
  });
  const port = await listen(server);
  try {
    const response = await fetchLocal(port);
    const buf = await readBodyWithLimit(response, 1024);
    assert.equal(buf.toString('utf8'), 'hello');
    assert.equal(response.__dispatcher.destroyed, true);
    await waitForNoOpenSockets(sockets);
  } finally {
    server.close();
  }
});

test('readBodyWithLimit closes the real socket when the streamed body is rejected for exceeding the size limit', async () => {
  const { server, sockets } = trackedServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); // no Content-Length: chunked
    const chunk = 'a'.repeat(1024);
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= 50 * 1024 || res.destroyed) { clearInterval(interval); try { res.end(); } catch {} return; }
      res.write(chunk);
      sent += chunk.length;
    }, 1);
    req.on('close', () => clearInterval(interval));
  });
  const port = await listen(server);
  try {
    const response = await fetchLocal(port);
    await assert.rejects(() => readBodyWithLimit(response, 4 * 1024), /exceeded the .* limit/);
    assert.equal(response.__dispatcher.destroyed, true);
    await waitForNoOpenSockets(sockets);
  } finally {
    server.close();
  }
});

test('releaseResponse closes the real socket when the caller decides not to read the body at all', async () => {
  const { server, sockets } = trackedServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain', 'Content-Length': '2' });
    res.end('no');
  });
  const port = await listen(server);
  try {
    const response = await fetchLocal(port);
    assert.equal(response.status, 503);
    // Mirrors saveRemotePhoto's !response.ok early-return path: never touches the body.
    await releaseResponse(response);
    assert.equal(response.__dispatcher.destroyed, true);
    await waitForNoOpenSockets(sockets);
  } finally {
    server.close();
  }
});

test('readBodyWithLimit closes the real socket when the caller aborts mid-stream', async () => {
  const { server, sockets } = trackedServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const interval = setInterval(() => {
      if (res.destroyed) return clearInterval(interval);
      res.write('x'.repeat(1024));
    }, 5);
    req.on('close', () => clearInterval(interval));
    res.on('close', () => clearInterval(interval));
  });
  const port = await listen(server);
  try {
    const dispatcher = pinnedDispatcher('127.0.0.1', 4);
    const controller = new AbortController();
    const response = await undiciFetch(`http://cleanup-abort.invalid:${port}/`, {
      dispatcher,
      redirect: 'manual',
      signal: controller.signal,
    });
    response.__dispatcher = dispatcher;
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(() => readBodyWithLimit(response, 10 * 1024 * 1024));
    assert.equal(response.__dispatcher.destroyed, true);
    await waitForNoOpenSockets(sockets);
  } finally {
    server.close();
  }
});

test('safeFetch destroys each intermediate redirect hop\'s dispatcher immediately, and the final hop\'s only once the caller consumes the body', async () => {
  // Nothing here touches a real network: fetchImpl is fully mocked, so the
  // resolver's "address" is never actually connected to. What's real is the
  // pinnedDispatcher Agent that safeFetch's own code constructs for each hop
  // — its `.destroyed` flag is the genuine, load-bearing proof that
  // safeFetch's redirect-loop calls releaseResponse (which awaits
  // dispatcher.destroy()) on hop 1 before ever requesting hop 2.
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const dispatchersSeen = [];
  let call = 0;
  const fetchImpl = async (_url, opts) => {
    call += 1;
    dispatchersSeen.push(opts.dispatcher);
    if (call === 1) {
      return {
        status: 302,
        headers: { get: name => (name === 'location' ? 'https://redirect-target.example/final' : null) },
        body: null,
      };
    }
    return {
      status: 200,
      headers: { get: name => (name === 'content-length' ? '5' : null) },
      body: null,
      arrayBuffer: async () => Buffer.from('hello', 'utf8'),
    };
  };

  const response = await safeFetch('https://redirect-origin.example/start', {}, { resolver, fetchImpl });
  assert.equal(call, 2, 'expected exactly one redirect hop followed by the final request');
  assert.equal(dispatchersSeen[0].destroyed, true, 'the intermediate redirect hop\'s dispatcher must already be destroyed');
  assert.equal(dispatchersSeen[1].destroyed, false, 'the final hop\'s dispatcher must still be alive until the caller reads the body');

  const buf = await readBodyWithLimit(response, 1024);
  assert.equal(buf.toString('utf8'), 'hello');
  assert.equal(dispatchersSeen[1].destroyed, true, 'the final hop\'s dispatcher must be destroyed once the body is consumed');
});
