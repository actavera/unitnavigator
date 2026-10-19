'use strict';
const router = require('express').Router();
const db = require('../database');
const reminders = require('../services/reminders');
const messaging = require('../services/messaging');
const { JWT_SECRET } = require('../middleware/auth');

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://unitnavigator.com').replace(/\/$/, '');

function parsePhotos(value) {
  try {
    const photos = JSON.parse(value || '[]');
    return Array.isArray(photos) ? photos : [];
  } catch {
    return [];
  }
}

// Everything an unauthenticated visitor can ever receive about a unit.
// This is an explicit allowlist in two layers: the SQL below selects only
// these columns, and mapUnit copies only these keys — so neither a future
// database column nor a future change to the SELECT can leak a private field
// (VIN, minimum_price, costs, stage, dealership_id, timestamps, ...) by
// accident. `notes` is included on purpose: it is the dealer-facing
// "Description" field and the showroom displays it as the vehicle
// description. `id` is required for the showroom's detail link.
const PUBLIC_UNIT_COLUMNS = ['id', 'stock_number', 'year', 'make', 'model', 'trim', 'body_style', 'color', 'mileage', 'asking_price', 'notes', 'photos'];
const PUBLIC_UNIT_SELECT = PUBLIC_UNIT_COLUMNS.join(', ');

function mapUnit(row) {
  const unit = {};
  for (const column of PUBLIC_UNIT_COLUMNS) {
    if (column !== 'photos') unit[column] = row[column] ?? null;
  }
  unit.photos = parsePhotos(row.photos);
  // Only the asking price is ever public. This previously fell back to
  // minimum_price (the dealer's private floor) when no asking price was set.
  unit.price = row.asking_price || null;
  return unit;
}

function normalizeHost(value) {
  return String(value || '')
    .toLowerCase()
    .split(',')[0]
    .trim()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

function normalizeDomain(value) {
  return normalizeHost(String(value || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
}

function dealerAddress(row) {
  return [row.address, row.city, row.zip].some(Boolean)
    ? [row.address, row.city, row.state, row.zip].filter(Boolean).join(' ')
    : '';
}

// Resolves which dealership's showroom a request is for — or none. There is
// deliberately NO fallback: a missing, unknown, disabled, or mismatched
// selection returns undefined, so no other dealership's data is ever served
// (and none is identified) by accident. Only active dealerships whose
// public_site_enabled is explicitly 1 are ever visible; NULL counts as off.
// An explicit ?dealer= / x-dealer-slug that fails to match does not fall
// through to host matching. Numeric-id lookup is kept for now, under the same
// active + explicitly-enabled restriction.
function publicDealer(req) {
  const requested = String(req.query.dealer || req.headers['x-dealer-slug'] || '').trim().toLowerCase();

  if (requested) {
    return db.prepare(`
      SELECT * FROM dealerships
      WHERE status = 'active'
        AND public_site_enabled = 1
        AND (lower(public_slug) = ? OR CAST(id AS TEXT) = ?)
      LIMIT 1
    `).get(requested, requested);
  }

  const host = normalizeHost(req.headers['x-forwarded-host'] || req.headers.host);
  if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    return db.prepare(`
      SELECT * FROM dealerships
      WHERE status = 'active'
        AND public_site_enabled = 1
        AND COALESCE(public_domain, '') != ''
    `).all().find(row => normalizeDomain(row.public_domain) === host);
  }

  return undefined;
}

function dealerPayload(row) {
  const aprOptions = String(row?.public_apr_options || '9.99,7.99,12.99,18.99')
    .split(',')
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value >= 0 && value <= 40);
  return row ? {
    id: row.id,
    slug: row.public_slug || '',
    public_domain: normalizeDomain(row.public_domain),
    logo_url: row.logo_url || '',
    name: row.legal_name || row.name || 'Dealer Inventory',
    display_name: row.name || row.legal_name || 'Dealer Inventory',
    address: dealerAddress(row),
    phone: row.phone || '',
    email: row.email || '',
    website: row.website || '',
    apr_options: aprOptions.length ? aprOptions : [9.99, 7.99, 12.99, 18.99],
  } : {
    id: null,
    slug: '',
    public_domain: '',
    logo_url: '',
    name: 'Dealer Inventory',
    display_name: 'Dealer Inventory',
    address: '',
    phone: '',
    email: '',
    website: '',
    apr_options: [9.99, 7.99, 12.99, 18.99],
  };
}

router.get('/inventory', (req, res) => {
  const dealer = publicDealer(req);
  if (!dealer) return res.json({ units: [] });

  const rows = db.prepare(`
    SELECT ${PUBLIC_UNIT_SELECT}
    FROM units
    WHERE dealership_id = ? AND stage = 'ready' AND archived_at IS NULL
    ORDER BY created_at DESC
  `).all(dealer.id);

  res.json({
    dealer: dealerPayload(dealer),
    units: rows.map(mapUnit),
  });
});

router.get('/dealer', (req, res) => {
  res.json({ dealer: dealerPayload(publicDealer(req)) });
});

router.get('/inventory/:id', (req, res) => {
  const dealer = publicDealer(req);
  if (!dealer) return res.status(404).json({ error: 'Vehicle not found' });

  const row = db.prepare(`
    SELECT ${PUBLIC_UNIT_SELECT}
    FROM units
    WHERE id = ? AND dealership_id = ? AND stage = 'ready' AND archived_at IS NULL
  `).get(req.params.id, dealer.id);

  if (!row) return res.status(404).json({ error: 'Vehicle not found' });
  res.json({ dealer: dealerPayload(dealer), unit: mapUnit(row) });
});

router.mapUnit = mapUnit;
// ── Communications webhooks (no login; verified individually) ─────────────

function xml(text) {
  return String(text).replace(/[<>&'"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
}

// Inbound SMS from Twilio. Only requests carrying a valid Twilio signature
// are processed; STOP-type keywords record an opt-out, START restores a prior
// opt-in. Nothing else is acted on.
router.post('/sms/inbound', (req, res) => {
  const params = req.body || {};
  const valid = messaging.validTwilioSignature({ url: `${PUBLIC_BASE_URL}${req.originalUrl}`, params, signature: req.headers['x-twilio-signature'] });
  if (!valid) return res.status(403).type('text/plain').send('Forbidden');
  const reply = reminders.handleInboundSms(db, { from: params.From, body: params.Body });
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${reply ? `<Message>${xml(reply)}</Message>` : ''}</Response>`);
});

// One-click email unsubscribe from a reminder's signed link.
function unsubscribe(req, res) {
  const dealershipId = Number(req.query.d);
  const customerId = Number(req.query.c);
  const ok = Number.isInteger(dealershipId) && Number.isInteger(customerId)
    && reminders.validUnsubscribeToken(JWT_SECRET, dealershipId, customerId, req.query.t)
    && db.prepare('SELECT 1 FROM customers WHERE id = ? AND dealership_id = ?').get(customerId, dealershipId);
  if (!ok) return res.status(400).type('html').send('<!doctype html><meta charset="utf-8"><title>Unsubscribe</title><p>This unsubscribe link is not valid.</p>');
  reminders.recordConsent(db, { dealershipId, customerId, channel: 'email', status: 'opted_out', source: 'email_unsubscribe' });
  res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title><p style="font-family:sans-serif;padding:24px;">You have been unsubscribed from these reminder emails.</p>');
}
router.get('/unsubscribe', unsubscribe);
router.post('/unsubscribe', unsubscribe);

router.PUBLIC_UNIT_COLUMNS = PUBLIC_UNIT_COLUMNS;

module.exports = router;
