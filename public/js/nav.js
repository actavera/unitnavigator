const UN = {
  getToken() { return localStorage.getItem('un_session'); },
  setToken(t) { localStorage.setItem('un_session', t); },
  clearToken() { localStorage.removeItem('un_session'); localStorage.removeItem('un_user'); },
  getTheme() { return localStorage.getItem('un_theme') || 'dark'; },
  setTheme(theme) {
    localStorage.setItem('un_theme', theme);
    UN.applyTheme();
    UN.syncThemeToggle();
  },
  applyTheme() {
    const theme = UN.getTheme() === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
  },
  syncThemeToggle() {
    const theme = UN.getTheme() === 'light' ? 'light' : 'dark';
    document.querySelectorAll('[data-theme-option]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeOption === theme);
      btn.setAttribute('aria-pressed', String(btn.dataset.themeOption === theme));
    });
    document.querySelectorAll('[data-theme-logo]').forEach(img => {
      img.src = theme === 'light'
        ? '/assets/unit-navigator-logo-transparent.png'
        : '/assets/unit-navigator-logo-on-dark.png';
    });
  },
  getUser() {
    try { return JSON.parse(localStorage.getItem('un_user') || 'null'); } catch { return null; }
  },
  setUser(u) { localStorage.setItem('un_user', JSON.stringify(u)); },

  headers() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${UN.getToken()}` };
  },

  async api(method, path, body) {
    const opts = { method, headers: UN.headers() };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  },

  requireAuth() {
    if (!UN.getToken()) { location.href = '/login'; return false; }
    return true;
  },

  logout() {
    UN.clearToken();
    location.href = '/login';
  },

  renderNav(containerId = 'nav-container') {
    const user = UN.getUser();
    const el = document.getElementById(containerId);
    if (!el) return;
    const initials = user?.name ? user.name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase() : '?';
    const canSeeAdmin = user?.role === 'super_admin' || String(user?.email || '').toLowerCase() === 'admin@unitnavigator.com';
    const canSeeSettings = ['super_admin', 'admin', 'manager'].includes(user?.role);
    const adminLink = canSeeAdmin ? '<a class="nav-menu-item" href="/admin">Admin</a>' : '';
    const settingsLink = canSeeSettings ? '<a class="nav-menu-item" href="/settings">Dealership Settings</a>' : '';
    const bulkImportLink = canSeeSettings ? '<a class="nav-menu-item" href="/inventory/import">Bulk Import Inventory</a>' : '';
    el.innerHTML = `
      <nav class="nav">
        <a href="/home" class="nav-logo" aria-label="Unit Navigator home">
          <img data-theme-logo src="/assets/unit-navigator-logo-on-dark.png" alt="Unit Navigator">
        </a>
        <div class="nav-right">
          <div class="theme-toggle" aria-label="Theme">
            <button type="button" data-theme-option="light" onclick="UN.setTheme('light')" aria-pressed="false">Light</button>
            <button type="button" data-theme-option="dark" onclick="UN.setTheme('dark')" aria-pressed="true">Dark</button>
          </div>
          <div class="nav-account">
            <button class="nav-account-trigger" type="button" aria-haspopup="menu" aria-expanded="false" onclick="UN.toggleAccountMenu(event)">
              <span class="nav-user">${user?.name || ''}</span>
              <span class="nav-avatar">${initials}</span>
            </button>
            <div class="nav-account-menu" role="menu">
              ${adminLink}
              ${settingsLink}
              ${bulkImportLink}
              <button class="nav-menu-item danger" type="button" onclick="UN.logout()">Log out</button>
            </div>
          </div>
        </div>
      </nav>`;
    UN.syncThemeToggle();
  },

  toggleAccountMenu(event) {
    event.stopPropagation();
    const account = event.currentTarget.closest('.nav-account');
    document.querySelectorAll('.nav-account.open').forEach(openAccount => {
      if (openAccount !== account) {
        openAccount.classList.remove('open');
        openAccount.querySelector('.nav-account-trigger')?.setAttribute('aria-expanded', 'false');
      }
    });
    const isOpen = account?.classList.toggle('open');
    event.currentTarget.setAttribute('aria-expanded', String(Boolean(isOpen)));
  },

  fmt: {
    money(n) {
      if (n == null || n === '') return '—';
      return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    },
    miles(n) {
      if (n == null) return '—';
      return Number(n).toLocaleString() + ' mi';
    },
    date(s) {
      if (!s) return '—';
      return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },
    ago(s) {
      if (!s) return '—';
      const diff = Date.now() - new Date(s).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    },
    vin(v) { return v ? v.slice(-6).toUpperCase() : '—'; },
    gross(n) {
      if (n == null) return '<span class="money-muted">—</span>';
      const cls = n >= 0 ? 'money-green' : 'money-red';
      return `<span class="${cls}">${n >= 0 ? '+' : ''}${UN.fmt.money(n)}</span>`;
    },
    stageBadge(stage) {
      const labels = { acquired:'At Auction', transport:'Being Transported', screening:'Needs Screening', recon:'Recon', ready:'Ready', pending:'Pending', sold:'Sold', archived:'Archived' };
      return `<span class="badge badge-${stage}">${labels[stage] || stage}</span>`;
    },
  },
};

UN.applyTheme();

document.addEventListener('click', event => {
  if (event.target.closest('.nav-account')) return;
  document.querySelectorAll('.nav-account.open').forEach(account => {
    account.classList.remove('open');
    account.querySelector('.nav-account-trigger')?.setAttribute('aria-expanded', 'false');
  });
});

// Global toast
function toast(msg, type = 'ok') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `show toast-${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}
