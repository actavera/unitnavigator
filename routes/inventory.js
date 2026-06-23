'use strict';
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');

const uploadDir = path.join(__dirname, '../public/uploads/units');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function totalCost(u) {
  return (u.acquisition_cost || 0) + (u.transport_cost || 0) +
    (u.repair_cost || 0) + (u.detail_cost || 0) + (u.other_cost || 0);
}

function enrichUnit(u) {
  const tc = totalCost(u);
  return {
    ...u,
    photos: JSON.parse(u.photos || '[]'),
    total_cost: tc,
    estimated_gross: u.asking_price != null ? u.asking_price - tc : null,
    actual_gross: u.sold_price != null ? u.sold_price - tc : null,
  };
}

function logActivity(dealership_id, entity_id, action, note, user_id) {
  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
    VALUES (?, 'unit', ?, ?, ?, ?)`).run(dealership_id, entity_id, action, note, user_id);
}

// ── VIN decode (NHTSA, no key required) ────────────────────────────────────
router.get('/decode-vin/:vin', requireAuth, async (req, res) => {
  const { vin } = req.params;
  if (vin.length !== 17) return res.status(400).json({ error: 'VIN must be 17 characters' });
  try {
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`);
    const data = await r.json();
    const result = data.Results?.[0];
    if (!result || result.ErrorCode !== '0') {
      return res.status(422).json({ error: 'VIN not found or invalid' });
    }
    res.json({
      year: parseInt(result.ModelYear) || null,
      make: result.Make || null,
      model: result.Model || null,
      trim: result.Trim || null,
      body_style: result.BodyClass || null,
    });
  } catch {
    res.status(502).json({ error: 'VIN decode service unavailable' });
  }
});

// ── List units ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const { stage, search } = req.query;
  let sql = 'SELECT * FROM units WHERE dealership_id = ?';
  const params = [req.user.dealership_id];

  if (stage && stage !== 'all') {
    sql += ' AND stage = ?';
    params.push(stage);
  }
  if (search) {
    sql += ' AND (make LIKE ? OR model LIKE ? OR vin LIKE ? OR CAST(year AS TEXT) LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  sql += ' ORDER BY created_at DESC';

  const units = db.prepare(sql).all(...params).map(enrichUnit);
  res.json({ units });
});

// ── Get single unit ─────────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const activity = db.prepare(
    `SELECT a.*, u.name as user_name FROM activity_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.entity_type = 'unit' AND a.entity_id = ?
     ORDER BY a.created_at DESC LIMIT 50`
  ).all(req.params.id);

  const deal = db.prepare(
    `SELECT d.*, c.first_name, c.last_name FROM deals d
     LEFT JOIN customers c ON c.id = d.customer_id
     WHERE d.unit_id = ? AND d.status NOT IN ('dead') ORDER BY d.created_at DESC LIMIT 1`
  ).get(req.params.id);

  res.json({ unit: enrichUnit(unit), activity, deal });
});

// ── Create unit ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  const {
    vin, year, make, model, trim, body_style, color, mileage,
    acquisition_cost, transport_cost, repair_cost, detail_cost, other_cost,
    asking_price, minimum_price, acquisition_source, acquisition_date, notes,
  } = req.body;

  const vinClean = vin ? vin.toUpperCase().trim() : '';

  if (vinClean) {
    const existing = db.prepare('SELECT id FROM units WHERE vin = ? AND dealership_id = ? AND archived_at IS NULL')
      .get(vinClean, req.user.dealership_id);
    if (existing) return res.status(409).json({ error: 'A unit with this VIN already exists in your inventory' });
  }

  const info = db.prepare(`
    INSERT INTO units (dealership_id, vin, year, make, model, trim, body_style, color, mileage,
      acquisition_cost, transport_cost, repair_cost, detail_cost, other_cost,
      asking_price, minimum_price, acquisition_source, acquisition_date, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.user.dealership_id, vinClean, year, make, model, trim, body_style, color,
    mileage || 0,
    acquisition_cost || 0, transport_cost || 0, repair_cost || 0, detail_cost || 0, other_cost || 0,
    asking_price || null, minimum_price || null, acquisition_source || null, acquisition_date || null, notes || null,
  );

  logActivity(req.user.dealership_id, info.lastInsertRowid, 'Unit created', `${year} ${make} ${model} added`, req.user.id);

  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ unit: enrichUnit(unit) });
});

// ── Update unit ─────────────────────────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const fields = [
    'year','make','model','trim','body_style','color','mileage',
    'acquisition_cost','transport_cost','repair_cost','detail_cost','other_cost',
    'asking_price','minimum_price','sold_price','acquisition_source','acquisition_date','notes',
  ];
  const updates = [];
  const vals = [];
  fields.forEach(f => {
    if (f in req.body) { updates.push(`${f} = ?`); vals.push(req.body[f]); }
  });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  vals.push(req.params.id, req.user.dealership_id);
  db.prepare(`UPDATE units SET ${updates.join(', ')} WHERE id = ? AND dealership_id = ?`).run(...vals);

  logActivity(req.user.dealership_id, req.params.id, 'Unit updated', 'Details updated', req.user.id);
  const updated = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
  res.json({ unit: enrichUnit(updated) });
});

// ── Update stage ────────────────────────────────────────────────────────────
router.patch('/:id/stage', requireAuth, (req, res) => {
  const { stage } = req.body;
  const valid = ['acquired','transport','recon','ready','pending','sold','archived'];
  if (!valid.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });

  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const extra = {};
  if (stage === 'sold') extra.sold_at = new Date().toISOString();
  if (stage === 'archived') extra.archived_at = new Date().toISOString();

  const extraSql = Object.keys(extra).map(k => `${k} = ?`).join(', ');
  const extraVals = Object.values(extra);
  db.prepare(`UPDATE units SET stage = ?${extraSql ? ', ' + extraSql : ''} WHERE id = ?`)
    .run(stage, ...extraVals, req.params.id);

  logActivity(req.user.dealership_id, req.params.id, 'Stage changed', `${unit.stage} → ${stage}`, req.user.id);
  const updated = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
  res.json({ unit: enrichUnit(updated) });
});

// ── Upload photos ───────────────────────────────────────────────────────────
router.post('/:id/photos', requireAuth, upload.array('photos', 20), (req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const existing = JSON.parse(unit.photos || '[]');
  const newUrls = (req.files || []).map(f => `/uploads/units/${f.filename}`);
  const merged = [...existing, ...newUrls];

  db.prepare('UPDATE units SET photos = ? WHERE id = ?').run(JSON.stringify(merged), req.params.id);
  logActivity(req.user.dealership_id, req.params.id, 'Photos added', `${newUrls.length} photo(s) uploaded`, req.user.id);
  res.json({ photos: merged });
});

// ── Delete a photo ──────────────────────────────────────────────────────────
router.delete('/:id/photos', requireAuth, (req, res) => {
  const { url } = req.body;
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const photos = JSON.parse(unit.photos || '[]').filter(p => p !== url);
  db.prepare('UPDATE units SET photos = ? WHERE id = ?').run(JSON.stringify(photos), req.params.id);

  const filePath = path.join(__dirname, '../public', url);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ photos });
});

module.exports = router;
