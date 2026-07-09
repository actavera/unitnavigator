'use strict';
const router = require('express').Router();
const db = require('../database');

function parsePhotos(value) {
  try {
    const photos = JSON.parse(value || '[]');
    return Array.isArray(photos) ? photos : [];
  } catch {
    return [];
  }
}

function mapUnit(row) {
  return {
    ...row,
    photos: parsePhotos(row.photos),
    price: row.asking_price || row.minimum_price || null,
  };
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

function publicDealer(req) {
  const requested = String(req.query.dealer || '').trim().toLowerCase();
  const host = normalizeHost(req.headers['x-forwarded-host'] || req.headers.host);

  if (requested) {
    const bySlug = db.prepare(`
      SELECT * FROM dealerships
      WHERE status = 'active'
        AND COALESCE(public_site_enabled, 1) = 1
        AND (lower(public_slug) = ? OR CAST(id AS TEXT) = ?)
      LIMIT 1
    `).get(requested, requested);
    if (bySlug) return bySlug;
  }

  if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    const byDomain = db.prepare(`
      SELECT * FROM dealerships
      WHERE status = 'active'
        AND COALESCE(public_site_enabled, 1) = 1
        AND COALESCE(public_domain, '') != ''
    `).all().find(row => normalizeDomain(row.public_domain) === host);
    if (byDomain) return byDomain;
  }

  return db.prepare(`
    SELECT * FROM dealerships
    WHERE status = 'active' AND COALESCE(public_site_enabled, 1) = 1
    ORDER BY id
    LIMIT 1
  `).get();
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

  let rows = db.prepare(`
    SELECT id, vin, stock_number, year, make, model, trim, body_style, color, mileage, asking_price, minimum_price, photos, stage
    FROM units
    WHERE dealership_id = ? AND stage = 'ready' AND archived_at IS NULL
    ORDER BY created_at DESC
  `).all(dealer.id);

  if (!rows.length) {
    rows = db.prepare(`
      SELECT id, vin, stock_number, year, make, model, trim, body_style, color, mileage, asking_price, minimum_price, photos, stage
      FROM units
      WHERE dealership_id = ? AND stage NOT IN ('sold','archived') AND archived_at IS NULL
      ORDER BY created_at DESC
      LIMIT 24
    `).all(dealer.id);
  }

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
    SELECT id, vin, stock_number, year, make, model, trim, body_style, color, mileage, asking_price, minimum_price, photos, stage
    FROM units
    WHERE id = ? AND dealership_id = ? AND stage NOT IN ('sold','archived') AND archived_at IS NULL
  `).get(req.params.id, dealer.id);

  if (!row) return res.status(404).json({ error: 'Vehicle not found' });
  res.json({ dealer: dealerPayload(dealer), unit: mapUnit(row) });
});

module.exports = router;
