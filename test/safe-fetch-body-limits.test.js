'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readBodyWithLimit } = require('../services/safeFetch');
const { fetch: undiciFetch } = require('undici');

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('rejects immediately on an excessive declared Content-Length, without reading the body', async () => {
  let bytesSent = 0;
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '999999999', 'Content-Type': 'text/plain' });
    // Intentionally never actually sends 999999999 bytes; if the guard reads
    // the header and rejects immediately, the connection should be aborted
    // long before we'd finish streaming a body that size.
    const interval = setInterval(() => {
      bytesSent += 1024;
      res.write('x'.repeat(1024));
    }, 5);
    req.on('close', () => clearInterval(interval));
    res.on('close', () => clearInterval(interval));
  });
  try {
    const res = await undiciFetch(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(() => readBodyWithLimit(res, 1024), /declared .* bytes/);
    assert.ok(bytesSent < 1024 * 50, 'should not have streamed a large amount before rejecting on the header');
  } finally {
    server.close();
  }
});

test('aborts mid-stream when actual bytes exceed the limit despite a false/absent Content-Length', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); // no Content-Length: chunked transfer
    const chunk = 'a'.repeat(1024);
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= 20 * 1024) { clearInterval(interval); res.end(); return; }
      res.write(chunk);
      sent += chunk.length;
    }, 1);
    req.on('close', () => clearInterval(interval));
  });
  try {
    const res = await undiciFetch(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(() => readBodyWithLimit(res, 5 * 1024), /exceeded the .* limit while streaming/);
  } finally {
    server.close();
  }
});

test('accepts a body within the limit and returns its exact bytes', async () => {
  const payload = 'hello world';
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(Buffer.byteLength(payload)) });
    res.end(payload);
  });
  try {
    const res = await undiciFetch(`http://127.0.0.1:${server.address().port}/`);
    const buf = await readBodyWithLimit(res, 1024);
    assert.equal(buf.toString('utf8'), payload);
  } finally {
    server.close();
  }
});
