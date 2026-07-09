'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');

const dealerUploadDir = path.join(__dirname, '../public/uploads/dealers');
if (!fs.existsSync(dealerUploadDir)) fs.mkdirSync(dealerUploadDir, { recursive: true });

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: dealerUploadDir,
    filename: (req, file, cb) => {
      const dealershipId = req.body.dealership_id || req.user?.dealership_id || 'dealer';
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      const base = slugify(`${dealershipId}-${Date.now()}-${path.basename(file.originalname || 'logo', ext)}`) || `${dealershipId}-${Date.now()}`;
      cb(null, `${base}${ext}`);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Logo must be a PNG, JPG, WEBP, GIF, or SVG image'));
  },
});

const DEALER_SETTING_FIELDS = [
  'name',
  'legal_name',
  'dealer_number',
  'address',
  'city',
  'state',
  'zip',
  'phone',
  'email',
  'website',
  'public_slug',
  'public_domain',
  'logo_url',
  'public_site_enabled',
  'public_apr_options',
  'representative_name',
  'representative_title',
  'default_doc_fee',
  'default_filing_fee',
  'default_lender_fee',
  'default_license_fee',
  'default_plate_fee',
  'default_age_property_tax',
  'default_title_fee',
  'default_emissions_fee',
  'default_tax_rate',
];

const NUMERIC_SETTING_FIELDS = new Set([
  'default_doc_fee',
  'default_filing_fee',
  'default_lender_fee',
  'default_license_fee',
  'default_plate_fee',
  'default_age_property_tax',
  'default_title_fee',
  'default_emissions_fee',
  'default_tax_rate',
  'public_site_enabled',
]);

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function canManageDealerSettings(req, dealershipId) {
  if (req.user.role === 'super_admin') return true;
  if (!['admin', 'manager'].includes(req.user.role)) return false;
  return Number(req.user.dealership_id) === Number(dealershipId);
}

function canViewDealerSettings(req, dealershipId) {
  if (req.user.role === 'super_admin') return true;
  return Number(req.user.dealership_id) === Number(dealershipId);
}

function settingsRow(id) {
  return db.prepare(`SELECT ${DEALER_SETTING_FIELDS.join(', ')}, id, status, created_at FROM dealerships WHERE id = ?`).get(id);
}

router.get('/dealership-settings', requireAuth, (req, res) => {
  const dealershipId = Number(req.query.dealership_id || req.user.dealership_id);
  if (!canViewDealerSettings(req, dealershipId)) return res.status(403).json({ error: 'Insufficient permissions' });
  const dealership = settingsRow(dealershipId);
  if (!dealership) return res.status(404).json({ error: 'Dealership not found' });
  res.json({ dealership });
});

router.put('/dealership-settings', requireAuth, (req, res) => {
  const dealershipId = Number(req.body.dealership_id || req.user.dealership_id);
  if (!canManageDealerSettings(req, dealershipId)) return res.status(403).json({ error: 'Insufficient permissions' });
  const existing = settingsRow(dealershipId);
  if (!existing) return res.status(404).json({ error: 'Dealership not found' });

  const values = {};
  DEALER_SETTING_FIELDS.forEach(field => {
    if (field === 'status' || field === 'created_at') return;
    if (NUMERIC_SETTING_FIELDS.has(field)) {
      const value = Number(req.body[field] ?? existing[field] ?? 0);
      values[field] = Number.isFinite(value) ? value : 0;
    } else {
      values[field] = String(req.body[field] ?? existing[field] ?? '').trim();
    }
  });
  if (!values.name) return res.status(400).json({ error: 'Dealership name is required' });
  if (!values.legal_name) values.legal_name = values.name;
  if (!values.state) values.state = 'UT';
  values.public_site_enabled = values.public_site_enabled ? 1 : 0;
  values.public_slug = slugify(values.public_slug || values.name);
  values.public_domain = String(values.public_domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();
  values.public_apr_options = String(values.public_apr_options || '')
    .split(/[\n,]+/)
    .map(value => Number(String(value).replace(/[^0-9.]/g, '')))
    .filter(value => Number.isFinite(value) && value >= 0 && value <= 40)
    .map(value => value.toFixed(2).replace(/\.00$/, ''))
    .join(',');
  if (!values.public_apr_options) values.public_apr_options = '9.99,7.99,12.99,18.99';

  const assignments = DEALER_SETTING_FIELDS.map(field => `${field} = ?`).join(', ');
  db.prepare(`UPDATE dealerships SET ${assignments} WHERE id = ?`)
    .run(...DEALER_SETTING_FIELDS.map(field => values[field]), dealershipId);
  res.json({ dealership: settingsRow(dealershipId) });
});

router.post('/dealership-settings/logo', requireAuth, logoUpload.single('logo'), (req, res) => {
  const dealershipId = Number(req.body.dealership_id || req.user.dealership_id);
  if (!canManageDealerSettings(req, dealershipId)) return res.status(403).json({ error: 'Insufficient permissions' });
  if (!settingsRow(dealershipId)) return res.status(404).json({ error: 'Dealership not found' });
  if (!req.file) return res.status(400).json({ error: 'Choose a logo file first' });

  const logoUrl = `/uploads/dealers/${req.file.filename}`;
  db.prepare('UPDATE dealerships SET logo_url = ? WHERE id = ?').run(logoUrl, dealershipId);
  res.status(201).json({ logo_url: logoUrl, dealership: settingsRow(dealershipId) });
});

router.use(...requireRole('super_admin'));

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function userRow(row) {
  return {
    id: row.id,
    dealership_id: row.dealership_id,
    dealership_name: row.dealership_name,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status || 'active',
    created_at: row.created_at,
  };
}

router.get('/overview', (_req, res) => {
  const dealerships = db.prepare(`
    SELECT d.*,
      COUNT(u.id) AS user_count,
      SUM(CASE WHEN u.status = 'active' THEN 1 ELSE 0 END) AS active_user_count
    FROM dealerships d
    LEFT JOIN users u ON u.dealership_id = d.id
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all();
  const users = db.prepare(`
    SELECT u.*, d.name AS dealership_name
    FROM users u
    LEFT JOIN dealerships d ON d.id = u.dealership_id
    ORDER BY u.created_at DESC
  `).all().map(userRow);
  res.json({ dealerships, users });
});

router.post('/dealerships', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Dealership name required' });
  const info = db.prepare('INSERT INTO dealerships (name, legal_name, public_slug, public_site_enabled, status) VALUES (?, ?, ?, ?, ?)')
    .run(name, name, slugify(req.body.public_slug || name), 1, req.body.status === 'revoked' ? 'revoked' : 'active');
  const dealership = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ dealership });
});

router.patch('/dealerships/:id', (req, res) => {
  const dealership = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(req.params.id);
  if (!dealership) return res.status(404).json({ error: 'Dealership not found' });
  const name = String(req.body.name ?? dealership.name).trim();
  const status = req.body.status === 'revoked' ? 'revoked' : 'active';
  const publicSlug = req.body.public_slug !== undefined ? slugify(req.body.public_slug) : (dealership.public_slug || slugify(name));
  db.prepare('UPDATE dealerships SET name = ?, public_slug = ?, status = ? WHERE id = ?').run(name, publicSlug, status, dealership.id);
  res.json({ dealership: db.prepare('SELECT * FROM dealerships WHERE id = ?').get(dealership.id) });
});

router.delete('/dealerships/:id', (req, res) => {
  const dealership = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(req.params.id);
  if (!dealership) return res.status(404).json({ error: 'Dealership not found' });

  const counts = {
    units: db.prepare('SELECT COUNT(*) AS count FROM units WHERE dealership_id = ?').get(dealership.id).count,
    customers: db.prepare('SELECT COUNT(*) AS count FROM customers WHERE dealership_id = ?').get(dealership.id).count,
    deals: db.prepare('SELECT COUNT(*) AS count FROM deals WHERE dealership_id = ?').get(dealership.id).count,
    credit_pulls: db.prepare('SELECT COUNT(*) AS count FROM credit_pulls WHERE dealership_id = ?').get(dealership.id).count,
    documents: db.prepare('SELECT COUNT(*) AS count FROM documents WHERE dealership_id = ?').get(dealership.id).count,
  };
  const hasBusinessData = Object.values(counts).some(Boolean);
  if (hasBusinessData) {
    return res.status(409).json({
      error: 'This dealership has inventory, customers, deals, credit pulls, or documents. Revoke it instead of deleting.',
      counts,
    });
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM users WHERE dealership_id = ?').run(dealership.id);
    db.prepare('DELETE FROM activity_logs WHERE dealership_id = ?').run(dealership.id);
    db.prepare('DELETE FROM dealerships WHERE id = ?').run(dealership.id);
  });
  tx();
  res.json({ ok: true });
});

router.post('/users', (req, res) => {
  const dealershipId = Number(req.body.dealership_id);
  const name = String(req.body.name || '').trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const role = ['super_admin','admin','manager','staff'].includes(req.body.role) ? req.body.role : 'staff';

  if (!dealershipId || !db.prepare('SELECT id FROM dealerships WHERE id = ?').get(dealershipId)) {
    return res.status(400).json({ error: 'Valid dealership required' });
  }
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const hash = bcrypt.hashSync(password, 12);
  try {
    const info = db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(dealershipId, name, email, hash, role);
    const row = db.prepare(`
      SELECT u.*, d.name AS dealership_name
      FROM users u LEFT JOIN dealerships d ON d.id = u.dealership_id
      WHERE u.id = ?
    `).get(info.lastInsertRowid);
    res.status(201).json({ user: userRow(row) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw err;
  }
});

router.patch('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const dealershipId = Number(req.body.dealership_id ?? user.dealership_id);
  const dealership = db.prepare('SELECT id FROM dealerships WHERE id = ?').get(dealershipId);
  if (!dealership) return res.status(400).json({ error: 'Valid dealership required' });

  const name = String(req.body.name ?? user.name).trim();
  const email = normalizeEmail(req.body.email ?? user.email);
  const role = ['super_admin','admin','manager','staff'].includes(req.body.role) ? req.body.role : user.role;
  const status = req.body.status === 'revoked' ? 'revoked' : 'active';
  try {
    db.prepare(`
      UPDATE users
      SET dealership_id = ?, name = ?, email = ?, role = ?, status = ?
      WHERE id = ?
    `).run(dealershipId, name, email, role, status, user.id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw err;
  }

  if (req.body.password) {
    const password = String(req.body.password);
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), user.id);
  }

  const row = db.prepare(`
    SELECT u.*, d.name AS dealership_name
    FROM users u LEFT JOIN dealerships d ON d.id = u.dealership_id
    WHERE u.id = ?
  `).get(user.id);
  res.json({ user: userRow(row) });
});

router.delete('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own login while signed in' });
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

module.exports = router;
