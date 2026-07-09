'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

['data', 'public/uploads/units', 'public/uploads/dealers'].forEach(d => {
  const full = path.join(__dirname, d);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/deals',     require('./routes/deals'));
app.use('/api/credit',    require('./routes/credit'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/paperwork', require('./routes/paperwork'));
app.use('/api/public',    require('./routes/public'));
app.use('/api/admin',     require('./routes/admin'));

function normalizedHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .toLowerCase()
    .split(',')[0]
    .trim()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

function isPlatformHost(req) {
  const host = normalizedHost(req);
  return !host || ['localhost', '127.0.0.1', '::1', 'unitnavigator.com'].includes(host);
}

app.get('/', (req, res) => {
  const file = isPlatformHost(req) ? 'index.html' : 'showroom.html';
  res.sendFile(path.join(__dirname, 'public', file));
});

const staticPages = {
  '/demo':          'demo.html',
  '/showroom':      'showroom.html',
  '/login':         'login.html',
  '/home':          'home.html',
  '/credit/new':    'credit-new.html',
  '/deals':         'deals.html',
  '/customers':     'customers.html',
  '/admin':         'admin.html',
  '/settings':      'settings.html',
  '/paperwork/start':'paperwork-start.html',
  '/inventory':     'inventory.html',
  '/inventory/list':'inventory.html',
  '/inventory/import':'inventory-import.html',
  '/inventory/new': 'inventory-new.html',
};
Object.entries(staticPages).forEach(([route, file]) => {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, 'public', file)));
});
app.get('/inventory/:id', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'inventory-detail.html'))
);
app.get('/showroom/:id', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'showroom-detail.html'))
);

app.listen(PORT, () => console.log(`Unit Navigator → http://localhost:${PORT}`));
