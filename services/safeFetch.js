'use strict';
// Outbound HTTP fetch guard against SSRF. Anything in inventory.js that fetches a
// dealer- or import-supplied URL (photo URLs, inventory website crawler) must go
// through this so an attacker can't reach internal/cloud-metadata hosts by
// hostname string tricks, DNS rebinding, or an open redirect.
//
// DNS-rebinding closure: it is not enough to resolve the hostname, check the
// address, and then let a plain fetch() resolve it AGAIN to make the actual
// connection — an attacker's DNS server can answer the first (checked) lookup
// with a public IP and the second (connection) lookup, moments later, with an
// internal one. So every request here is made through an undici Agent whose
// connector `lookup` is pinned to return only the exact address we already
// validated; the real system resolver is never consulted a second time for
// that request. The Host header and TLS SNI are untouched, because undici
// derives both from the request URL's hostname, not from the resolved address.
//
// Resource lifecycle: a fresh Agent is created for every request/redirect hop
// and is never reused, so each one must be explicitly torn down or its
// keep-alive socket/timers leak. Every code path here — a normal response, a
// redirect hop, a size-limit rejection, or the caller aborting/erroring while
// reading the body — must end in exactly one dispatcher teardown.
const dns = require('dns');
const net = require('net');
const { Agent, fetch: undiciFetch } = require('undici');

const lookup = dns.promises.lookup;

function isNonPublicIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b, c] = parts;
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT (RFC6598)
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 (documentation)
    if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking (RFC2544)
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 (documentation)
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 (documentation)
    if (a >= 224) return true; // 224-239 multicast, 240-255 reserved, 255.255.255.255 broadcast
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length);
      if (net.isIP(mapped) === 4) return isNonPublicIp(mapped);
    }
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
    if (/^ff[0-9a-f]{2}:/.test(lower)) return true; // multicast ff00::/8
    if (lower.startsWith('2001:db8:') || lower.startsWith('2001:0db8:')) return true; // documentation (RFC3849)
    if (lower.startsWith('64:ff9b:1:')) return true; // IPv4-IPv6 translation for local use (RFC8215)
    return false;
  }
  return true; // unparseable -> treat as unsafe
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal') return true;
  return false;
}

// Resolves + validates a URL's host, returning the parsed URL plus the exact
// address list that was checked (so the caller can pin the connection to one
// of them instead of re-resolving).
async function assertSafeUrl(urlString, { resolver = lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error('That host is not allowed');
  }
  if (net.isIP(parsed.hostname)) {
    if (isNonPublicIp(parsed.hostname)) throw new Error('That address is not allowed');
    const family = net.isIP(parsed.hostname);
    return { parsed, addresses: [{ address: parsed.hostname, family }] };
  }
  let addresses;
  try {
    addresses = await resolver(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Could not resolve host');
  }
  if (!addresses.length || addresses.some(entry => isNonPublicIp(entry.address))) {
    throw new Error('That host resolves to a private or reserved address and is not allowed');
  }
  return { parsed, addresses };
}

// An Agent whose connector is pinned to exactly one already-validated address:
// no DNS lookup for this request will ever consult the real resolver again.
function pinnedDispatcher(address, family) {
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options && options.all) return callback(null, [{ address, family }]);
        callback(null, address, family);
      },
    },
  });
}

// Cancels the response body (if not already consumed/locked) and forcefully
// tears down the one-shot dispatcher that served it. Safe to call more than
// once, and safe to call whether or not the body was ever read.
async function releaseResponse(response) {
  try {
    if (response?.body && typeof response.body.cancel === 'function' && !response.body.locked) {
      await response.body.cancel().catch(() => {});
    }
  } catch { /* stream already in a terminal state */ }
  try {
    await response?.__dispatcher?.destroy();
  } catch { /* already destroyed */ }
}

// Reads a Response body up to maxBytes, rejecting immediately on an excessive
// declared Content-Length and aborting mid-stream if the actual bytes exceed
// the limit (a server can lie about, or omit, Content-Length). Always tears
// down the response's dispatcher before returning or throwing.
async function readBodyWithLimit(response, maxBytes) {
  try {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Response declared ${declared} bytes, over the ${maxBytes}-byte limit`);
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`Response body exceeded the ${maxBytes}-byte limit`);
      return buf;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel('size limit exceeded').catch(() => {});
          throw new Error(`Response body exceeded the ${maxBytes}-byte limit while streaming`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released by cancel() */ }
    }
    return Buffer.concat(chunks, total);
  } finally {
    await releaseResponse(response);
  }
}

// fetch() that: (1) validates the URL isn't pointed at an internal/private
// address, (2) pins the actual connection to one of the validated addresses
// so a second, unconstrained DNS resolution can't rebind it, (3) re-does both
// of those on every redirect hop, up to a cap, and (4) tears down every
// intermediate hop's dispatcher immediately, leaving only the final response's
// dispatcher alive for the caller to release (via readBodyWithLimit or
// releaseResponse) once it's done with the body.
async function safeFetch(urlString, options = {}, { resolver = lookup, maxRedirects = 5, fetchImpl = undiciFetch } = {}) {
  let currentUrl = urlString;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const { parsed, addresses } = await assertSafeUrl(currentUrl, { resolver });
    const pick = addresses[0];
    const dispatcher = pinnedDispatcher(pick.address, pick.family);
    let response;
    try {
      response = await fetchImpl(parsed.href, { ...options, redirect: 'manual', dispatcher });
    } catch (err) {
      try { await dispatcher.destroy(); } catch { /* already destroyed */ }
      throw err;
    }

    const location = [301, 302, 303, 307, 308].includes(response.status)
      ? response.headers.get('location')
      : null;
    if (location) {
      // Not the final response: drain/cancel its body and tear down this
      // hop's dispatcher before ever requesting the next one.
      await releaseResponse({ body: response.body, __dispatcher: dispatcher });
      currentUrl = new URL(location, parsed).href;
      continue;
    }

    response.__dispatcher = dispatcher;
    return response;
  }
  throw new Error('Too many redirects');
}

module.exports = {
  safeFetch,
  assertSafeUrl,
  readBodyWithLimit,
  releaseResponse,
  isNonPublicIp,
  isBlockedHostname,
  pinnedDispatcher,
};
