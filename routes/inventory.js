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

const REPAIR_STATUSES = new Set(['searching','ordered','working','completed']);

function parseRepairItems(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? '').replace(/[^0-9.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseInteger(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9-]/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeVin(value) {
  return cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizePhotos(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  const text = cleanText(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(cleanText).filter(Boolean);
  } catch {}
  return text.split(/[\n;,|]+/).map(cleanText).filter(Boolean);
}

function normalizeStage(value) {
  const key = cleanText(value).toLowerCase();
  const compact = key.replace(/[^a-z0-9]/g, '');
  const map = {
    acquired: 'acquired',
    atauction: 'acquired',
    auction: 'acquired',
    transport: 'transport',
    transported: 'transport',
    beingtransported: 'transport',
    screening: 'screening',
    needsscreening: 'screening',
    recon: 'recon',
    reconditioning: 'recon',
    ready: 'ready',
    readytosell: 'ready',
    available: 'ready',
    active: 'ready',
    pending: 'pending',
    sold: 'sold',
    archived: 'archived',
  };
  return map[compact] || 'ready';
}

function normalizeRepairItems(value) {
  return parseRepairItems(value).map(item => {
    const description = String(item.description || item.repair_needed || item.name || '').trim();
    const cost = parseMoney(item.cost);
    const status = REPAIR_STATUSES.has(item.status) ? item.status : 'searching';
    return { description, cost: Math.max(0, cost), status };
  }).filter(item => item.description || item.cost);
}

function repairItemsTotal(items) {
  return items.reduce((sum, item) => sum + parseMoney(item.cost), 0);
}

function totalCost(u) {
  const repairItems = parseRepairItems(u.repair_items);
  const repairCost = repairItems.length ? repairItemsTotal(repairItems) : (u.repair_cost || 0);
  return (u.acquisition_cost || 0) + (u.transport_cost || 0) +
    repairCost + (u.detail_cost || 0) + (u.other_cost || 0);
}

function enrichUnit(u) {
  const tc = totalCost(u);
  const repairItems = parseRepairItems(u.repair_items);
  const repairCost = repairItems.length ? repairItemsTotal(repairItems) : (u.repair_cost || 0);
  return {
    ...u,
    photos: JSON.parse(u.photos || '[]'),
    repair_items: repairItems,
    repair_cost: repairCost,
    total_cost: tc,
    estimated_gross: u.asking_price != null ? u.asking_price - tc : null,
    actual_gross: u.sold_price != null ? u.sold_price - tc : null,
  };
}

function logActivity(dealership_id, entity_id, action, note, user_id) {
  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
    VALUES (?, 'unit', ?, ?, ?, ?)`).run(dealership_id, entity_id, action, note, user_id);
}

const VALID_STAGES = ['acquired','transport','screening','recon','ready','pending','sold','archived'];
const STAGE_LABELS = {
  acquired: 'At Auction',
  transport: 'Being Transported',
  screening: 'Needs Screening',
  recon: 'Recon',
  ready: 'Ready',
  pending: 'Pending',
  sold: 'Sold',
  archived: 'Archived',
};

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
    sql += ' AND (make LIKE ? OR model LIKE ? OR vin LIKE ? OR stock_number LIKE ? OR CAST(year AS TEXT) LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }
  sql += ' ORDER BY created_at DESC';

  const units = db.prepare(sql).all(...params).map(enrichUnit);
  res.json({ units });
});

// ── Bulk import units from CSV/other systems ───────────────────────────────
router.post('/import', requireAuth, (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No import rows received' });
  if (rows.length > 500) return res.status(400).json({ error: 'Import is limited to 500 units at a time' });

  const results = { created: 0, updated: 0, skipped: 0, errors: [] };
  const source = cleanText(req.body.source || 'Inventory import');

  const tx = db.transaction(() => {
    rows.forEach((row, index) => {
      const vin = normalizeVin(row.vin || row.VIN || row.vehicle_vin);
      const year = parseInteger(row.year || row.Year || row.model_year);
      const make = cleanText(row.make || row.Make);
      const model = cleanText(row.model || row.Model);
      const trim = cleanText(row.trim || row.Trim);
      const stockNumber = cleanText(row.stock_number || row.stock || row['Stock #'] || row.stock_no || row.unit_number);

      if (!vin && (!year || !make || !model)) {
        results.skipped += 1;
        results.errors.push({ row: index + 1, error: 'Missing VIN or year/make/model' });
        return;
      }

      const unit = {
        vin,
        stock_number: stockNumber,
        year: year || null,
        make,
        model,
        trim,
        body_style: cleanText(row.body_style || row.body || row.Body || row.vehicle_type),
        color: cleanText(row.color || row.Color || row.exterior_color),
        mileage: parseInteger(row.mileage || row.miles || row.odometer || row.Odometer),
        stage: VALID_STAGES.includes(normalizeStage(row.stage || row.status || row.Status)) ? normalizeStage(row.stage || row.status || row.Status) : 'ready',
        acquisition_cost: parseMoney(row.acquisition_cost || row.cost || row.Cost || row.inventory_cost || row.purchase_price),
        asking_price: parseMoney(row.asking_price || row.price || row.Price || row.retail_price || row.internet_price),
        minimum_price: parseMoney(row.minimum_price || row.min_price || row.floor_price),
        acquisition_source: cleanText(row.acquisition_source || row.source || source),
        acquisition_date: cleanText(row.acquisition_date || row.date_acquired || row.purchase_date),
        notes: cleanText(row.notes || row.Notes),
        photos: normalizePhotos(row.photos || row.photo_urls || row.images || row.image_urls),
      };

      const existing = vin ? db.prepare(`
        SELECT id FROM units
        WHERE dealership_id = ? AND vin = ? AND archived_at IS NULL
      `).get(req.user.dealership_id, vin) : null;

      if (existing) {
        db.prepare(`
          UPDATE units
          SET stock_number = ?, year = ?, make = ?, model = ?, trim = ?, body_style = ?, color = ?, mileage = ?,
              stage = ?, acquisition_cost = ?, asking_price = ?, minimum_price = ?, acquisition_source = ?,
              acquisition_date = ?, notes = ?, photos = CASE WHEN ? != '[]' THEN ? ELSE photos END
          WHERE id = ? AND dealership_id = ?
        `).run(
          unit.stock_number, unit.year, unit.make, unit.model, unit.trim, unit.body_style, unit.color, unit.mileage,
          unit.stage, unit.acquisition_cost, unit.asking_price || null, unit.minimum_price || null, unit.acquisition_source,
          unit.acquisition_date || null, unit.notes || null, JSON.stringify(unit.photos), JSON.stringify(unit.photos),
          existing.id, req.user.dealership_id,
        );
        logActivity(req.user.dealership_id, existing.id, 'Unit imported', `Updated from ${source}`, req.user.id);
        results.updated += 1;
      } else {
        const info = db.prepare(`
          INSERT INTO units (dealership_id, vin, stock_number, year, make, model, trim, body_style, color, mileage, stage,
            acquisition_cost, asking_price, minimum_price, acquisition_source, acquisition_date, notes, photos)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          req.user.dealership_id, vin, unit.stock_number, unit.year, unit.make, unit.model, unit.trim, unit.body_style,
          unit.color, unit.mileage, unit.stage, unit.acquisition_cost, unit.asking_price || null, unit.minimum_price || null,
          unit.acquisition_source, unit.acquisition_date || null, unit.notes || null, JSON.stringify(unit.photos),
        );
        logActivity(req.user.dealership_id, info.lastInsertRowid, 'Unit imported', `${unit.year || ''} ${unit.make} ${unit.model} imported from ${source}`.trim(), req.user.id);
        results.created += 1;
      }
    });
  });

  tx();
  res.status(201).json(results);
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
    vin, stock_number, year, make, model, trim, body_style, color, mileage,
    acquisition_cost, transport_cost, repair_cost, detail_cost, other_cost,
    asking_price, minimum_price, acquisition_source, acquisition_date, notes, stage,
    repair_items,
  } = req.body;

  const vinClean = vin ? vin.toUpperCase().trim() : '';
  const acquisitionCostNum = Number(acquisition_cost);

  if (acquisition_cost === undefined || acquisition_cost === null || acquisition_cost === '' || Number.isNaN(acquisitionCostNum) || acquisitionCostNum < 0) {
    return res.status(400).json({ error: 'Acquisition cost is required' });
  }
  const initialStage = stage || 'acquired';
  if (!VALID_STAGES.includes(initialStage)) return res.status(400).json({ error: 'Invalid stage' });

  if (vinClean) {
    const existing = db.prepare('SELECT id FROM units WHERE vin = ? AND dealership_id = ? AND archived_at IS NULL')
      .get(vinClean, req.user.dealership_id);
    if (existing) return res.status(409).json({ error: 'A unit with this VIN already exists in your inventory' });
  }

  const repairItems = normalizeRepairItems(repair_items);
  const repairCostNum = repairItems.length ? repairItemsTotal(repairItems) : parseMoney(repair_cost);

  const info = db.prepare(`
    INSERT INTO units (dealership_id, vin, stock_number, year, make, model, trim, body_style, color, mileage, stage,
      acquisition_cost, transport_cost, repair_cost, repair_items, detail_cost, other_cost,
      asking_price, minimum_price, acquisition_source, acquisition_date, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.user.dealership_id, vinClean, stock_number || null, year, make, model, trim, body_style, color,
    mileage || 0, initialStage,
    acquisitionCostNum, transport_cost || 0, repairCostNum, JSON.stringify(repairItems), detail_cost || 0, other_cost || 0,
    asking_price || null, minimum_price || null, acquisition_source || null, acquisition_date || null, notes || null,
  );

  logActivity(req.user.dealership_id, info.lastInsertRowid, 'Unit created', `${year} ${make} ${model} added to ${STAGE_LABELS[initialStage]}`, req.user.id);

  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ unit: enrichUnit(unit) });
});

// ── Update unit ─────────────────────────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const fields = [
    'stock_number','year','make','model','trim','body_style','color','mileage',
    'acquisition_cost','transport_cost','repair_cost','detail_cost','other_cost',
    'asking_price','minimum_price','sold_price','acquisition_source','acquisition_date','notes',
  ];
  const updates = [];
  const vals = [];
  fields.forEach(f => {
    if (f === 'repair_cost' && 'repair_items' in req.body) return;
    if (f in req.body) { updates.push(`${f} = ?`); vals.push(req.body[f]); }
  });
  if ('repair_items' in req.body) {
    const repairItems = normalizeRepairItems(req.body.repair_items);
    updates.push('repair_items = ?', 'repair_cost = ?');
    vals.push(JSON.stringify(repairItems), repairItemsTotal(repairItems));
  }
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
  if (!VALID_STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });

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

  logActivity(req.user.dealership_id, req.params.id, 'Stage changed', `${STAGE_LABELS[unit.stage] || unit.stage} → ${STAGE_LABELS[stage] || stage}`, req.user.id);
  const updated = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
  res.json({ unit: enrichUnit(updated) });
});

// ── Permanently delete unit ────────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const photos = JSON.parse(unit.photos || '[]');
  photos.forEach(url => {
    const filePath = path.join(__dirname, '../public', url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  db.prepare('UPDATE deals SET unit_id = NULL WHERE unit_id = ? AND dealership_id = ?')
    .run(req.params.id, req.user.dealership_id);
  db.prepare('DELETE FROM activity_logs WHERE entity_type = ? AND entity_id = ? AND dealership_id = ?')
    .run('unit', req.params.id, req.user.dealership_id);
  db.prepare('DELETE FROM units WHERE id = ? AND dealership_id = ?')
    .run(req.params.id, req.user.dealership_id);

  res.json({ ok: true });
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
