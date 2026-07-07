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

router.get('/inventory', (_req, res) => {
  let rows = db.prepare(`
    SELECT id, vin, year, make, model, trim, body_style, color, mileage, asking_price, minimum_price, photos, stage
    FROM units
    WHERE stage = 'ready' AND archived_at IS NULL
    ORDER BY created_at DESC
  `).all();

  if (!rows.length) {
    rows = db.prepare(`
      SELECT id, vin, year, make, model, trim, body_style, color, mileage, asking_price, minimum_price, photos, stage
      FROM units
      WHERE stage NOT IN ('sold','archived') AND archived_at IS NULL
      ORDER BY created_at DESC
      LIMIT 24
    `).all();
  }

  res.json({
    units: rows.map(mapUnit),
  });
});

router.get('/dealer', (_req, res) => {
  const row = db.prepare(`
    SELECT name, legal_name, address, city, state, zip, phone, email, website
    FROM dealerships
    WHERE status = 'active'
    ORDER BY id
    LIMIT 1
  `).get();
  res.json({
    dealer: row ? {
      name: row.legal_name || row.name || 'Dealer Inventory',
      display_name: row.name || row.legal_name || 'Dealer Inventory',
      address: [row.address, row.city, row.zip].some(Boolean)
        ? [row.address, row.city, row.state, row.zip].filter(Boolean).join(' ')
        : '',
      phone: row.phone || '',
      email: row.email || '',
      website: row.website || '',
    } : {
      name: 'Dealer Inventory',
      display_name: 'Dealer Inventory',
      address: '',
      phone: '',
      email: '',
      website: '',
    },
  });
});

router.get('/inventory/:id', (req, res) => {
  const row = db.prepare(`
    SELECT id, vin, year, make, model, trim, body_style, color, mileage, asking_price, minimum_price, photos, stage
    FROM units
    WHERE id = ? AND stage NOT IN ('sold','archived') AND archived_at IS NULL
  `).get(req.params.id);

  if (!row) return res.status(404).json({ error: 'Vehicle not found' });
  res.json({ unit: mapUnit(row) });
});

module.exports = router;
