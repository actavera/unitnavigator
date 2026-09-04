'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { toDocumensoPosition, createDocumensoEnvelope } = require('../routes/paperwork');

test('converts PDF point coordinates to Documenso top-left percentages', () => {
  const position = toDocumensoPosition(612, 792, { page: 4, x: 42, y: 410, w: 230, h: 24 });
  assert.equal(position.page, 4);
  assert.equal(Number(position.positionX.toFixed(2)), 6.86);
  assert.equal(Number(position.positionY.toFixed(2)), 45.20);
  assert.equal(Number(position.width.toFixed(2)), 37.58);
  assert.equal(Number(position.height.toFixed(2)), 3.03);
});

test('creates and distributes a Documenso envelope', async () => {
  const originalFetch = global.fetch;
  const originalBase = process.env.DOCUMENSO_BASE_URL;
  const originalKey = process.env.DOCUMENSO_API_KEY;
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  pdf.addPage([612, 792]);
  pdf.addPage([612, 792]);
  pdf.addPage([612, 792]);
  const bytes = Buffer.from(await pdf.save());
  const calls = [];

  process.env.DOCUMENSO_BASE_URL = 'https://sign.example.com';
  process.env.DOCUMENSO_API_KEY = 'documenso-key';
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, 'documenso-key');
    if (url.endsWith('/api/v2/envelope/create')) {
      assert.equal(options.method, 'POST');
      const payload = JSON.parse(options.body.get('payload'));
      assert.equal(payload.type, 'DOCUMENT');
      assert.equal(payload.recipients.length, 2);
      assert.equal(payload.recipients[0].email, 'buyer@example.com');
      assert.equal(payload.recipients[0].fields[0].type, 'SIGNATURE');
      assert.equal(options.body.get('files').name, 'packet.pdf');
      return new Response(JSON.stringify({ id: 'env_123', signingUrl: 'https://sign.example.com/sign/env_123' }), { status: 200 });
    }
    if (url.endsWith('/api/v2/envelope/distribute')) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { envelopeId: 'env_123', meta: { distributionMethod: 'EMAIL' } });
      return new Response(JSON.stringify({ id: 'env_123' }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const result = await createDocumensoEnvelope(bytes, 'packet.pdf', {
      customer: { name: 'Buyer Person', email: 'buyer@example.com' },
      dealer: { name: 'Dealer', email: 'dealer@example.com' },
      vehicle: { year: 2020, make: 'Ford', model: 'F-150' },
    });
    assert.equal(result.envelopeId, 'env_123');
    assert.equal(result.signingUrl, 'https://sign.example.com/sign/env_123');
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.DOCUMENSO_BASE_URL;
    else process.env.DOCUMENSO_BASE_URL = originalBase;
    if (originalKey === undefined) delete process.env.DOCUMENSO_API_KEY;
    else process.env.DOCUMENSO_API_KEY = originalKey;
  }
});
