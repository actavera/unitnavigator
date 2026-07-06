'use strict';
const jwt = require('jsonwebtoken');
const db = require('../database');
const JWT_SECRET = process.env.JWT_SECRET || 'un-dev-secret-change-in-prod';

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(`
      SELECT u.id, u.role, u.status, d.status AS dealership_status
      FROM users u
      LEFT JOIN dealerships d ON d.id = u.dealership_id
      WHERE u.id = ?
    `).get(req.user.id);
    if (!user || user.status === 'revoked' || user.dealership_status === 'revoked') {
      return res.status(403).json({ error: 'Access revoked' });
    }
    req.user.role = user.role;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireRole(...roles) {
  return [requireAuth, (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  }];
}

module.exports = { requireAuth, requireRole, JWT_SECRET };
