'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { JWT_SECRET } = require('../middleware/auth');

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
  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, dealership_id: user.dealership_id },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, dealership: dealership?.name } });
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
