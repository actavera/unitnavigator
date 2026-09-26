'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeUrl, isNonPublicIp } = require('../services/safeFetch');

test('rejects literal loopback, link-local, and private IPv4 hosts', async () => {
  for (const url of [
    'http://127.0.0.1/x',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata endpoint
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.31.0.1/',
    'http://0.0.0.0/',
    'http://localhost/',
    'http://foo.localhost/',
  ]) {
    await assert.rejects(() => assertSafeUrl(url), undefined, `expected ${url} to be rejected`);
  }
});

test('rejects a hostname that DNS-rebinds to a private address (not just IP-literal SSRF)', async () => {
  // The vulnerable version of this check only inspected the literal hostname
  // string, so "attacker-domain.example" would sail through even though its
  // A record points at an internal address. This proves the DNS-resolution
  // path actually catches that.
  const fakeResolver = async () => [{ address: '169.254.169.254', family: 4 }];
  await assert.rejects(
    () => assertSafeUrl('http://attacker-controlled.example/photo.jpg', { resolver: fakeResolver }),
    /private or reserved/,
  );
});

test('allows a normal public hostname that resolves to a public address', async () => {
  const fakeResolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const { parsed, addresses } = await assertSafeUrl('https://example.com/photo.jpg', { resolver: fakeResolver });
  assert.equal(parsed.hostname, 'example.com');
  assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
});

test('isNonPublicIp covers the private/reserved IPv4 and IPv6 ranges', () => {
  // Original private/link-local/loopback coverage.
  assert.equal(isNonPublicIp('127.0.0.1'), true);
  assert.equal(isNonPublicIp('169.254.169.254'), true);
  assert.equal(isNonPublicIp('10.1.2.3'), true);
  assert.equal(isNonPublicIp('172.20.0.1'), true);
  assert.equal(isNonPublicIp('192.168.0.1'), true);
  assert.equal(isNonPublicIp('100.64.0.1'), true); // carrier-grade NAT
  assert.equal(isNonPublicIp('::1'), true);
  assert.equal(isNonPublicIp('fe80::1'), true);
  assert.equal(isNonPublicIp('fd00::1'), true);

  // Documentation / test networks.
  assert.equal(isNonPublicIp('192.0.2.1'), true, 'TEST-NET-1');
  assert.equal(isNonPublicIp('198.51.100.1'), true, 'TEST-NET-2');
  assert.equal(isNonPublicIp('203.0.113.1'), true, 'TEST-NET-3');
  assert.equal(isNonPublicIp('198.18.0.1'), true, 'benchmarking range');
  assert.equal(isNonPublicIp('2001:db8::1'), true, 'IPv6 documentation range');

  // Multicast / reserved / broadcast.
  assert.equal(isNonPublicIp('224.0.0.1'), true, 'multicast');
  assert.equal(isNonPublicIp('240.0.0.1'), true, 'reserved');
  assert.equal(isNonPublicIp('255.255.255.255'), true, 'broadcast');
  assert.equal(isNonPublicIp('ff02::1'), true, 'IPv6 multicast');

  // Genuinely public.
  assert.equal(isNonPublicIp('8.8.8.8'), false);
  assert.equal(isNonPublicIp('93.184.216.34'), false);
});
