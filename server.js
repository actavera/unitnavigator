'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./database');

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

function normalizeDomain(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .trim();
}

function publicDealerForRequest(req) {
  const requested = String(req.query.dealer || req.params.dealerSlug || '').trim().toLowerCase();
  const host = normalizedHost(req);

  if (requested) {
    const bySlug = db.prepare(`
      SELECT * FROM dealerships
      WHERE status = 'active'
        AND COALESCE(public_site_enabled, 1) = 1
        AND (lower(public_slug) = ? OR CAST(id AS TEXT) = ?)
      LIMIT 1
    `).get(requested, requested);
    if (bySlug) return bySlug;
  }

  if (host && !['localhost', '127.0.0.1', '::1', 'unitnavigator.com'].includes(host)) {
    return db.prepare(`
      SELECT * FROM dealerships
      WHERE status = 'active'
        AND COALESCE(public_site_enabled, 1) = 1
        AND COALESCE(public_domain, '') != ''
    `).all().find(row => normalizeDomain(row.public_domain) === host);
  }

  return null;
}

function publicUrl(req, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'unitnavigator.com';
  return `${proto}://${host}${text.startsWith('/') ? '' : '/'}${text}`;
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

function showroomMeta(req) {
  const dealer = publicDealerForRequest(req);
  const dealerName = dealer?.name || dealer?.legal_name || 'Unit Navigator';
  const title = dealer?.public_share_title || `${dealerName} Inventory`;
  const description = dealer?.public_share_description || `Browse available vehicles from ${dealerName}.`;
  const image = publicUrl(req, dealer?.public_share_image_url || dealer?.logo_url || '/assets/unit-navigator-logo-transparent.png');
  const url = publicUrl(req, req.originalUrl || req.url || '/showroom');
  return `
  <title>${htmlEscape(title)}</title>
  <meta name="description" content="${htmlEscape(description)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${htmlEscape(title)}">
  <meta property="og:description" content="${htmlEscape(description)}">
  <meta property="og:image" content="${htmlEscape(image)}">
  <meta property="og:url" content="${htmlEscape(url)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${htmlEscape(title)}">
  <meta name="twitter:description" content="${htmlEscape(description)}">
  <meta name="twitter:image" content="${htmlEscape(image)}">`;
}

function sendShowroom(req, res) {
  const file = path.join(__dirname, 'public', 'showroom.html');
  const html = fs.readFileSync(file, 'utf8').replace(
    '<title>Inventory Showroom - Unit Navigator</title>',
    showroomMeta(req),
  );
  res.type('html').send(html);
}

app.get('/', (req, res) => {
  if (isPlatformHost(req)) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  return sendShowroom(req, res);
});

app.get('/deals/new', (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, `/paperwork/start${query}`);
});

const staticPages = {
  '/demo':          'demo.html',
  '/login':         'login.html',
  '/home':          'home.html',
  '/credit/new':    'credit-new.html',
  '/deals':         'deals.html',
  '/customers':     'customers.html',
  '/admin':         'admin.html',
  '/admin/sold-vehicle-data': 'admin-sold-data.html',
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
app.get('/showroom', sendShowroom);
app.get('/inventory/:id', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'inventory-detail.html'))
);
app.get('/showroom/:id', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'showroom-detail.html'))
);

app.get('/:dealerSlug', (req, res, next) => {
  const slug = String(req.params.dealerSlug || '').trim().toLowerCase();
  if (!slug || slug.includes('.') || ['api', 'assets', 'css', 'js', 'uploads', 'marketing'].includes(slug)) return next();
  req.query.dealer = slug;
  sendShowroom(req, res);
});

app.listen(PORT, () => console.log(`Unit Navigator → http://localhost:${PORT}`));
