const UN = {
  getToken() { return localStorage.getItem('un_session'); },
  setToken(t) { localStorage.setItem('un_session', t); },
  clearToken() { localStorage.removeItem('un_session'); localStorage.removeItem('un_user'); },
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
    el.innerHTML = `
      <nav class="nav">
        <a href="/home" class="nav-logo">
          <img src="/images/logo.png" alt="Unit Navigator">
        </a>
        <div class="nav-right">
          <span class="nav-user">${user?.name || ''}</span>
          <div class="nav-avatar">${initials}</div>
          <button class="nav-logout" onclick="UN.logout()">Log out</button>
        </div>
      </nav>`;
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
      const labels = { acquired:'Acquired', transport:'Transport', recon:'Recon', ready:'Ready', pending:'Pending Deal', sold:'Sold', archived:'Archived' };
      return `<span class="badge badge-${stage}">${labels[stage] || stage}</span>`;
    },
  },
};

// Global toast
function toast(msg, type = 'ok') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `show toast-${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}
