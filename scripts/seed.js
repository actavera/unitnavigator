'use strict';
const bcrypt = require('bcryptjs');
const db = require('../database');

const dealership = db.prepare(`INSERT OR IGNORE INTO dealerships (name) VALUES (?)`).run('My Dealership');
const dealershipId = dealership.lastInsertRowid ||
  db.prepare(`SELECT id FROM dealerships LIMIT 1`).get().id;

const hash = bcrypt.hashSync('Admin2026!', 12);
db.prepare(`
  INSERT OR IGNORE INTO users (dealership_id, name, email, password_hash, role)
  VALUES (?, ?, ?, ?, 'super_admin')
`).run(dealershipId, 'Admin', 'admin@unitnavigator.com', hash);

db.prepare(`
  UPDATE users
  SET role = 'super_admin', status = 'active'
  WHERE lower(email) = 'admin@unitnavigator.com'
`).run();

console.log('Seed complete.');
console.log('  Email:    admin@unitnavigator.com');
console.log('  Password: Admin2026!');
console.log('  Role:     super_admin');
