'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

['data', 'public/uploads/units'].forEach(d => {
  const full = path.join(__dirname, d);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/deals',     require('./routes/deals'));
app.use('/api/credit',    require('./routes/credit'));
app.use('/api/paperwork', require('./routes/paperwork'));

const staticPages = {
  '/':              'index.html',
  '/login':         'login.html',
  '/home':          'home.html',
  '/inventory':     'inventory.html',
  '/inventory/new': 'inventory-new.html',
};
Object.entries(staticPages).forEach(([route, file]) => {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, 'public', file)));
});
app.get('/inventory/:id', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'inventory-detail.html'))
);

app.listen(PORT, () => console.log(`Unit Navigator → http://localhost:${PORT}`));
