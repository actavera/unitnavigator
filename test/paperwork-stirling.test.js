'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { preparePacketWithStirling } = require('../routes/paperwork');

test('sends the packet to Stirling for form flattening before e-sign', async () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.STIRLING_PDF_URL;
  const input = Buffer.from('%PDF-test');
  process.env.STIRLING_PDF_URL = 'http://127.0.0.1:8085/';
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8085/api/v1/misc/flatten');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('flattenOnlyForms'), 'true');
    assert.equal(options.body.get('fileInput').name, 'packet.pdf');
    return new Response(input, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  };
  try {
    assert.deepEqual(await preparePacketWithStirling(input, 'packet.pdf'), input);
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.STIRLING_PDF_URL;
    else process.env.STIRLING_PDF_URL = originalUrl;
  }
});
