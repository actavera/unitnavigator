'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireRole } = require('../middleware/auth');

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
  const info = db.prepare('INSERT INTO dealerships (name, status) VALUES (?, ?)').run(name, req.body.status === 'revoked' ? 'revoked' : 'active');
  const dealership = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ dealership });
});

router.patch('/dealerships/:id', (req, res) => {
  const dealership = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(req.params.id);
  if (!dealership) return res.status(404).json({ error: 'Dealership not found' });
  const name = String(req.body.name ?? dealership.name).trim();
  const status = req.body.status === 'revoked' ? 'revoked' : 'active';
  db.prepare('UPDATE dealerships SET name = ?, status = ? WHERE id = ?').run(name, status, dealership.id);
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
