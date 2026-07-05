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
