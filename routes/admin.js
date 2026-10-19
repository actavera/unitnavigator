'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const db = require('../database');
const importHistory = require('../services/importHistory');
const reminders = require('../services/reminders');
const usage = require('../services/usage');
const messaging = require('../services/messaging');
const { validInterval: validReviewInterval, MIN_REVIEW_INTERVAL_DAYS, MAX_REVIEW_INTERVAL_DAYS } = require('../services/inventoryTruth');
const { requireAuth, requireRole, hasPermission, parsePermissions, ALL_PERMISSIONS } = require('../middleware/auth');
const { finalizeUploadedImage } = require('../services/imageSignature');

const dealerUploadDir = path.join(__dirname, '../public/uploads/dealers');
if (!fs.existsSync(dealerUploadDir)) fs.mkdirSync(dealerUploadDir, { recursive: true });

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: dealerUploadDir,
    // A neutral, server-generated temp name: the caller's original filename
    // (and its extension) is never trusted or retained. finalizeUploadedImage()
    // renames this to its permanent name once the real content is inspected.
    filename: (_req, _file, cb) => cb(null, `tmp-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.upload`),
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // SVG is deliberately excluded: it can carry an embedded <script>, and these
    // files are served from our own origin, so allowing it would be a stored-XSS vector.
    if (/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Logo must be a PNG, JPG, WEBP, or GIF image'));
  },
});

const imageUpload = logoUpload;

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
  'public_share_title',
  'public_share_description',
  'public_share_image_url',
  'representative_name',
  'representative_title',
  'representative_email',
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
  if (!hasPermission(req.user, 'settings_manage')) return false;
  return Number(req.user.dealership_id) === Number(dealershipId);
}

function canViewDealerSettings(req, dealershipId) {
  if (req.user.role === 'super_admin') return true;
  return Number(req.user.dealership_id) === Number(dealershipId);
}

const REMINDER_SETTING_FIELDS = ['reminders_email_enabled', 'reminders_sms_enabled', 'reminder_first_after_days', 'reminder_interval_days', 'reminder_max_attempts', 'timezone'];

// Reminder settings are validated on their own; omitted fields keep their
// saved values. Returns { values } or { error }.
function reminderSettings(body, existing) {
  const values = {};
  for (const field of ['reminders_email_enabled', 'reminders_sms_enabled']) {
    values[field] = body[field] === undefined || body[field] === '' ? Number(existing[field]) || 0 : (body[field] === true || body[field] === 1 || body[field] === '1' || body[field] === 'true' ? 1 : 0);
  }
  const ranges = { reminder_first_after_days: 'first_after_days', reminder_interval_days: 'interval_days', reminder_max_attempts: 'max_attempts' };
  for (const [field, key] of Object.entries(ranges)) {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') { values[field] = existing[field] ?? reminders.DEFAULTS[key]; continue; }
    const n = Number(raw);
    const [min, max] = reminders.LIMITS[key];
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${field.replace(/_/g, ' ')} must be a whole number from ${min} to ${max}.` };
    values[field] = n;
  }
  const tz = body.timezone === undefined || body.timezone === '' ? existing.timezone || reminders.DEFAULTS.timezone : String(body.timezone);
  if (!reminders.validTimezone(tz)) return { error: 'Time zone is not recognized.' };
  values.timezone = tz;
  return { values };
}

function settingsRow(id) {
  return db.prepare(`SELECT ${DEALER_SETTING_FIELDS.join(', ')}, inventory_review_interval_days, ${REMINDER_SETTING_FIELDS.join(', ')}, id, status, created_at FROM dealerships WHERE id = ?`).get(id);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function cleanPermissions(value, role) {
  if (role === 'super_admin') return [...ALL_PERMISSIONS];
  if (!Array.isArray(value)) return parsePermissions(null, role, 2);
  const list = value;
  return list.filter(permission => ALL_PERMISSIONS.includes(permission));
}

function userRow(row) {
  return {
    id: row.id,
    dealership_id: row.dealership_id,
    dealership_name: row.dealership_name,
    name: row.name,
    email: row.email,
    role: row.role,
    permissions: parsePermissions(row.permissions, row.role, row.permissions_version),
    status: row.status || 'active',
    created_at: row.created_at,
  };
}

function canManageUsers(req, dealershipId) {
  if (req.user.role === 'super_admin') return true;
  if (Number(req.user.dealership_id) !== Number(dealershipId)) return false;
  return hasPermission(req.user, 'users_manage');
}

function dealerUserWithName(id, dealershipId) {
  return db.prepare(`
    SELECT u.*, d.name AS dealership_name
    FROM users u
    LEFT JOIN dealerships d ON d.id = u.dealership_id
    WHERE u.id = ? AND u.dealership_id = ?
  `).get(id, dealershipId);
}

router.get('/dealership-settings', requireAuth, (req, res) => {
  const dealershipId = Number(req.query.dealership_id || req.user.dealership_id);
  if (!canViewDealerSettings(req, dealershipId)) return res.status(403).json({ error: 'Insufficient permissions' });
  const dealership = settingsRow(dealershipId);
  if (!dealership) return res.status(404).json({ error: 'Dealership not found' });
  // Whether each reminder channel's provider is configured on the server
  // (booleans only; credentials are never returned).
  res.json({ dealership, messaging: messaging.providerStatus() });
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
  // Inventory review interval: whole days, 7-90. Validated on its own so an
  // out-of-range value is rejected instead of silently coerced.
  let reviewInterval = existing.inventory_review_interval_days;
  const rawInterval = req.body.inventory_review_interval_days;
  if (rawInterval !== undefined && rawInterval !== null && rawInterval !== '') {
    if (!validReviewInterval(rawInterval)) {
      return res.status(400).json({ error: `Inventory review interval must be a whole number of days from ${MIN_REVIEW_INTERVAL_DAYS} to ${MAX_REVIEW_INTERVAL_DAYS}.` });
    }
    reviewInterval = Number(rawInterval);
  }
  const reminderResult = reminderSettings(req.body, existing);
  if (reminderResult.error) return res.status(400).json({ error: reminderResult.error });
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
  db.prepare(`UPDATE dealerships SET ${assignments}, inventory_review_interval_days = ?, ${REMINDER_SETTING_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...DEALER_SETTING_FIELDS.map(field => values[field]), reviewInterval, ...REMINDER_SETTING_FIELDS.map(f => reminderResult.values[f]), dealershipId);
  res.json({ dealership: settingsRow(dealershipId), messaging: messaging.providerStatus() });
});

router.post('/dealership-settings/logo', requireAuth, logoUpload.single('logo'), (req, res) => {
  const dealershipId = Number(req.body.dealership_id || req.user.dealership_id);
  if (!canManageDealerSettings(req, dealershipId)) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  if (!settingsRow(dealershipId)) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
    return res.status(404).json({ error: 'Dealership not found' });
  }
  if (!req.file) return res.status(400).json({ error: 'Choose a logo file first' });
  const finalized = finalizeUploadedImage(req.file, { namePrefix: `${dealershipId}-` });
  if (!finalized) {
    return res.status(400).json({ error: 'That file is not a valid PNG, JPG, WEBP, or GIF image' });
  }

  const logoUrl = `/uploads/dealers/${finalized.filename}`;
  db.prepare('UPDATE dealerships SET logo_url = ? WHERE id = ?').run(logoUrl, dealershipId);
  res.status(201).json({ logo_url: logoUrl, dealership: settingsRow(dealershipId) });
});

router.post('/dealership-settings/share-image', requireAuth, imageUpload.single('image'), (req, res) => {
  const dealershipId = Number(req.body.dealership_id || req.user.dealership_id);
  if (!canManageDealerSettings(req, dealershipId)) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  if (!settingsRow(dealershipId)) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
    return res.status(404).json({ error: 'Dealership not found' });
  }
  if (!req.file) return res.status(400).json({ error: 'Choose a share image first' });
  const finalized = finalizeUploadedImage(req.file, { namePrefix: `${dealershipId}-` });
  if (!finalized) {
    return res.status(400).json({ error: 'That file is not a valid PNG, JPG, WEBP, or GIF image' });
  }

  const imageUrl = `/uploads/dealers/${finalized.filename}`;
  db.prepare('UPDATE dealerships SET public_share_image_url = ? WHERE id = ?').run(imageUrl, dealershipId);
  res.status(201).json({ image_url: imageUrl, dealership: settingsRow(dealershipId) });
});

router.get('/dealership-users', requireAuth, (req, res) => {
  const dealershipId = Number(req.query.dealership_id || req.user.dealership_id);
  if (!canManageUsers(req, dealershipId)) return res.status(403).json({ error: 'You do not have access to manage users' });
  const users = db.prepare(`
    SELECT u.*, d.name AS dealership_name
    FROM users u
    LEFT JOIN dealerships d ON d.id = u.dealership_id
    WHERE u.dealership_id = ?
    ORDER BY u.created_at DESC
  `).all(dealershipId).map(userRow);
  res.json({ users, permissions: ALL_PERMISSIONS });
});

router.post('/dealership-users', requireAuth, (req, res) => {
  const dealershipId = Number(req.body.dealership_id || req.user.dealership_id);
  if (!canManageUsers(req, dealershipId)) return res.status(403).json({ error: 'You do not have access to manage users' });

  const name = String(req.body.name || '').trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const role = ['admin','manager','staff'].includes(req.body.role) ? req.body.role : 'staff';
  const permissions = cleanPermissions(req.body.permissions, role);

  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const info = db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, permissions_version, status)
      VALUES (?, ?, ?, ?, ?, ?, 2, 'active')
    `).run(dealershipId, name, email, bcrypt.hashSync(password, 12), role, JSON.stringify(permissions));
    res.status(201).json({ user: userRow(dealerUserWithName(info.lastInsertRowid, dealershipId)) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw err;
  }
});

router.patch('/dealership-users/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  const dealershipId = Number(req.body.dealership_id || existing.dealership_id);
  if (!canManageUsers(req, existing.dealership_id)) return res.status(403).json({ error: 'You do not have access to manage users' });
  if (Number(dealershipId) !== Number(existing.dealership_id) && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'You cannot move users to another dealership' });
  }
  if (existing.id === req.user.id && req.body.status === 'revoked') {
    return res.status(400).json({ error: 'You cannot revoke your own login while signed in' });
  }

  const name = String(req.body.name ?? existing.name).trim();
  const email = normalizeEmail(req.body.email ?? existing.email);
  const role = ['admin','manager','staff'].includes(req.body.role) ? req.body.role : existing.role;
  const status = req.body.status === 'revoked' ? 'revoked' : 'active';
  const permissions = cleanPermissions(req.body.permissions ?? parsePermissions(existing.permissions, existing.role, existing.permissions_version), role);

  try {
    db.prepare(`
      UPDATE users
      SET dealership_id = ?, name = ?, email = ?, role = ?, permissions = ?, permissions_version = 2, status = ?
      WHERE id = ?
    `).run(dealershipId, name, email, role, JSON.stringify(permissions), status, existing.id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw err;
  }

  if (req.body.password) {
    const password = String(req.body.password);
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(bcrypt.hashSync(password, 12), new Date().toISOString(), existing.id);
  }

  res.json({ user: userRow(dealerUserWithName(existing.id, dealershipId)) });
});

router.delete('/dealership-users/:id', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canManageUsers(req, user.dealership_id)) return res.status(403).json({ error: 'You do not have access to manage users' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own login while signed in' });
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

// Usage this month and recent exports, for dealership admins (and the
// platform admin for any dealership). Read-only; nothing here bills.
router.get('/usage', requireAuth, (req, res) => {
  const dealershipId = Number(req.query.dealership_id || req.user.dealership_id);
  const allowed = req.user.role === 'super_admin'
    || (Number(dealershipId) === Number(req.user.dealership_id) && (hasPermission(req.user, 'settings_manage') || hasPermission(req.user, 'users_manage')));
  if (!allowed) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json(usage.usageSummary(db, { dealershipId }));
});

router.use(...requireRole('super_admin'));

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

router.get('/platform-sold-units', (req, res) => {
  const search = String(req.query.search || '').trim();
  const like = `%${search.toLowerCase()}%`;
  const where = search
    ? `WHERE lower(COALESCE(p.make, '') || ' ' || COALESCE(p.model, '') || ' ' || COALESCE(p.trim, '') || ' ' || COALESCE(p.year, '') || ' ' || COALESCE(d.name, '')) LIKE ?`
    : '';
  const params = search ? [like] : [];
  const rows = db.prepare(`
    SELECT p.*, d.name AS dealership_name
    FROM platform_sold_units p
    LEFT JOIN dealerships d ON d.id = p.dealership_id
    ${where}
    ORDER BY COALESCE(p.sold_at, p.updated_at, p.created_at) DESC
    LIMIT 250
  `).all(...params);
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS sold_count,
      AVG(sold_price) AS avg_sold_price,
      AVG(mileage) AS avg_mileage
    FROM platform_sold_units
    WHERE sold_price IS NOT NULL AND sold_price > 0
  `).get();
  res.json({ rows, summary });
});

router.post('/dealerships', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Dealership name required' });
  const info = db.prepare('INSERT INTO dealerships (name, legal_name, public_slug, public_site_enabled, status) VALUES (?, ?, ?, ?, ?)')
    .run(name, name, slugify(req.body.public_slug || name), 0, req.body.status === 'revoked' ? 'revoked' : 'active');
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
    importHistory.deleteForDealership(db, dealership.id);
    usage.deleteForDealership(db, dealership.id);
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
  const role = ['super_admin','admin','manager','staff'].includes(req.body.role) ? req.body.role : 'manager';
  const permissions = cleanPermissions(req.body.permissions, role);

  if (!dealershipId || !db.prepare('SELECT id FROM dealerships WHERE id = ?').get(dealershipId)) {
    return res.status(400).json({ error: 'Valid dealership required' });
  }
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const hash = bcrypt.hashSync(password, 12);
  try {
    const info = db.prepare(`
      INSERT INTO users (dealership_id, name, email, password_hash, role, permissions, permissions_version, status)
      VALUES (?, ?, ?, ?, ?, ?, 2, 'active')
    `).run(dealershipId, name, email, hash, role, JSON.stringify(permissions));
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
  const permissions = cleanPermissions(req.body.permissions ?? parsePermissions(user.permissions, user.role, user.permissions_version), role);
  try {
    db.prepare(`
      UPDATE users
      SET dealership_id = ?, name = ?, email = ?, role = ?, permissions = ?, permissions_version = 2, status = ?
      WHERE id = ?
    `).run(dealershipId, name, email, role, JSON.stringify(permissions), status, user.id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw err;
  }

  if (req.body.password) {
    const password = String(req.body.password);
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(bcrypt.hashSync(password, 12), new Date().toISOString(), user.id);
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

// Paid add-on entitlements (platform admin only; this section is below the
// super_admin guard). No billing: this records what a dealership may use.
router.get('/dealerships/:id/entitlements', (req, res) => {
  const dealership = db.prepare('SELECT id FROM dealerships WHERE id = ?').get(req.params.id);
  if (!dealership) return res.status(404).json({ error: 'Dealership not found' });
  res.json({ entitlements: usage.listEntitlements(db, dealership.id) });
});

router.put('/dealerships/:id/entitlements/:feature', (req, res) => {
  const dealership = db.prepare('SELECT id FROM dealerships WHERE id = ?').get(req.params.id);
  if (!dealership) return res.status(404).json({ error: 'Dealership not found' });
  try {
    res.json({ entitlements: usage.setEntitlement(db, { dealershipId: dealership.id, feature: req.params.feature, actorId: req.user.id, body: req.body || {} }) });
  } catch (err) {
    if (err instanceof usage.UsageError) return res.status(err.statusCode).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
