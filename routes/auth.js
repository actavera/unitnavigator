'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { JWT_SECRET } = require('../middleware/auth');

function signUser(user, dealership, extra = {}) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, dealership_id: user.dealership_id, ...extra },
    JWT_SECRET,
    { expiresIn: extra.demo ? '8h' : '7d' }
  );
}

function userPayload(user, dealership, extra = {}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    dealership: dealership?.name,
    ...extra,
  };
}

function cleanupDemoDealership(dealershipId) {
  if (!dealershipId) return;
  const dealership = db.prepare('SELECT id, name FROM dealerships WHERE id = ?').get(dealershipId);
  if (!dealership || !String(dealership.name || '').startsWith('Unit Navigator Demo')) return;

  const unitPhotos = db.prepare('SELECT photos FROM units WHERE dealership_id = ?').all(dealershipId);
  unitPhotos.forEach(row => {
    let photos = [];
    try { photos = JSON.parse(row.photos || '[]'); } catch {}
    photos.forEach(url => {
      if (!String(url || '').startsWith('/uploads/units/')) return;
      const filePath = path.join(__dirname, '../public', url);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
  });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM documents WHERE dealership_id = ?').run(dealershipId);
    db.prepare('DELETE FROM activity_logs WHERE dealership_id = ?').run(dealershipId);
    db.prepare('DELETE FROM deals WHERE dealership_id = ?').run(dealershipId);
    db.prepare('DELETE FROM credit_pulls WHERE dealership_id = ?').run(dealershipId);
    db.prepare('DELETE FROM units WHERE dealership_id = ?').run(dealershipId);
    db.prepare('DELETE FROM customers WHERE dealership_id = ?').run(dealershipId);
    db.prepare('DELETE FROM users WHERE dealership_id = ?').run(dealershipId);
    db.prepare('DELETE FROM dealerships WHERE id = ?').run(dealershipId);
  });
  tx();
}

function cleanupStaleDemoDealerships() {
  const stale = db.prepare(`
    SELECT id FROM dealerships
    WHERE name LIKE 'Unit Navigator Demo %'
      AND datetime(created_at) < datetime('now', '-1 day')
    LIMIT 25
  `).all();
  stale.forEach(row => cleanupDemoDealership(row.id));
}

function seedDemoCustomers(dealershipId) {
  const rows = [
    ['Maya', 'Collins', '(801) 555-0142', 'maya@example.com', '88 Center St, Orem, UT 84057', 'D1234567'],
    ['Robert', 'Hayes', '(385) 555-0177', 'robert@example.com', '14 State St, Provo, UT 84601', 'D7654321'],
    ['Lena', 'Torres', '(801) 555-0194', 'lena@example.com', '205 Main St, Pleasant Grove, UT 84062', 'P9876543'],
  ];
  const stmt = db.prepare(`
    INSERT INTO customers (dealership_id, first_name, last_name, phone, email, address, id_number)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  rows.forEach(row => stmt.run(dealershipId, ...row));
}

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (user.status === 'revoked') {
    return res.status(403).json({ error: 'This login has been revoked' });
  }

  const dealership = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(user.dealership_id);
  if (dealership?.status === 'revoked') {
    return res.status(403).json({ error: 'This dealership has been revoked' });
  }
  const token = signUser(user, dealership);
  res.json({ token, user: userPayload(user, dealership) });
});

router.post('/demo-login', (_req, res) => {
  cleanupStaleDemoDealerships();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dealershipInfo = db.prepare(`
    INSERT INTO dealerships (
      name, legal_name, address, city, state, zip, phone, email, website,
      public_slug, public_domain, public_site_enabled, default_doc_fee, default_tax_rate
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 399, 7.25)
  `).run(
    `Unit Navigator Demo ${stamp}`,
    'Unit Navigator Demo Dealer',
    '205 E State Rd',
    'Pleasant Grove',
    'UT',
    '84062',
    '(801) 555-0100',
    'demo@unitnavigator.com',
    'https://unitnavigator.com/demo',
    `demo-${stamp}`,
    'demo.unitnavigator.com'
  );

  const dealershipId = dealershipInfo.lastInsertRowid;
  seedDemoCustomers(dealershipId);

  const password = Math.random().toString(36).slice(2);
  const userInfo = db.prepare(`
    INSERT INTO users (dealership_id, name, email, password_hash, role, status)
    VALUES (?, ?, ?, ?, 'admin', 'active')
  `).run(
    dealershipId,
    'Demo Dealer',
    `demo+${stamp}@unitnavigator.demo`,
    bcrypt.hashSync(password, 10)
  );

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userInfo.lastInsertRowid);
  const dealership = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(dealershipId);
  const token = signUser(user, dealership, { demo: true });
  res.json({ token, user: userPayload(user, dealership, { demo: true }) });
});

router.post('/demo-clear', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.json({ ok: true });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    if (user.demo) cleanupDemoDealership(user.dealership_id);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

router.get('/me', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    res.json({ user });
  } catch {
    res.status(401).json({ error: 'Invalid session' });
  }
});

module.exports = router;
