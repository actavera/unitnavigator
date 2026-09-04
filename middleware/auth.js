'use strict';
const jwt = require('jsonwebtoken');
const db = require('../database');
const JWT_SECRET = process.env.JWT_SECRET || 'un-dev-secret-change-in-prod';

const ALL_PERMISSIONS = [
  'inventory_view',
  'inventory_add',
  'inventory_edit',
  'inventory_pricing',
  'inventory_import',
  'inventory_export',
  'inventory_delete',
  'deals_view',
  'deals_manage',
  'paperwork_manage',
  'contracts_manage',
  'reports_view',
  'settings_manage',
  'users_manage',
  'credit_pull',
];

const ROLE_DEFAULTS = {
  super_admin: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  manager: ALL_PERMISSIONS,
  staff: ['inventory_view', 'inventory_add', 'inventory_edit', 'deals_view', 'reports_view'],
};

function parsePermissions(value, role = 'staff') {
  if (role === 'super_admin') return [...ALL_PERMISSIONS];
  if (value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(p => ALL_PERMISSIONS.includes(p));
    } catch {}
  }
  return [...(ROLE_DEFAULTS[role] || ROLE_DEFAULTS.staff)];
}

function hasPermission(user, permission) {
  if (!permission) return true;
  if (user?.role === 'super_admin' || user?.role === 'admin') return true;
  return Array.isArray(user?.permissions) && user.permissions.includes(permission);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(`
      SELECT u.id, u.role, u.permissions, u.status, d.status AS dealership_status
      FROM users u
      LEFT JOIN dealerships d ON d.id = u.dealership_id
      WHERE u.id = ?
    `).get(req.user.id);
    if (!user || user.status === 'revoked' || user.dealership_status === 'revoked') {
      return res.status(403).json({ error: 'Access revoked' });
    }
    req.user.role = user.role;
    req.user.permissions = parsePermissions(user.permissions, user.role);
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

function requirePermission(permission) {
  return [requireAuth, (req, res, next) => {
    if (!hasPermission(req.user, permission)) {
      return res.status(403).json({ error: 'You do not have access to this feature' });
    }
    next();
  }];
}

module.exports = { requireAuth, requireRole, requirePermission, hasPermission, parsePermissions, ALL_PERMISSIONS, JWT_SECRET };
