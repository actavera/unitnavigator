'use strict';
// Small, dependency-free HTTP hardening: security headers, a fixed-window
// rate limiter for unauthenticated entry points, and a JSON error handler
// that never exposes internals.

// Pages use inline scripts and handlers, so scripts and styles allow
// 'unsafe-inline'; everything else is locked to this origin, except Google
// Fonts (imported by the stylesheet). Remote images are allowed for listing photos.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  // Paperwork previews generated PDFs in an iframe from a blob: URL.
  "frame-src 'self' blob:",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function securityHeaders({ production = process.env.NODE_ENV === 'production' } = {}) {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

// In-memory fixed-window limiter (single process under PM2 fork mode).
// `key(req)` picks what is counted; the window resets after `windowMs`.
function rateLimit({ windowMs, max, key = req => req.ip, message = 'Too many requests. Please wait and try again.' }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60000));
  sweep.unref();
  const limiter = (req, res, next) => {
    // The automated suite opens many sessions from one address; it opts back
    // in with UNITNAV_TEST_RATE_LIMITS=1 to test the limiter itself.
    if (process.env.NODE_ENV === 'test' && process.env.UNITNAV_TEST_RATE_LIMITS !== '1') return next();
    const now = Date.now();
    const k = String(key(req) || 'unknown');
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + windowMs }; hits.set(k, entry); }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
  limiter.reset = () => hits.clear();
  return limiter;
}

// Last-resort error handler: malformed or oversized bodies get a 4xx, and
// anything else a generic 500. Details go to the server log only.
function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ error: 'Malformed request body' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large' });
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err && err.message);
  res.status(500).json({ error: 'Something went wrong' });
}

// Production refuses to start with a weak signing secret.
function validateProductionEnv(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  if (!env.JWT_SECRET || String(env.JWT_SECRET).length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters in production.');
  }
}

module.exports = { securityHeaders, rateLimit, errorHandler, validateProductionEnv, CSP };
