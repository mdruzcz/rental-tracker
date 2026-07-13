// Rental Tracker — single-page front end
(function () {
  'use strict';

  // ---------- utilities ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  };
  const fmtMoney = (n) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n || 0);
  const fmtDate = (d) => {
    if (!d) return '';
    // Parse YYYY-MM-DD as local date to avoid UTC timezone shift
    const parts = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (parts) {
      const dt = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
      return dt.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
    }
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const isoToday = () => {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  };
  const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const pct = (x) => (x == null ? '—' : (Math.round(x * 1000) / 10) + '%');

  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('error', 'success');
    if (kind) t.classList.add(kind);
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 2800);
  }

  // ---------- auth (Supabase, dependency-free) ----------
  const Auth = {
    url: null, anonKey: null, session: null,
    async loadConfig() {
      if (this.url) return;
      const cfg = await fetch('/api/public/auth-config').then(r => r.json());
      this.url = cfg.url; this.anonKey = cfg.anonKey;
    },
    restore() { try { this.session = JSON.parse(localStorage.getItem('rt_session') || 'null'); } catch (e) { this.session = null; } return this.session; },
    persist() { if (this.session) localStorage.setItem('rt_session', JSON.stringify(this.session)); else localStorage.removeItem('rt_session'); },
    isValid() { return !!(this.session && this.session.access_token && this.session.expires_at && (this.session.expires_at * 1000 - 30000) > Date.now()); },
    _setFromResponse(data, fallbackEmail) {
      this.session = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at, email: (data.user && data.user.email) || fallbackEmail };
      this.persist();
    },
    async login(email, password) {
      await this.loadConfig();
      const r = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: this.anonKey },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error_description || data.msg || data.error || 'Login failed');
      this._setFromResponse(data, email);
    },
    async refresh() {
      if (!this.session || !this.session.refresh_token) return false;
      await this.loadConfig();
      const r = await fetch(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: this.anonKey },
        body: JSON.stringify({ refresh_token: this.session.refresh_token }),
      });
      if (!r.ok) { this.logout(); return false; }
      const data = await r.json().catch(() => ({}));
      this._setFromResponse(data, this.session.email);
      return true;
    },
    logout() { this.session = null; this.persist(); },
    async updatePassword(newPassword) {
      const token = await this.token();
      if (!token) throw new Error('not signed in');
      const r = await fetch(`${this.url}/auth/v1/user`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', apikey: this.anonKey, Authorization: 'Bearer ' + token },
        body: JSON.stringify({ password: newPassword }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error_description || data.msg || data.error || 'Password change failed');
      return data;
    },
    async token() {
      if (this.isValid()) return this.session.access_token;
      if (this.session && this.session.refresh_token) { if (await this.refresh()) return this.session.access_token; }
      return null;
    },
  };

  async function api(method, url, body) {
    const token = await Auth.token();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (r.status === 401) {
      Auth.logout();
      if (typeof showLogin === 'function') showLogin('Your session expired — please sign in again.');
      throw new Error('login required');
    }
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).error || msg; } catch (e) {}
      toast(msg, 'error');
      throw new Error(msg);
    }
    return r.json();
  }
  const API = {
    properties: { list: () => api('GET', '/api/properties'), create: (b) => api('POST', '/api/properties', b), update: (id, b) => api('PUT', `/api/properties/${id}`, b), remove: (id) => api('DELETE', `/api/properties/${id}`) },
    bookingTypes: { list: () => api('GET', '/api/booking-types'), create: (b) => api('POST', '/api/booking-types', b), remove: (id) => api('DELETE', `/api/booking-types/${id}`) },
    bookings: { list: () => api('GET', '/api/bookings'), create: (b) => api('POST', '/api/bookings', b), bulk: (rows) => api('POST', '/api/bookings/bulk', rows), update: (id, b) => api('PUT', `/api/bookings/${id}`, b), remove: (id) => api('DELETE', `/api/bookings/${id}`) },
    guests: { list: () => api('GET', '/api/guests'), create: (b) => api('POST', '/api/guests', b), update: (id, b) => api('PUT', `/api/guests/${id}`, b), remove: (id) => api('DELETE', `/api/guests/${id}`) },
    cleaners: { list: () => api('GET', '/api/cleaners'), create: (b) => api('POST', '/api/cleaners', b), update: (id, b) => api('PUT', `/api/cleaners/${id}`, b), remove: (id) => api('DELETE', `/api/cleaners/${id}`) },
    cleanerTasks: { list: () => api('GET', '/api/cleaner-tasks'), create: (b) => api('POST', '/api/cleaner-tasks', b), update: (id, b) => api('PUT', `/api/cleaner-tasks/${id}`, b), remove: (id) => api('DELETE', `/api/cleaner-tasks/${id}`), notify: (id) => api('POST', `/api/cleaner-tasks/${id}/notify`) },
    maintenance: { list: (propertyId) => api('GET', `/api/maintenance${propertyId ? '?property_id=' + propertyId : ''}`), create: (b) => api('POST', '/api/maintenance', b), update: (id, b) => api('PUT', `/api/maintenance/${id}`, b), remove: (id) => api('DELETE', `/api/maintenance/${id}`) },
    bookingRequests: {
      list: () => api('GET', '/api/booking-requests'),
      approve: (id) => api('PUT', `/api/booking-requests/${id}/approve`),
      reject: (id) => api('PUT', `/api/booking-requests/${id}/reject`),
      remove: (id) => api('DELETE', `/api/booking-requests/${id}`),
    },
    todos: {
      list: () => api('GET', '/api/todos'),
      create: (b) => api('POST', '/api/todos', b),
      update: (id, b) => api('PUT', `/api/todos/${id}`, b),
      remove: (id) => api('DELETE', `/api/todos/${id}`),
    },
    licensing: {
      list: (propertyId) => api('GET', `/api/licensing${propertyId ? '?property_id=' + propertyId : ''}`),
      create: (b) => api('POST', '/api/licensing', b),
      update: (id, b) => api('PUT', `/api/licensing/${id}`, b),
      remove: (id) => api('DELETE', `/api/licensing/${id}`),
      seed: (propertyId) => api('POST', `/api/licensing/seed/${propertyId}`),
      upload: async (id, formData) => {
        const token = await Auth.token();
        const r = await fetch(`/api/licensing/${id}/upload`, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: formData });
        if (!r.ok) { let m = 'upload failed'; try { m = (await r.json()).error || m; } catch (e) {} toast(m, 'error'); throw new Error(m); }
        return r.json();
      },
      deleteFile: (id, objectPath) => api('DELETE', `/api/licensing/${id}/attachment?path=${encodeURIComponent(objectPath)}`),
    },
    sync: (id) => api('POST', `/api/sync/${id}`),
    syncAll: () => api('POST', '/api/sync-all'),
    calendar: () => api('GET', '/api/calendar'),
    conflicts: () => api('GET', '/api/conflicts'),
    claimSynced: (id, b) => api('POST', `/api/synced-events/${id}/claim`, b),
    blocks: {
      list: () => api('GET', '/api/blocks'),
      create: (b) => api('POST', '/api/blocks', b),
      update: (id, b) => api('PUT', `/api/blocks/${id}`, b),
      remove: (id) => api('DELETE', `/api/blocks/${id}`),
    },
    // --- Profit & automation (Phases C–H) ---
    expenses: {
      list: (params) => api('GET', '/api/expenses' + (params ? '?' + new URLSearchParams(params) : '')),
      create: (b) => api('POST', '/api/expenses', b),
      update: (id, b) => api('PUT', `/api/expenses/${id}`, b),
      remove: (id) => api('DELETE', `/api/expenses/${id}`),
    },
    upsells: {
      list: () => api('GET', '/api/upsells'),
      create: (b) => api('POST', '/api/upsells', b),
      update: (id, b) => api('PUT', `/api/upsells/${id}`, b),
      remove: (id) => api('DELETE', `/api/upsells/${id}`),
    },
    bookingUpsells: {
      list: (bookingId) => api('GET', `/api/booking-upsells?booking_id=${bookingId}`),
      create: (b) => api('POST', '/api/booking-upsells', b),
      remove: (id) => api('DELETE', `/api/booking-upsells/${id}`),
    },
    reviews: {
      list: () => api('GET', '/api/reviews'),
      create: (b) => api('POST', '/api/reviews', b),
      update: (id, b) => api('PUT', `/api/reviews/${id}`, b),
      remove: (id) => api('DELETE', `/api/reviews/${id}`),
    },
    settings: {
      get: () => api('GET', '/api/settings'),
      update: (b) => api('PUT', '/api/settings', b),
    },
    bookingTypeUpdate: (id, b) => api('PUT', `/api/booking-types/${id}`, b),
    financials: (year, propertyId) => api('GET', '/api/financials?' + new URLSearchParams({ ...(year ? { year } : {}), ...(propertyId ? { property_id: propertyId } : {}) })),
    propertyStats: () => api('GET', '/api/property-stats'),
    insights: () => api('GET', '/api/insights'),
    roi: { get: (year) => api('GET', '/api/roi' + (year ? '?year=' + year : '')), save: (b) => api('PUT', '/api/roi', b) },
    listingMeta: (id, b) => api('PUT', `/api/properties/${id}/listing-meta`, b),
    orphans: () => api('GET', '/api/orphans'),
    messageTemplates: { list: () => api('GET', '/api/message-templates'), update: (id, b) => api('PUT', `/api/message-templates/${id}`, b) },
    messagesScheduled: () => api('GET', '/api/messages/scheduled'),
    sendMessage: (b) => api('POST', '/api/messages/send', b),
    pricelabs: { listings: () => api('GET', '/api/pricelabs/listings'), refresh: () => api('POST', '/api/pricelabs/refresh') },
    pricing: () => api('GET', '/api/pricing'),
    quote: (propertyId, from, to) => api('GET', `/api/quote?property_id=${propertyId}&from=${from}&to=${to}`),
    annualPrediction: { get: (year) => api('GET', '/api/annual-prediction' + (year ? '?year=' + year : '')), save: (b) => api('PUT', '/api/annual-prediction', b) },
    ltr: {
      overview: () => api('GET', '/api/ltr'),
      updateListing: (id, b) => api('PUT', `/api/properties/${id}/ltr`, b),
      uploadPhotos: async (id, formData) => {
        const token = await Auth.token();
        const r = await fetch(`/api/properties/${id}/ltr-photos`, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: formData });
        if (!r.ok) { let m = 'upload failed'; try { m = (await r.json()).error || m; } catch (e) {} toast(m, 'error'); throw new Error(m); }
        return r.json();
      },
      deletePhoto: (id, p) => api('DELETE', `/api/properties/${id}/ltr-photo?path=${encodeURIComponent(p)}`),
    },
    ltrApplicants: {
      list: (pid) => api('GET', '/api/ltr-applicants' + (pid ? '?property_id=' + pid : '')),
      create: (b) => api('POST', '/api/ltr-applicants', b),
      update: (id, b) => api('PUT', `/api/ltr-applicants/${id}`, b),
      remove: (id) => api('DELETE', `/api/ltr-applicants/${id}`),
    },
    dashboard: () => api('GET', '/api/dashboard'),
    mailingList: () => api('GET', '/api/mailing-list'),
    notifyGuest: (bookingId, body) => api('POST', `/api/bookings/${bookingId}/notify-guest`, body || {}),
    smsMessages: {
      list: (params) => api('GET', `/api/sms-messages${params ? '?' + new URLSearchParams(params) : ''}`),
      markRead: (id) => api('PUT', `/api/sms-messages/${id}/read`),
    },
  };

  // ---------- modal ----------
  function openModal(title, bodyEl) {
    $('#modalTitle').textContent = title;
    const body = $('#modalBody');
    body.innerHTML = '';
    body.appendChild(bodyEl);
    $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modal').classList.add('hidden'); }
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  function formField(label, input, opts) {
    return el('label', { class: (opts && opts.full) ? 'full' : null },
      el('span', { class: 'lbl' }, label), input);
  }
  function input(name, opts) {
    const o = opts || {};
    const i = el('input', { name, type: o.type || 'text', value: o.value == null ? '' : String(o.value), placeholder: o.placeholder || '', step: o.step });
    if (o.required) i.required = true;
    return i;
  }
  function select(name, options, value) {
    const s = el('select', { name });
    for (const opt of options) {
      const o = el('option', { value: opt.value }, opt.label);
      if (String(value || '') === String(opt.value)) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }
  function textarea(name, value, opts) {
    return el('textarea', { name, rows: (opts && opts.rows) || 3, placeholder: (opts && opts.placeholder) || '' }, value || '');
  }
  function readForm(formEl) {
    const out = {};
    for (const f of formEl.elements) {
      if (!f.name) continue;
      out[f.name] = f.type === 'checkbox' ? f.checked : f.value;
    }
    return out;
  }

  // ---------- router ----------
  const VIEWS = {};
  const TOOL_VIEWS = new Set(['ltr', 'annual', 'roi', 'pricing', 'requests', 'todos', 'guests', 'bulk', 'mailing', 'maintenance', 'cleanerCal', 'licensing', 'smsInbox', 'expenses', 'messaging', 'reviews', 'upsellCatalog', 'settings', 'cleaners']);
  function setView(name) {
    $$('.tab').forEach(b => {
      if (b.classList.contains('tools-toggle')) {
        b.classList.toggle('active', TOOL_VIEWS.has(name));
      } else {
        b.classList.toggle('active', b.dataset.view === name);
      }
    });
    $$('.dropdown-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    closeToolsDropdown();
    const main = $('#app');
    main.innerHTML = '';
    main.scrollTop = 0;
    const fn = VIEWS[name] || VIEWS.dashboard;
    Promise.resolve(fn(main)).catch(e => console.error(e));
  }
  // Top-level tabs (those with data-view) — Tools toggle handled separately
  $$('.tab[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('.dropdown-item').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

  // Tools dropdown
  function openToolsDropdown() { $('#toolsDropdown').classList.remove('hidden'); }
  function closeToolsDropdown() { $('#toolsDropdown').classList.add('hidden'); }
  $('#toolsToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('#toolsDropdown');
    if (dd.classList.contains('hidden')) openToolsDropdown(); else closeToolsDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#toolsDropdown') && !e.target.closest('#toolsToggle')) closeToolsDropdown();
  });

  $('#syncAllBtn').addEventListener('click', async () => {
    toast('Syncing calendars...');
    try {
      const out = await API.syncAll();
      const total = out.reduce((acc, p) => acc + (p.results || []).reduce((a, r) => a + (r.count || 0), 0), 0);
      const cancelled = out.flatMap(p => (p.cancelled || []).map(c => ({ ...c, nickname: p.nickname })));
      toast(`Sync complete: ${total} events imported`, 'success');
      if (cancelled.length) {
        const names = cancelled.map(c => `${c.contact_name || 'Guest'} (${c.nickname})`).join(', ');
        toast(`Auto-cancelled ${cancelled.length} booking${cancelled.length > 1 ? 's' : ''} removed from the platform: ${names}`, 'error');
      }
      const active = $('.tab.active').dataset.view;
      setView(active);
    } catch (e) {}
  });

  // Background: refresh badges so the user sees inbound public bookings + overdue tasks
  async function refreshBadges() {
    try {
      const [reqs, todos] = await Promise.all([
        API.bookingRequests.list().catch(() => []),
        API.todos.list().catch(() => []),
      ]);
      const pending = reqs.filter(r => r.status === 'pending').length;
      const reqBadge = $('#requestsBadge');
      if (pending > 0) { reqBadge.textContent = pending; reqBadge.classList.remove('hidden'); }
      else reqBadge.classList.add('hidden');

      const today = isoToday();
      const overdueOrToday = todos.filter(t => t.status === 'open' && t.due_date && t.due_date <= today).length;
      const todoBadge = $('#todosBadge');
      if (overdueOrToday > 0) { todoBadge.textContent = overdueOrToday; todoBadge.classList.remove('hidden'); }
      else todoBadge.classList.add('hidden');

      // Aggregate badge on the collapsed "More" menu so attention items aren't hidden.
      const moreBadge = $('#moreBadge');
      const moreTotal = pending + overdueOrToday;
      if (moreBadge) {
        if (moreTotal > 0) { moreBadge.textContent = moreTotal; moreBadge.classList.remove('hidden'); }
        else moreBadge.classList.add('hidden');
      }
    } catch (e) {}
  }
  // refreshBadges + interval are started by startApp() after a successful login.

  function showPotentialBreakdown(pr) {
    const wrap = el('div');
    wrap.appendChild(el('div', { class: 'muted', style: 'margin-bottom:10px;' },
      `Estimated revenue if every vacant night (in gaps of 3+ nights) were booked from ${fmtDate(pr.start)} through ${fmtDate(pr.end)}, at PriceLabs rates (or each property's average nightly rate).`));
    if (!pr.by_property || !pr.by_property.length) { wrap.appendChild(el('div', { class: 'empty' }, 'Nothing to project.')); }
    else {
      wrap.appendChild(simpleTable(
        ['Property', { label: 'Fillable nights', num: true }, { label: 'Potential', num: true }, 'Based on'],
        pr.by_property.map(p => [p.nickname, p.fillable_nights, fmtMoney(p.potential_revenue), p.rate_source])));
      wrap.appendChild(el('div', { style: 'text-align:right;font-size:18px;font-weight:700;margin-top:10px;color:var(--success);' }, 'Total: ' + fmtMoney(pr.total)));
    }
    openModal('Potential remaining revenue', wrap);
  }

  // ---------- DASHBOARD ----------
  VIEWS.dashboard = async (root) => {
    const d = await API.dashboard();
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, `Dashboard — ${d.year}`),
      el('div', { class: 'muted' }, `All-time earnings: ${fmtMoney(d.all_time_earnings)} • ${d.all_time_bookings} bookings`)
    ));

    const goCal = (hl, date) => { calHighlight = hl; calJumpDate = date || null; setView('calendar'); };
    const conflictKpi = el('div', { onclick: () => goCal('conflicts', d.conflicts && d.conflicts[0] && d.conflicts[0].overlap_start), style: 'cursor:pointer;' },
      kpi('Booking Conflicts', d.conflict_count || 0, d.conflict_count > 0 ? 'double-bookings — review now' : 'no overlaps', d.conflict_count > 0 ? 'danger' : 'success'));
    const fin = d.financials || {};
    const netKpi = el('div', { onclick: () => setView('financials'), style: 'cursor:pointer;' },
      kpi('Net Profit (YTD)', fmtMoney(fin.net_profit || 0), `${((fin.margin || 0) * 100).toFixed(0)}% margin · ${fmtMoney(fin.total_expenses || 0)} costs`, 'success'));
    const orphanKpi = el('div', { onclick: () => goCal('orphans', d.orphans && d.orphans[0] && d.orphans[0].gap_start), style: 'cursor:pointer;' },
      kpi('Orphan Nights', d.orphan_nights || 0, d.orphan_count > 0 ? `${d.orphan_count} fillable gap(s)` : 'none', d.orphan_count > 0 ? 'warn' : null));
    const pr = d.potential_revenue || { total: 0, by_property: [], fillable_nights: 0 };
    const potentialKpi = el('div', { onclick: () => showPotentialBreakdown(pr), style: 'cursor:pointer;' },
      kpi('Potential Remaining', fmtMoney(pr.total), `if ${pr.fillable_nights || 0} vacant nights filled (3+ night stays)`, pr.total > 0 ? 'success' : null));
    root.appendChild(el('div', { class: 'kpi-grid' },
      conflictKpi,
      netKpi,
      potentialKpi,
      kpi('YTD Earnings', fmtMoney(d.ytd_earnings), `${d.ytd_bookings} bookings`, 'success'),
      el('div', { onclick: () => setView('financials'), style: 'cursor:pointer;' },
        kpi('Tax Set-Aside', fmtMoney(fin.tax_setaside || 0), `${fin.tax_setaside_percent || 0}% of net`, 'warn')),
      orphanKpi,
      kpi('YTD Nights Booked', d.ytd_nights, 'nights occupied YTD'),
      kpi('Avg / Booking (YTD)', fmtMoney(d.avg_per_booking_ytd), 'average revenue per booking'),
      el('div', { onclick: () => setView('needsDetails'), style: 'cursor:pointer;' },
        kpi('Reservations Needing Details', d.unconfirmed_reservations || 0, d.unconfirmed_reservations > 0 ? 'click to add amount/guest' : 'all synced stays confirmed', d.unconfirmed_reservations > 0 ? 'warn' : null)),
      kpi('Upcoming Bookings', d.upcoming.length, d.upcoming[0] ? `Next: ${fmtDate(d.upcoming[0].check_in)}` : 'none'),
      kpi('Pending Requests', d.pending_requests || 0, 'from public booking page', d.pending_requests > 0 ? 'warn' : null),
      kpi('Open To-Dos', d.open_todo_count || 0, d.overdue_todo_count > 0 ? `${d.overdue_todo_count} overdue` : 'none overdue', d.overdue_todo_count > 0 ? 'warn' : null),
      kpi('Licensing', `${d.licensed_properties || 0}/${d.total_properties || 0}`, d.upcoming_renewals > 0 ? `${d.upcoming_renewals} renewal(s) in 90 days` : (d.pending_licensing_steps > 0 ? `${d.pending_licensing_steps} steps remaining` : 'all clear'), d.licensed_properties < d.total_properties ? 'warn' : 'success'),
      kpi('Out-of-stock items', d.low_stock_count, 'across all properties', d.low_stock_count > 0 ? 'warn' : null),
    ));

    // Double-booking alert — the command center's #1 job.
    if (d.conflicts && d.conflicts.length) {
      const cCard = el('div', { class: 'card conflict-card' });
      cCard.appendChild(el('div', { class: 'between' },
        el('h2', null, '⚠️ Booking Conflicts (' + d.conflicts.length + ')'),
        el('button', { class: 'btn-ghost small', onclick: () => goCal('conflicts', d.conflicts[0] && d.conflicts[0].overlap_start) }, 'Open calendar →'),
      ));
      cCard.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px;' },
        'Two guest reservations overlap at the same property. Resolve before they collide.'));
      d.conflicts.forEach(c => {
        const fmtSide = s => `${s.guest_name || (s.kind === 'reserved' ? 'Unconfirmed ' + (s.source || '') : 'Booking')} (${fmtDate(s.start)}→${fmtDate(s.end)}, ${s.source || ''})`;
        cCard.appendChild(el('div', { class: 'conflict-row', style: 'padding:8px 0;border-top:1px solid #fee2e2;' },
          el('strong', null, c.property_name || 'Property'),
          el('div', { style: 'font-size:13px;' }, fmtSide(c.a) + '  ✕  ' + fmtSide(c.b)),
          el('div', { class: 'muted', style: 'font-size:12px;' }, 'Overlap from ' + fmtDate(c.overlap_start)),
        ));
      });
      root.appendChild(cCard);
    }

    // Orphan / gap-night opportunities
    if (d.orphans && d.orphans.length) {
      const oCard = el('div', { class: 'card', style: 'border-color:#fde68a;background:#fffbeb;' });
      oCard.appendChild(el('div', { class: 'between' }, el('h2', null, '🔆 Fillable Gap Nights (' + d.orphans.length + ')'),
        el('button', { class: 'btn-ghost small', onclick: () => goCal('orphans', d.orphans[0] && d.orphans[0].gap_start) }, 'Open calendar →')));
      oCard.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px;' }, 'Short empty gaps between bookings — drop the rate or set a min-stay to fill them before they\'re lost.'));
      d.orphans.forEach(o => oCard.appendChild(el('div', { style: 'padding:6px 0;border-top:1px solid #fde68a;font-size:13px;' },
        el('strong', null, o.property_name || 'Property'), ` — ${o.nights} night${o.nights > 1 ? 's' : ''}: ${fmtDate(o.gap_start)} → ${fmtDate(o.gap_end)}`)));
      root.appendChild(oCard);
    }

    // Unread SMS messages
    const smsMessages = await API.smsMessages.list();
    const unread = smsMessages.filter(m => m.direction === 'inbound' && !m.read);
    if (unread.length) {
      const smsCard = el('div', { class: 'card' });
      smsCard.appendChild(el('div', { class: 'between' },
        el('h2', null, '📬 Unread Messages (' + unread.length + ')'),
        el('button', { class: 'btn-ghost small', onclick: () => setView('smsInbox') }, 'Open Inbox →'),
      ));
      unread.forEach(m => {
        const who = m.guest_name || m.cleaner_name || m.from_number;
        const role = m.guest_name ? 'Guest' : m.cleaner_name ? 'Cleaner' : '';
        const row = el('div', { class: 'sms-row inbound unread', style: 'margin-bottom:6px;' });
        row.appendChild(el('div', { class: 'sms-icon' }, '📩'));
        const body = el('div', { class: 'sms-body' });
        body.appendChild(el('div', { class: 'sms-header' },
          el('strong', null, who),
          role ? el('span', { class: 'badge', style: 'margin-left:6px;' }, role) : null,
          el('span', { class: 'muted', style: 'margin-left:auto; font-size:12px;' }, fmtDate(m.received_at)),
        ));
        body.appendChild(el('div', { class: 'sms-text' }, m.body || '(empty)'));
        const markBtn = el('button', { class: 'btn-ghost small', style: 'margin-top:4px;', onclick: async () => {
          await API.smsMessages.markRead(m.id);
          row.remove();
          const remaining = smsCard.querySelectorAll('.sms-row').length;
          if (!remaining) smsCard.remove();
          else smsCard.querySelector('h2').textContent = '📬 Unread Messages (' + remaining + ')';
        }}, 'Mark read');
        body.appendChild(markBtn);
        row.appendChild(body);
        smsCard.appendChild(row);
      });
      root.appendChild(smsCard);
    }

    // Upcoming + high-priority To-Dos
    const todoCard = el('div', { class: 'card' });
    todoCard.appendChild(el('div', { class: 'between' },
      el('h2', null, 'Tasks for this week'),
      el('button', { class: 'btn-ghost small', onclick: () => setView('todos') }, 'See all →'),
    ));
    todoCard.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px;' },
      'Tasks due in the next 7 days, plus High-priority items without a date.'
    ));
    if (!d.upcoming_todos || !d.upcoming_todos.length) {
      todoCard.appendChild(el('div', { class: 'empty', style: 'padding:16px;' }, 'Nothing due this week. Add a task in the To Do tab.'));
    } else {
      d.upcoming_todos.forEach(t => todoCard.appendChild(renderTodoRow(t, async () => {
        // toggle done from the dashboard
        await API.todos.update(t.id, { status: t.status === 'open' ? 'done' : 'open' });
        setView('dashboard');
      })));
    }
    root.appendChild(todoCard);

    // Vacancy by month
    const vacCard = el('div', { class: 'card' });
    vacCard.appendChild(el('h2', null, 'Vacancy Rate by Month'));
    vacCard.appendChild(el('div', { class: 'muted', style: 'font-size:12px; margin-bottom: 8px;' },
      'Bars show occupancy %. Vacancy = 100% − occupancy. Calculated across all properties combined.'));
    const chart = el('div', { class: 'vac-chart' });
    d.vacancy_by_month.forEach(m => {
      const occ = m.occupancy_rate;
      const vac = m.vacancy_rate;
      const bar = el('div', { class: 'vac-bar', style: `height: ${Math.round(occ * 100)}%;`, title: `${m.label}: ${pct(occ)} occupied (${m.occupied_nights}/${m.available_nights} nights), ${pct(vac)} vacant` });
      const cls = occ > 0.7 ? 'high' : occ < 0.2 ? 'low' : '';
      chart.appendChild(el('div', { class: 'vac-bar-wrap ' + cls },
        el('div', { class: 'vac-bar-value' }, pct(vac)),
        el('div', { class: 'vac-bar-track' }, bar),
        el('div', { class: 'vac-bar-label' }, m.label),
      ));
    });
    vacCard.appendChild(chart);
    root.appendChild(vacCard);

    // ROI by booking type
    const typeCard = el('div', { class: 'card' });
    typeCard.appendChild(el('h2', null, 'Earnings by Booking Type (YTD)'));
    if (!d.by_type.some(t => t.bookings > 0)) {
      typeCard.appendChild(el('div', { class: 'empty' }, 'No bookings yet — add one to see this break down.'));
    } else {
      const tbl = el('table');
      tbl.appendChild(el('thead', null, el('tr', null,
        el('th', null, 'Type'), el('th', { class: 'num' }, 'Bookings'),
        el('th', { class: 'num' }, 'Earnings'), el('th', { class: 'num' }, 'Avg / booking'),
      )));
      const tb = el('tbody');
      d.by_type.forEach(r => tb.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'badge ' + slug(r.type) }, r.type)),
        el('td', { class: 'num' }, String(r.bookings)),
        el('td', { class: 'num' }, fmtMoney(r.earnings)),
        el('td', { class: 'num' }, r.bookings ? fmtMoney(r.earnings / r.bookings) : '—'),
      )));
      tbl.appendChild(tb);
      typeCard.appendChild(tbl);
    }
    root.appendChild(typeCard);

    // Earnings by property — with RevPAR
    const propCard = el('div', { class: 'card' });
    propCard.appendChild(el('h2', null, 'Earnings by Property (YTD)'));
    propCard.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px;' },
      `Occupancy & RevPAR are measured over your rental season (${fmtDate(d.season_start)} → ${fmtDate(d.season_end)}, ${d.season_nights} nights). Occupancy = season nights booked ÷ ${d.season_nights}. ADR = revenue ÷ nights.`
    ));
    if (!d.by_property.length) {
      propCard.appendChild(el('div', { class: 'empty' }, 'Add a property to get started.'));
    } else {
      const tbl = el('table');
      tbl.appendChild(el('thead', null, el('tr', null,
        el('th', null, 'Property'),
        el('th', { class: 'num' }, 'Bookings'),
        el('th', { class: 'num' }, 'Nights'),
        el('th', { class: 'num' }, 'Occupancy'),
        el('th', { class: 'num' }, 'Earnings'),
        el('th', { class: 'num' }, 'ADR'),
        el('th', { class: 'num' }, 'RevPAR'),
      )));
      const tb = el('tbody');
      d.by_property.forEach(r => tb.appendChild(el('tr', null,
        el('td', null, el('strong', null, r.nickname)),
        el('td', { class: 'num' }, String(r.bookings)),
        el('td', { class: 'num' }, String(r.nights)),
        el('td', { class: 'num' }, pct(r.occupancy)),
        el('td', { class: 'num' }, fmtMoney(r.earnings)),
        el('td', { class: 'num' }, r.adr ? fmtMoney(r.adr) : '—'),
        el('td', { class: 'num' }, r.revpar ? fmtMoney(r.revpar) : '—'),
      )));
      tbl.appendChild(tb);
      propCard.appendChild(tbl);
    }
    root.appendChild(propCard);

    // Upcoming
    const upCard = el('div', { class: 'card' });
    upCard.appendChild(el('h2', null, 'Upcoming Bookings'));
    if (!d.upcoming.length) upCard.appendChild(el('div', { class: 'empty' }, 'No upcoming bookings'));
    else {
      const tbl = el('table');
      tbl.appendChild(el('thead', null, el('tr', null,
        el('th', null, 'Check-in'), el('th', null, 'Property'), el('th', null, 'Guest'),
        el('th', null, 'Type'), el('th', { class: 'num' }, 'Amount'),
      )));
      const tb = el('tbody');
      d.upcoming.forEach(b => tb.appendChild(el('tr', null,
        el('td', null, fmtDate(b.check_in)),
        el('td', null, b.property_name || ''),
        el('td', null, b.guest_name || b.contact_name || ''),
        el('td', null, b.booking_type_name ? el('span', { class: 'badge ' + slug(b.booking_type_name) }, b.booking_type_name) : ''),
        el('td', { class: 'num' }, fmtMoney(b.amount)),
      )));
      tbl.appendChild(tb);
      upCard.appendChild(tbl);
    }
    root.appendChild(upCard);
  };

  function kpi(label, value, sub, modifier) {
    return el('div', { class: 'kpi ' + (modifier || '') },
      el('div', { class: 'label' }, label),
      el('div', { class: 'value' }, String(value)),
      el('div', { class: 'sub' }, sub || '')
    );
  }

  // ---------- PROPERTIES ----------
  VIEWS.properties = async (root) => {
    const [props, cleaners, statsData] = await Promise.all([API.properties.list(), API.cleaners.list(), API.propertyStats().catch(() => null)]);
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Properties'),
      el('button', { class: 'btn-primary', onclick: () => propertyForm(null, cleaners) }, '+ New property')
    ));
    if (props.length && !props.some(p => p.public_bookable)) {
      root.appendChild(el('div', { class: 'banner info' },
        el('span', { class: 'banner-icon' }, '✦'),
        el('div', null,
          el('strong', null, 'Public booking page is empty.'),
          ' To let returning guests use your booking site at localhost:5173, edit a property below and tick ',
          el('strong', null, 'Allow returning guests to book this'),
          '. Until then, the public site shows guests a friendly "no properties published yet" message.'
        ),
      ));
    }
    if (!props.length) {
      root.appendChild(el('div', { class: 'card empty' }, 'No properties yet. Add your first one to start tracking bookings.'));
      return;
    }
    const card = el('div', { class: 'card' });
    const tbl = el('table');
    tbl.appendChild(el('thead', null, el('tr', null,
      el('th', null, 'Nickname'), el('th', null, 'Address'),
      el('th', null, 'License'), el('th', null, 'Renewal'),
      el('th', null, 'Cleaner'), el('th', null, 'Public booking'),
      el('th', null, 'Channels'), el('th', null, ''),
    )));
    const tb = el('tbody');
    props.forEach(p => {
      const cleaner = p.default_cleaner_id ? cleaners.find(c => c.id === p.default_cleaner_id) : null;
      const channels = el('div', { class: 'btn-row' });
      if (p.airbnb_ical_url) channels.appendChild(el('span', { class: 'badge airbnb' }, 'Airbnb'));
      if (p.vrbo_ical_url) channels.appendChild(el('span', { class: 'badge vrbo' }, 'VRBO'));
      if (!p.airbnb_ical_url && !p.vrbo_ical_url) channels.appendChild(el('span', { class: 'muted' }, '—'));
      const licBadgeCls = p.license_status === 'licensed' ? 'licensed' : p.license_status === 'pending' ? 'license-pending' : 'unlicensed';
      const licLabel = p.license_status === 'licensed' ? 'Licensed' : p.license_status === 'pending' ? 'Pending' : 'Unlicensed';
      tb.appendChild(el('tr', null,
        el('td', null, el('strong', null, p.nickname), p.welcome_message ? el('div', { class: 'muted', style: 'font-size:11px;font-style:italic;' }, '✉ welcome msg set') : null),
        el('td', null, p.address || ''),
        el('td', null, el('span', { class: 'badge ' + licBadgeCls }, licLabel)),
        el('td', null, p.license_renewal_date ? fmtDate(p.license_renewal_date) : el('span', { class: 'muted' }, '—')),
        el('td', null, cleaner ? cleaner.name : el('span', { class: 'muted' }, 'none')),
        el('td', null, p.public_bookable ? el('span', { class: 'badge approved' }, 'Open') : el('span', { class: 'muted' }, '—')),
        el('td', null, channels),
        el('td', null, el('div', { class: 'btn-row' },
          el('button', { class: 'btn-ghost', onclick: async () => {
            toast('Syncing ' + p.nickname + '...');
            try { const r = await API.sync(p.id); const n = (r.results||[]).reduce((a,x)=>a+(x.count||0),0); toast(`Imported ${n} events`, 'success'); if ((r.cancelled||[]).length) toast(`Auto-cancelled ${r.cancelled.length} booking(s) removed from the platform: ${r.cancelled.map(c=>c.contact_name||'Guest').join(', ')}`, 'error'); }
            catch (e) {}
          }}, 'Sync'),
          el('button', { class: 'btn-ghost', onclick: () => propertyForm(p, cleaners) }, 'Edit'),
          el('button', { class: 'btn-ghost', title: 'Listing headline & description (used by Insights)', onclick: () => listingForm(p, statsData) }, 'Listing'),
          el('button', { class: 'btn-danger', onclick: async () => {
            if (!confirm(`Delete "${p.nickname}" and all its bookings/maintenance items?`)) return;
            await API.properties.remove(p.id);
            setView('properties');
          }}, 'Delete'),
        )),
      ));
    });
    tbl.appendChild(tb);
    card.appendChild(tbl);
    root.appendChild(card);

    // ---- Per-property performance (occupancy / revenue / ADR / YOY) ----
    if (statsData && statsData.properties && statsData.properties.length) {
      root.appendChild(el('h2', { style: 'margin-top:18px;' }, 'Performance'));
      for (const s of statsData.properties) root.appendChild(propertyStatsCard(s));
    }
  };

  function occBar(occupancy) {
    const pctVal = Math.min(100, Math.round((occupancy || 0) * 100));
    const color = pctVal >= 70 ? 'var(--success)' : pctVal >= 40 ? 'var(--warning)' : 'var(--danger)';
    return el('div', { class: 'occ-bar' }, el('div', { class: 'occ-fill', style: `width:${pctVal}%;background:${color};` }));
  }
  function yoyBadge(cur, last, fmt) {
    if (last == null || last === 0) return el('span', { class: 'muted', style: 'font-size:11px;' }, 'no LY data');
    const delta = (cur - last) / last;
    const up = delta >= 0;
    return el('span', { class: 'badge ' + (up ? 'approved' : 'unlicensed'), title: `Last year: ${fmt(last)}` },
      (up ? '▲ ' : '▼ ') + Math.abs(Math.round(delta * 100)) + '% vs LY');
  }
  function propertyStatsCard(s) {
    const card = el('div', { class: 'card prop-stats' });
    const ja = s.july_august, season = s.season;
    card.appendChild(el('div', { class: 'between' },
      el('h2', null, s.nickname),
      el('div', { class: 'btn-row' },
        yoyBadge(season.revenue, season.last_year.revenue, fmtMoney),
        el('span', { class: 'muted', style: 'font-size:12px;' }, `season ${fmtDate(season.start)} – ${fmtDate(season.end)}`))));

    const winRow = el('div', { class: 'stat-windows' });
    for (const w of [14, 30, 60]) {
      const win = s.windows['next_' + w];
      winRow.appendChild(el('div', { class: 'stat-window' },
        el('div', { class: 'label' }, `Next ${w} days`),
        el('div', { class: 'value' }, pct(win.occupancy)),
        occBar(win.occupancy),
        el('div', { class: 'sub' }, `${win.occupied_nights}/${w} nights booked`),
        el('div', { class: 'stat-line' }, el('span', null, 'Revenue'), el('strong', null, fmtMoney(win.revenue))),
        el('div', { class: 'stat-line' }, el('span', null, 'If gaps filled (3+ nt)'), el('strong', { style: 'color:var(--success);' }, '+' + fmtMoney(win.potential_revenue))),
        el('div', { class: 'stat-line' }, el('span', null, 'Booked avg $/night'), el('strong', null, win.adr != null ? fmtMoney(win.adr) : '—')),
        win.vacant_weekend_nights ? el('div', { class: 'stat-line warn-line' }, el('span', null, 'Open Fri/Sat nights'), el('strong', null, String(win.vacant_weekend_nights))) : null,
      ));
    }
    card.appendChild(winRow);

    card.appendChild(el('div', { class: 'kpi-grid', style: 'margin-top:10px;' },
      kpi('July/Aug occupancy', pct(ja.occupancy), `${ja.occupied_nights}/${ja.days} nights • LY ${pct(ja.last_year.occupancy)}`, ja.occupancy >= ja.last_year.occupancy ? 'success' : 'warn'),
      kpi('July/Aug revenue', fmtMoney(ja.revenue), `LY ${fmtMoney(ja.last_year.revenue)}`, ja.revenue >= ja.last_year.revenue ? 'success' : 'warn'),
      kpi('Achieved $/night', season.adr_achieved != null ? fmtMoney(season.adr_achieved) : '—', `LY ${season.last_year.adr != null ? fmtMoney(season.last_year.adr) : '—'}`),
      kpi('Season revenue', fmtMoney(season.revenue), season.yoy_revenue_pct == null ? `LY ${fmtMoney(season.last_year.revenue)}` : `${season.yoy_revenue_pct >= 0 ? '+' : ''}${Math.round(season.yoy_revenue_pct * 100)}% vs LY ${fmtMoney(season.last_year.revenue)}`, season.yoy_revenue_pct >= 0 ? 'success' : 'danger'),
      kpi('Forward vs achieved $', s.windows.next_30.adr != null && season.adr_achieved ? fmtMoney(s.windows.next_30.adr) : '—', season.adr_achieved ? `next 30d bookings vs ${fmtMoney(season.adr_achieved)} achieved` : 'no season bookings yet'),
      kpi('PriceLabs rec (30d avg)', s.pricelabs_avg_next_30 != null ? fmtMoney(s.pricelabs_avg_next_30) : '—', s.pricelabs_avg_next_30 != null ? 'market-based recommendation' : 'refresh Pricing tab to fetch'),
    ));
    return card;
  }

  function listingForm(p, statsData) {
    const meta = (statsData && statsData.properties.find(x => x.id === p.id) || {}).listing || {};
    const form = el('form', { class: 'form-grid' });
    form.appendChild(formField('Listing headline (as shown on Airbnb/VRBO)', input('headline', { value: meta.headline, placeholder: 'e.g. "Lakefront Retreat w/ Hot Tub — 5 min to Port Stanley Beach"' }), { full: true }));
    form.appendChild(formField('Listing description', textarea('description', meta.description, { rows: 8, placeholder: 'Paste your live listing description here…' }), { full: true }));
    form.appendChild(formField('Key amenities (comma-separated)', textarea('amenities', meta.amenities, { rows: 2, placeholder: 'hot tub, fire pit, kayaks, fast wifi, pet friendly' }), { full: true }));
    form.appendChild(formField('Who is this place for?', input('target_guest', { value: meta.target_guest, placeholder: 'e.g. families of 6-8, couples getaway, remote workers' }), { full: true }));
    form.appendChild(el('div', { class: 'muted', style: 'grid-column:1/-1;font-size:12px;' },
      'This copy feeds the Insights tab — keep it in sync with your live listings so recommendations reflect how the property is actually marketed.'));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, 'Save listing'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await API.listingMeta(p.id, readForm(form));
        toast('Listing saved', 'success'); closeModal(); setView('properties');
      } catch (e) {}
    });
    openModal(p.nickname + ' — listing copy', form);
  }

  function propertyForm(p, cleaners) {
    const form = el('form', { class: 'form-grid' });
    const cleanerOpts = [{ value: '', label: '— none —' }].concat(cleaners.map(c => ({ value: String(c.id), label: c.name })));

    form.appendChild(formField('Nickname *', input('nickname', { value: p?.nickname, required: true, placeholder: 'e.g. Lake Cottage' })));
    form.appendChild(formField('Address', input('address', { value: p?.address, placeholder: 'Street, city, country' })));
    form.appendChild(formField('Default cleaner', select('default_cleaner_id', cleanerOpts, p?.default_cleaner_id || '')));
    const pubLabel = el('label', null,
      el('span', { class: 'lbl' }, 'Public booking page'),
      (() => {
        const wrap = el('div', { style: 'display:flex; align-items:center; gap:8px; padding:8px 0;' });
        const cb = el('input', { type: 'checkbox', name: 'public_bookable', style: 'width:auto;' });
        if (p?.public_bookable) cb.checked = true;
        wrap.appendChild(cb);
        wrap.appendChild(el('span', null, 'Allow returning guests to book this'));
        return wrap;
      })()
    );
    form.appendChild(pubLabel);
    const licStatusOpts = [{ value: 'unlicensed', label: 'Unlicensed' }, { value: 'pending', label: 'Pending' }, { value: 'licensed', label: 'Licensed' }];
    form.appendChild(formField('License status', select('license_status', licStatusOpts, p?.license_status || 'unlicensed')));
    form.appendChild(formField('License renewal date', input('license_renewal_date', { type: 'date', value: p?.license_renewal_date || '' })));
    form.appendChild(formField('Airbnb iCal URL', input('airbnb_ical_url', { value: p?.airbnb_ical_url, placeholder: 'https://www.airbnb.com/calendar/ical/…' }), { full: true }));
    form.appendChild(formField('VRBO iCal URL', input('vrbo_ical_url', { value: p?.vrbo_ical_url, placeholder: 'http://www.vrbo.com/icalendar/…' }), { full: true }));
    if (p && p.id && p.ical_token) {
      const baseUrl = location.origin + '/api/public/ical/' + p.id + '.ics?token=' + p.ical_token;
      const feedRow = (label, url) => {
        const feedInput = el('input', { type: 'text', value: url, readonly: 'true', style: 'flex:1;min-width:0;font-size:12px;' });
        feedInput.addEventListener('click', () => feedInput.select());
        const copyBtn = el('button', { class: 'btn-ghost small', type: 'button', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(url); toast(label + ' feed URL copied', 'success'); } }, 'Copy');
        return el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:6px;' },
          el('span', { class: 'muted', style: 'width:130px;flex:0 0 auto;font-size:12px;' }, label), feedInput, copyBtn);
      };
      form.appendChild(formField('⬆ Export feeds (.ics) — each platform gets ITS OWN link so its bookings aren’t echoed back as conflicts',
        el('div', null,
          feedRow('Paste into VRBO', baseUrl + '&for=vrbo'),
          feedRow('Paste into Airbnb', baseUrl + '&for=airbnb'),
          feedRow('Everything else', baseUrl),
          el('div', { class: 'muted', style: 'font-size:12px;' }, 'The VRBO link hides VRBO-origin stays (it already has those), the Airbnb link hides Airbnb-origin stays. Use the full feed for Cottages Canada or anywhere that has no bookings of its own.')),
        { full: true }));
    }
    form.appendChild(formField('Welcome message (SMS greeting sent to guests)',
      textarea('welcome_message', p?.welcome_message, { rows: 3, placeholder: 'e.g. "Welcome back! The kayak is yours, the firewood is by the shed, and the WiFi password is on the fridge."' }),
      { full: true }
    ));
    form.appendChild(formField('Check-in instructions (sent via SMS)',
      textarea('check_in_instructions', p?.check_in_instructions, { rows: 4, placeholder: 'e.g. "The lockbox code is 1234. Park in the driveway. Checkout is 11am."' }),
      { full: true }
    ));
    form.appendChild(formField('Nearby attractions (sent via SMS)',
      textarea('nearby_attractions', p?.nearby_attractions, { rows: 4, placeholder: 'e.g. "Port Stanley beach (5 min), Pinafore Park trails (10 min), Shaw\'s Ice Cream (2 min)"' }),
      { full: true }
    ));
    form.appendChild(formField('Contact info for issues (sent via SMS)',
      textarea('contact_info', p?.contact_info, { rows: 2, placeholder: 'e.g. "Call/text Matt at 519-555-1234 anytime for any issues during your stay."' }),
      { full: true }
    ));
    form.appendChild(formField('Internal notes', textarea('notes', p?.notes), { full: true }));

    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column: 1/-1; margin-top: 8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, p ? 'Save changes' : 'Create property'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel'),
    ));
    if (!p) {
      form.appendChild(el('p', { class: 'muted', style: 'grid-column: 1/-1; font-size: 12px; margin-top: 4px;' },
        'A default maintenance checklist (sheets, broom, dish soap, etc.) will be created automatically.'));
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = readForm(form);
      try {
        if (p) await API.properties.update(p.id, data); else await API.properties.create(data);
        toast('Saved', 'success'); closeModal(); setView('properties');
      } catch (e) {}
    });
    openModal(p ? 'Edit property' : 'New property', form);
  }

  // ---------- CALENDAR ----------
  let calCursor = new Date();
  let calHighlight = null;  // 'conflicts' | 'orphans' — set by a dashboard deep-link
  let calJumpDate = null;   // ISO date to jump the calendar to
  // 'agenda' (mobile-friendly list) or 'grid' (full month). Defaults by screen width, then remembered.
  let calMode = localStorage.getItem('cal_mode') || (window.innerWidth <= 760 ? 'agenda' : 'grid');
  VIEWS.calendar = async (root) => {
    const [events, props, types, guests, bookings, orphans, todosList] = await Promise.all([
      API.calendar(), API.properties.list(), API.bookingTypes.list(), API.guests.list(), API.bookings.list(), API.orphans().catch(() => []), API.todos.list().catch(() => []),
    ]);
    const reRender = () => setView('calendar');
    let dragTaskId = null; // task being dragged to a new day
    // Deep-link from the dashboard: jump to the month + turn on a highlight.
    if (calJumpDate) { const jd = new Date(calJumpDate + 'T00:00:00'); if (!isNaN(jd)) calCursor = jd; calJumpDate = null; }
    // Highlights persist across navigation; a dashboard deep-link can also force them on.
    let highlightConflicts = calHighlight === 'conflicts' || localStorage.getItem('cal_hl_conflicts') === 'on';
    let highlightOrphans = calHighlight === 'orphans' || localStorage.getItem('cal_hl_orphans') === 'on';
    calHighlight = null;
    // Orphan nights as a {property_id: Set(dateIso)} map + an any-property set.
    const orphanByProp = {}; const orphanAny = new Set();
    orphans.forEach(o => { let d = o.gap_start; while (d < o.gap_end) { (orphanByProp[o.property_id] = orphanByProp[o.property_id] || new Set()).add(d); orphanAny.add(d); const dt = new Date(d + 'T00:00:00'); dt.setDate(dt.getDate() + 1); d = dt.toISOString().slice(0, 10); } });
    // PriceLabs recommended-price overlay (default OFF; toggled on per device).
    let showPrices = localStorage.getItem('cal_show_prices') === 'on';
    let priceByProp = null;
    async function ensurePrices() {
      if (priceByProp) return;
      priceByProp = {};
      const data = await API.pricing().catch(() => null);
      if (data && data.properties) data.properties.forEach(p => {
        const m = {}; (p.prices || []).forEach(pr => { m[pr.date] = { rec: pr.recommended_price, demand: pr.demand }; });
        priceByProp[p.property_id] = m;
      });
    }
    const wrap = el('div', { class: 'cal-wrap' });
    const head = el('div', { class: 'cal-head' });
    const monthLbl = el('h2', null, calCursor.toLocaleDateString('en-CA', { year: 'numeric', month: 'long' }));
    const propFilter = select('propFilter', [{ value: '', label: 'All properties' }].concat(props.map(p => ({ value: String(p.id), label: p.nickname }))), localStorage.getItem('cal_prop_filter') || '');
    propFilter.style.width = 'auto';
    propFilter.addEventListener('change', () => { localStorage.setItem('cal_prop_filter', propFilter.value); render(); });

    // Month navigation re-renders in place (keeps the property filter + toggles), no re-fetch.
    const prev = el('button', { class: 'btn-ghost', onclick: () => { calCursor.setMonth(calCursor.getMonth() - 1); render(); } }, '←');
    const next = el('button', { class: 'btn-ghost', onclick: () => { calCursor.setMonth(calCursor.getMonth() + 1); render(); } }, '→');
    const today = el('button', { class: 'btn-ghost', onclick: () => { calCursor = new Date(); render(); } }, 'Today');

    const blockBtn = el('button', { class: 'btn-ghost', onclick: () => blockForm(null, props, reRender) }, '▦ Block dates');
    const quoteBtn = el('button', { class: 'btn-ghost', onclick: () => quoteEstimator(props, types, guests) }, '💲 Quote a stay');
    // Mobile-friendly view toggle: Agenda (list) vs Month (grid)
    const agendaBtn = el('button', { class: 'btn-ghost small', onclick: () => { calMode = 'agenda'; localStorage.setItem('cal_mode', 'agenda'); render(); } }, '☰ Agenda');
    const gridBtn = el('button', { class: 'btn-ghost small', onclick: () => { calMode = 'grid'; localStorage.setItem('cal_mode', 'grid'); render(); } }, '▦ Month');
    const modeToggle = el('div', { class: 'cal-mode-toggle' }, agendaBtn, gridBtn);
    const pricesBtn = el('button', { class: 'btn-ghost small', title: 'Overlay PriceLabs recommended nightly rates (pick one property)',
      onclick: async () => { showPrices = !showPrices; localStorage.setItem('cal_show_prices', showPrices ? 'on' : 'off'); if (showPrices) await ensurePrices(); render(); } }, '💲 Prices');
    const conflictsBtn = el('button', { class: 'btn-ghost small', title: 'Highlight double-bookings',
      onclick: () => { highlightConflicts = !highlightConflicts; localStorage.setItem('cal_hl_conflicts', highlightConflicts ? 'on' : 'off'); render(); } }, '⚠ Conflicts');
    const orphansBtn = el('button', { class: 'btn-ghost small', title: 'Highlight fillable gap nights',
      onclick: () => { highlightOrphans = !highlightOrphans; localStorage.setItem('cal_hl_orphans', highlightOrphans ? 'on' : 'off'); render(); } }, '🔆 Orphans');
    let calCompare = localStorage.getItem('cal_compare') === 'on';
    const compareBtn = el('button', { class: 'btn-ghost small', title: 'Show the same month last year side-by-side, with revenue totals',
      onclick: () => { calCompare = !calCompare; localStorage.setItem('cal_compare', calCompare ? 'on' : 'off'); if (calCompare && calMode !== 'grid') { calMode = 'grid'; localStorage.setItem('cal_mode', 'grid'); } render(); } }, '🔁 vs Last Year');
    head.appendChild(el('div', { class: 'btn-row' }, prev, today, next));
    head.appendChild(monthLbl);
    head.appendChild(el('div', { class: 'cal-head-controls', style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;' }, modeToggle, pricesBtn, conflictsBtn, orphansBtn, compareBtn, propFilter, blockBtn, quoteBtn));
    wrap.appendChild(head);
    const body = el('div', { class: 'cal-body' });
    wrap.appendChild(body);

    // Helper: format date as local YYYY-MM-DD without timezone shift
    function localIso(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
    function inRange(start, end, dayIso) {
      // Checkout day is NOT occupied (guest leaves that morning),
      // so use < for end date. If no end date, show just the start day.
      if (!end || end === start) return dayIso === start;
      return dayIso >= start && dayIso < end;
    }
    function render() {
      body.innerHTML = '';
      monthLbl.textContent = calCursor.toLocaleDateString('en-CA', { year: 'numeric', month: 'long' });
      agendaBtn.classList.toggle('active', calMode === 'agenda');
      gridBtn.classList.toggle('active', calMode === 'grid');
      pricesBtn.classList.toggle('active', showPrices);
      conflictsBtn.classList.toggle('active', highlightConflicts);
      orphansBtn.classList.toggle('active', highlightOrphans);
      compareBtn.classList.toggle('active', calCompare);
      const propId = propFilter.value;
      const todayStr = isoToday();
      const filtered = events.filter(ev => !propId || String(ev.property_id) === propId);

      if (calMode === 'agenda') { renderAgenda(body, filtered, todayStr); return; }

      const y = calCursor.getFullYear(), mo = calCursor.getMonth();
      if (calCompare) {
        const cur = monthRevenue(y, mo, propId), ly = monthRevenue(y - 1, mo, propId);
        const deltaTxt = ly.revenue > 0
          ? `${cur.revenue >= ly.revenue ? '+' : ''}${fmtMoney(cur.revenue - ly.revenue)} (${cur.revenue >= ly.revenue ? '+' : ''}${Math.round((cur.revenue - ly.revenue) / ly.revenue * 100)}%) vs last year`
          : 'no revenue on record last year';
        body.appendChild(el('div', { class: 'cal-compare-strip ' + (ly.revenue > 0 && cur.revenue < ly.revenue ? 'behind' : 'ahead') },
          el('strong', null, deltaTxt),
          el('span', { class: 'muted' }, ` • ${cur.nights} booked nights vs ${ly.nights} last year`)));
        body.appendChild(el('div', { class: 'cal-compare' },
          comparePane(y, mo, filtered, todayStr, cur),
          comparePane(y - 1, mo, filtered, todayStr, ly)));
        return;
      }
      body.appendChild(buildMonthGrid(y, mo, filtered, todayStr));
    }
    // Per-night-allocated revenue + booked nights for one property-filtered month.
    function monthRevenue(yy, mo0, propId) {
      const mStart = localIso(new Date(yy, mo0, 1));
      const mEnd = localIso(new Date(yy, mo0 + 1, 1));
      let revenue = 0, nights = 0;
      for (const b of bookings) {
        if (b.status === 'cancelled' || !b.check_in) continue;
        if (propId && String(b.property_id) !== propId) continue;
        const end = b.check_out || b.check_in;
        const s = b.check_in > mStart ? b.check_in : mStart;
        const e = end < mEnd ? end : mEnd;
        if (e <= s) continue;
        const nw = Math.round((new Date(e) - new Date(s)) / 86400000);
        const len = Math.max(1, Math.round((new Date(end) - new Date(b.check_in)) / 86400000));
        revenue += ((b.amount || 0) + (b.upsell_total || 0)) / len * nw;
        nights += nw;
      }
      return { revenue: Math.round(revenue), nights };
    }
    function comparePane(yy, mo0, filtered, todayStr, rev) {
      return el('div', { class: 'cal-compare-col' },
        el('div', { class: 'cal-compare-title' },
          el('strong', null, new Date(yy, mo0, 1).toLocaleDateString('en-CA', { year: 'numeric', month: 'long' })),
          el('span', null, ` — ${fmtMoney(rev.revenue)} • ${rev.nights} nights`)),
        buildMonthGrid(yy, mo0, filtered, todayStr));
    }
    function buildMonthGrid(yy, mo0, filtered, todayStr) {
      const grid = el('div', { class: 'cal-grid' });
      ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(n => grid.appendChild(el('div', { class: 'cal-dayname' }, n)));
      const first = new Date(yy, mo0, 1);
      const startDayIdx = first.getDay();
      const daysInMonth = new Date(yy, mo0 + 1, 0).getDate();
      for (let i = 0; i < startDayIdx; i++) {
        grid.appendChild(dayCell(new Date(yy, mo0, -startDayIdx + i + 1), true, filtered, todayStr));
      }
      for (let day = 1; day <= daysInMonth; day++) {
        grid.appendChild(dayCell(new Date(yy, mo0, day), false, filtered, todayStr));
      }
      const trailing = (7 - ((startDayIdx + daysInMonth) % 7)) % 7;
      for (let i = 1; i <= trailing; i++) {
        grid.appendChild(dayCell(new Date(yy, mo0 + 1, i), true, filtered, todayStr));
      }
      return grid;
    }
    // Shared event-open behaviour (used by both grid cells and agenda rows).
    function openEvent(ev) {
      if (ev.kind === 'task') {
        const full = todosList.find(t => t.id === ev.todo_id) || { id: ev.todo_id, title: ev.title, priority: ev.priority, due_date: ev.start, property_id: ev.property_id, status: ev.status };
        todoForm(full, props, { onSaved: reRender });
        return;
      }
      if (ev.kind === 'block') {
        if (ev.manual) blockForm({ id: ev.block_id, property_id: ev.property_id, start_date: ev.start, end_date: ev.end, reason: ev.reason }, props, reRender);
        else toast('Synced from ' + (ev.source || 'platform') + ' — edit it on that platform', 'error');
        return;
      }
      if (ev.kind === 'reserved') { claimSyncedForm(ev, props, types, guests, reRender); return; }
      const full = bookings.find(b => b.id === ev.booking_id); if (full) bookingForm(full, props, types, guests, { onSaved: reRender });
    }
    // Small chooser shown from a day cell: add a booking, task, or block on that date.
    function dayAddMenu(dateIso) {
      const wrap = el('div', { class: 'form-grid' });
      wrap.appendChild(el('div', { class: 'muted', style: 'grid-column:1/-1;' }, 'Add to ' + fmtDate(dateIso)));
      const mk = (label, fn) => el('button', { class: 'btn-ghost', style: 'justify-content:flex-start;', onclick: () => { closeModal(); fn(); } }, label);
      wrap.appendChild(el('div', { style: 'grid-column:1/-1;display:flex;flex-direction:column;gap:8px;' },
        mk('📅  New booking', () => bookingForm(null, props, types, guests, { onSaved: reRender, defaultDate: dateIso })),
        mk('📋  New task', () => quickTaskForm(dateIso, props, reRender)),
        mk('▦  Block these dates', () => blockForm({ start_date: dateIso }, props, reRender)),
      ));
      openModal('Add to calendar', wrap);
    }
    // Mobile-friendly chronological list for the visible month.
    function renderAgenda(container, filtered, todayStr) {
      const y = calCursor.getFullYear(), mo = calCursor.getMonth();
      const monthStart = localIso(new Date(y, mo, 1));
      const monthEnd = localIso(new Date(y, mo + 1, 0));
      const inMonth = filtered.filter(ev => { const s = ev.start, e = ev.end || ev.start; return s && s <= monthEnd && e >= monthStart; })
        .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      if (!inMonth.length) { container.appendChild(el('div', { class: 'empty', style: 'padding:24px;' }, 'Nothing scheduled this month.')); return; }
      const groups = {};
      inMonth.forEach(ev => { const key = ev.start < monthStart ? monthStart : ev.start; (groups[key] = groups[key] || []).push(ev); });
      const order = { booking: 0, reserved: 1, block: 2, task: 3 };
      const list = el('div', { class: 'cal-agenda' });
      Object.keys(groups).sort().forEach(date => {
        const dt = new Date(date + 'T00:00:00');
        list.appendChild(el('div', { class: 'agenda-day' + (date === todayStr ? ' today' : '') },
          el('span', { class: 'agenda-dow' }, dt.toLocaleDateString('en-CA', { weekday: 'short' })),
          el('span', { class: 'agenda-date' }, fmtDate(date)),
          date === todayStr ? el('span', { class: 'agenda-today-pill' }, 'Today') : null));
        groups[date].sort((a, b) => (order[a.kind] || 9) - (order[b.kind] || 9)).forEach(ev => list.appendChild(agendaRow(ev, date)));
      });
      container.appendChild(list);
    }
    function agendaRow(ev, date) {
      if (ev.kind === 'task') {
        const done = ev.status === 'done';
        return el('div', { class: 'agenda-row agenda-task' + (done ? ' done' : ''), onclick: () => openEvent(ev) },
          el('span', { class: 'agenda-icon' }, done ? '✓' : '📋'),
          el('div', { class: 'agenda-main' }, el('div', { class: 'agenda-title' }, ev.title), ev.property_name ? el('div', { class: 'agenda-sub' }, ev.property_name) : null));
      }
      if (ev.kind === 'block') {
        return el('div', { class: 'agenda-row agenda-block', onclick: () => openEvent(ev) },
          el('span', { class: 'agenda-icon' }, '▦'),
          el('div', { class: 'agenda-main' }, el('div', { class: 'agenda-title' }, (ev.property_name || '') + ' — ' + (ev.manual ? (ev.reason || 'Blocked') : 'Blocked')),
            el('div', { class: 'agenda-sub' }, fmtDate(ev.start) + ' → ' + fmtDate(ev.end))));
      }
      const cls = propColorClass(ev.property_name);
      const guest = ev.guest_name || ev.contact_name || (ev.kind === 'reserved' ? 'Reserved' : 'Booking');
      const needs = ev.kind === 'reserved';
      const verified = ev.kind === 'booking' && ev.platform_verified;
      const isCheckin = ev.start === date;
      const nights = (ev.start && ev.end && ev.end > ev.start) ? Math.round((new Date(ev.end) - new Date(ev.start)) / 86400000) : 1;
      return el('div', { class: 'agenda-row ' + cls + (needs ? ' reserved' : ''), onclick: () => openEvent(ev) },
        el('span', { class: 'agenda-chip ' + cls }, ev.property_name || ''),
        el('div', { class: 'agenda-main' },
          el('div', { class: 'agenda-title' }, (verified ? '🔒 ' : '') + guest),
          el('div', { class: 'agenda-sub' }, fmtDate(ev.start) + ' → ' + fmtDate(ev.end) + ' · ' + nights + 'n' + (ev.amount ? ' · ' + fmtMoney(ev.amount) : (needs ? ' · amount needed' : '')) + (ev.source ? ' · ' + ev.source : ''))),
        isCheckin && !needs ? el('span', { class: 'checkin-pill' }, 'Check-In') : (needs ? el('span', { class: 'needs-pill' }, '＋ details') : null));
    }
    function propColorClass(name) {
      const s = slug(name || '');
      if (s.indexOf('escape') !== -1) return 'prop-escape';
      if (s.indexOf('retreat') !== -1) return 'prop-retreat';
      if (s.indexOf('hideaway') !== -1) return 'prop-hideaway';
      if (s.indexOf('look') !== -1) return 'prop-lookout';
      return 'prop-other';
    }
    function dayCell(date, isOther, evs, todayStr) {
      const iso = localIso(date);
      const cell = el('div', {
        class: 'cal-day' + (isOther ? ' other' : '') + (iso === todayStr ? ' today' : ''),
        ondragover: (e) => { if (dragTaskId != null) { e.preventDefault(); e.currentTarget.classList.add('cal-drop'); } },
        ondragleave: (e) => e.currentTarget.classList.remove('cal-drop'),
        ondrop: async (e) => { e.preventDefault(); e.currentTarget.classList.remove('cal-drop'); if (dragTaskId != null) { const id = dragTaskId; dragTaskId = null; await API.todos.update(id, { due_date: iso }); toast('Task moved', 'success'); reRender(); } },
      }, el('div', { class: 'dnum' }, String(date.getDate())));
      // Orphan-night highlight (toggle)
      if (highlightOrphans) {
        const isOrphan = propFilter.value ? (orphanByProp[Number(propFilter.value)] || new Set()).has(iso) : orphanAny.has(iso);
        if (isOrphan) cell.classList.add('cal-hl-orphan');
      }
      // Add a booking / task / block on this day
      if (!isOther) {
        cell.appendChild(el('button', { class: 'cal-add-task', title: 'Add a booking, task, or block on this day',
          onclick: (e) => { e.stopPropagation(); dayAddMenu(iso); } }, '+'));
      }
      // PriceLabs recommended nightly rate overlay (single property selected)
      if (showPrices && priceByProp && propFilter.value) {
        const pr = (priceByProp[Number(propFilter.value)] || {})[iso];
        if (pr && pr.rec != null) cell.querySelector('.dnum').appendChild(
          el('span', { class: 'cal-price', title: 'PriceLabs recommended' + (pr.demand ? ' • ' + pr.demand : '') }, fmtMoney(pr.rec)));
      }
      const dayEvs = evs.filter(ev => inRange(ev.start, ev.end, iso));

      // Conflict = 2+ guest entries (booking or unclaimed reservation) at one property today.
      const guestByProp = {};
      dayEvs.forEach(ev => {
        if (ev.kind !== 'booking' && ev.kind !== 'reserved') return;
        (guestByProp[ev.property_id] = guestByProp[ev.property_id] || []).push(ev);
      });
      const conflictProps = new Set();
      for (const pid of Object.keys(guestByProp)) {
        if (guestByProp[pid].length > 1) conflictProps.add(Number(pid));
      }
      if (conflictProps.size > 0) {
        cell.classList.add('cal-conflict');
        if (highlightConflicts) cell.classList.add('cal-hl-conflict');
        cell.querySelector('.dnum').appendChild(
          el('span', { class: 'cal-conflict-badge', title: 'Double-booking — two guest reservations at the same property on this date' }, '!'));
      }

      // Order: guest stays first, then blocks, then tasks.
      const order = { booking: 0, reserved: 1, block: 2, task: 3 };
      const sorted = dayEvs.slice().sort((a, b) => (order[a.kind] || 9) - (order[b.kind] || 9));

      sorted.forEach(ev => {
        const isFirst = iso === ev.start;

        if (ev.kind === 'task') {
          const done = ev.status === 'done';
          cell.appendChild(el('div', {
            class: 'cal-event cal-task' + (done ? ' done' : ''),
            draggable: 'true',
            title: 'Task: ' + ev.title + (ev.property_name ? ' • ' + ev.property_name : '') + ' — click to edit, drag to move',
            onclick: (e) => { e.stopPropagation(); openEvent(ev); },
            ondragstart: (e) => { dragTaskId = ev.todo_id; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(ev.todo_id)); } catch (x) {} },
            ondragend: () => { dragTaskId = null; },
          }, el('span', { class: 'cal-task-icon' }, done ? '✓' : '📋'), el('span', { class: 'cal-ev-title' }, ev.title)));
          return;
        }

        if (ev.kind === 'block') {
          const manual = ev.manual;
          const label = (ev.property_name ? ev.property_name + ' — ' : '') + (manual ? (ev.reason || 'Blocked') : 'Blocked');
          cell.appendChild(el('div', {
            class: 'cal-event cal-block' + (manual ? ' manual' : ''),
            title: (ev.property_name || '') + ' — ' + (manual ? (ev.reason || 'Blocked') + ' (' + fmtDate(ev.start) + ' → ' + fmtDate(ev.end) + ', click to edit)' : 'Blocked / not available (' + ev.source + ')'),
            onclick: (e) => { e.stopPropagation(); openEvent(ev); },
          }, '▦ ' + label));
          return;
        }

        // booking or reserved (guest stay)
        const cls = propColorClass(ev.property_name);
        const isConflict = conflictProps.has(ev.property_id);
        const guest = ev.guest_name || ev.contact_name || (ev.kind === 'reserved' ? 'Reserved' : 'Booking');
        const verified = ev.kind === 'booking' && ev.platform_verified;
        const needs = ev.kind === 'reserved';
        const amountTxt = ev.amount ? ' • ' + fmtMoney(ev.amount) : (needs ? ' • amount needed' : '');
        const srcTxt = verified ? ' • ✓ verified on ' + ev.synced_source : (ev.source ? ' • ' + ev.source : '');
        const span = el('div', {
          class: 'cal-event ' + cls + (needs ? ' reserved' : '') + (isConflict ? ' conflict' : ''),
          title: `${ev.property_name || ''} — ${guest}${amountTxt}${srcTxt}`,
          onclick: (e) => {
            e.stopPropagation();
            if (needs) { claimSyncedForm(ev, props, types, guests, reRender); }
            else { const full = bookings.find(b => b.id === ev.booking_id); if (full) bookingForm(full, props, types, guests, { onSaved: reRender }); }
          },
        });
        span.appendChild(el('span', { class: 'cal-ev-prop' }, (verified ? '🔒 ' : '') + (ev.property_name || '')));
        span.appendChild(el('span', { class: 'cal-ev-guest' }, guest));
        if (isFirst) span.appendChild(el('span', { class: 'checkin-pill' }, 'Check-In'));
        if (needs) span.appendChild(el('span', { class: 'needs-pill' }, '＋ Add details'));
        cell.appendChild(span);
      });

      // Check-out markers (guest leaving the morning of this day).
      evs.filter(ev => (ev.kind === 'booking' || ev.kind === 'reserved') && ev.end === iso && ev.end !== ev.start)
        .forEach(ev => cell.appendChild(el('div', { class: 'cal-checkout',
          title: 'Check-out: ' + (ev.guest_name || ev.contact_name || '') }, '⤴ Check-out: ' + (ev.guest_name || ev.contact_name || ''))));

      return cell;
    }
    if (showPrices) ensurePrices().then(render); else render();
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Calendar'),
      el('div', { class: 'cal-legend', style: 'display:flex;align-items:center;gap:12px;font-size:12px;flex-wrap:wrap;' },
        el('span', { class: 'cal-event prop-escape', style: 'display:inline-block;padding:2px 8px;' }, 'Escape'),
        el('span', { class: 'cal-event prop-retreat', style: 'display:inline-block;padding:2px 8px;' }, 'Retreat'),
        el('span', { class: 'cal-event prop-hideaway', style: 'display:inline-block;padding:2px 8px;' }, 'Hideaway'),
        el('span', { class: 'cal-event prop-lookout', style: 'display:inline-block;padding:2px 8px;' }, 'Look Out'),
        el('span', { style: 'color:#64748b;' }, '🔒 = verified on Airbnb/VRBO'),
        el('span', { style: 'color:#b45309;font-weight:600;' }, '＋ Add details = needs amount/guest'),
        el('span', { style: 'color:#64748b;' }, '▦ = blocked'),
        el('span', { style: 'color:#64748b;' }, '📋 = task'),
        el('span', { style: 'color:#dc2626;font-weight:600;' }, '! = double-booking')
      )
    ));
    root.appendChild(wrap);
  };

  // Claim/enrich an unconfirmed Airbnb/VRBO reservation → creates a linked booking.
  function claimSyncedForm(ev, props, types, guests, onSaved) {
    const form = el('form', { class: 'form-grid' });
    const guestOpts = [{ value: '', label: '— new guest below —' }].concat(guests.map(g => ({ value: String(g.id), label: g.name + (g.email ? ` <${g.email}>` : '') })));
    const propName = (props.find(p => p.id === ev.property_id) || {}).nickname || ev.property_name || '';
    form.appendChild(el('div', { class: 'muted', style: 'grid-column:1/-1;font-size:13px;margin-bottom:4px;' },
      `${(ev.source || '').toUpperCase()} reservation • ${propName} • ${fmtDate(ev.start)} → ${fmtDate(ev.end)}`));
    form.appendChild(formField('Amount', input('amount', { type: 'number', step: '0.01', placeholder: 'e.g. 975.00' })));
    form.appendChild(formField('Existing guest', select('guest_id', guestOpts, '')));
    form.appendChild(formField('+ New guest name', input('new_guest_name', { value: ev.guest_name || '', placeholder: 'guest name' })));
    form.appendChild(formField('+ New guest email', input('new_guest_email', { type: 'email' })));
    form.appendChild(formField('+ New guest phone', input('new_guest_phone')));
    form.appendChild(formField('Check-in', input('check_in', { type: 'date', value: ev.start })));
    form.appendChild(formField('Check-out', input('check_out', { type: 'date', value: ev.end })));
    form.appendChild(formField('Notes', textarea('notes', ''), { full: true }));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, 'Save booking details'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readForm(form);
      const payload = { amount: Number(d.amount) || 0, check_in: d.check_in, check_out: d.check_out || null, notes: d.notes };
      if (d.guest_id) payload.guest_id = Number(d.guest_id);
      else if (d.new_guest_name) { payload.new_guest = { name: d.new_guest_name, email: d.new_guest_email, phone: d.new_guest_phone }; payload.guest_name = d.new_guest_name; }
      else if (ev.guest_name) payload.guest_name = ev.guest_name;
      try { await API.claimSynced(ev.synced_event_id, payload); toast('Booking details saved', 'success'); closeModal(); onSaved && onSaved(); } catch (e) {}
    });
    openModal('Add booking details', form);
  }

  // Manually block dates (owner stay, maintenance, etc.) — shows grey on the calendar.
  function blockForm(preset, props, onSaved) {
    const editing = !!(preset && preset.id);
    const form = el('form', { class: 'form-grid' });
    const propOpts = props.map(p => ({ value: String(p.id), label: p.nickname }));
    form.appendChild(formField('Property *', select('property_id', propOpts, preset?.property_id)));
    form.appendChild(formField('Reason', input('reason', { value: preset?.reason || '', placeholder: 'e.g. Owner stay, Maintenance' })));
    form.appendChild(formField('From *', input('start_date', { type: 'date', value: preset?.start_date || isoToday(), required: true })));
    form.appendChild(formField('To (checkout)', input('end_date', { type: 'date', value: preset?.end_date || '' })));
    form.appendChild(el('div', { class: 'muted', style: 'grid-column:1/-1;font-size:12px;' },
      'Blocked dates show in grey so these nights never get double-booked. "To" is the checkout morning (that night is free).'));
    const btnRow = el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, editing ? 'Save block' : 'Block dates'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel'));
    if (editing) {
      btnRow.appendChild(el('button', { class: 'btn-danger', type: 'button', style: 'margin-left:auto;', onclick: async () => {
        if (!confirm('Remove this block?')) return;
        await API.blocks.remove(preset.id); closeModal(); onSaved && onSaved();
      } }, 'Delete block'));
    }
    form.appendChild(btnRow);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readForm(form);
      if (!d.property_id || !d.start_date) { toast('Property and start date required', 'error'); return; }
      const payload = { property_id: Number(d.property_id), start_date: d.start_date, end_date: d.end_date || null, reason: d.reason };
      try {
        if (editing) await API.blocks.update(preset.id, payload); else await API.blocks.create(payload);
        toast(editing ? 'Block updated' : 'Dates blocked', 'success'); closeModal(); onSaved && onSaved();
      } catch (e) {}
    });
    openModal(editing ? 'Edit blocked dates' : 'Block dates', form);
  }

  // Quick-add a calendar task (e.g. "Assemble beds", "Refill inventory") from a day cell.
  function quickTaskForm(dateIso, props, onSaved) {
    const form = el('form', { class: 'form-grid' });
    const propOpts = [{ value: '', label: '— none —' }].concat(props.map(p => ({ value: String(p.id), label: p.nickname })));
    form.appendChild(formField('Task *', input('title', { placeholder: 'e.g. Assemble beds, refill inventory', required: true })));
    form.appendChild(formField('Property', select('property_id', propOpts, '')));
    form.appendChild(formField('Due date', input('due_date', { type: 'date', value: dateIso })));
    form.appendChild(formField('Priority', select('priority', [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }], 'medium')));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, 'Add task'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readForm(form);
      if (!d.title) return;
      try {
        await API.todos.create({ title: d.title, property_id: d.property_id || null, due_date: d.due_date || null, priority: d.priority });
        toast('Task added', 'success'); closeModal(); onSaved && onSaved();
      } catch (e) {}
    });
    openModal('Add calendar task', form);
  }

  // Private booking estimator — suggested price for a stay from PriceLabs nightly rates.
  function quoteEstimator(props, types, guests) {
    const wrap = el('div');
    const form = el('form', { class: 'form-grid' });
    form.appendChild(formField('Property', select('property_id', props.map(p => ({ value: String(p.id), label: p.nickname })), '')));
    form.appendChild(formField('Check-in', input('from', { type: 'date', value: isoToday() })));
    form.appendChild(formField('Check-out', input('to', { type: 'date' })));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;' },
      el('button', { class: 'btn-primary', type: 'submit' }, 'Calculate'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Close')));
    const result = el('div', { style: 'margin-top:14px;' });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readForm(form);
      if (!d.property_id || !d.from || !d.to) { toast('Pick a property and both dates', 'error'); return; }
      result.innerHTML = ''; result.appendChild(el('div', { class: 'muted' }, 'Calculating…'));
      try {
        const q = await API.quote(d.property_id, d.from, d.to);
        result.innerHTML = '';
        result.appendChild(simpleTable(['Night', { label: 'Rate', num: true }, 'Demand'], q.per_night.map(n => [fmtDate(n.date), fmtMoney(n.price), n.demand || ''])));
        result.appendChild(el('div', { style: 'margin-top:10px;display:flex;flex-direction:column;gap:3px;' },
          el('div', { class: 'muted' }, q.nights + ' nights · avg ' + fmtMoney(q.avg_nightly) + '/night'),
          el('div', null, 'Nightly total: ' + fmtMoney(q.nightly_total)),
          q.cleaning_fee ? el('div', null, 'Cleaning fee: ' + fmtMoney(q.cleaning_fee)) : null,
          el('div', { style: 'font-size:22px;font-weight:700;color:var(--success);margin-top:4px;' }, 'Suggested charge: ' + fmtMoney(q.total))));
        result.appendChild(el('div', { class: 'btn-row', style: 'margin-top:10px;' },
          el('button', { class: 'btn-ghost', type: 'button', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(`${q.property_name} · ${fmtDate(q.from)} → ${fmtDate(q.to)} · ${q.nights} nights · ${fmtMoney(q.total)}`); toast('Quote copied', 'success'); } }, '📋 Copy quote'),
          el('button', { class: 'btn-primary', type: 'button', onclick: () => {
            closeModal();
            const priv = types.find(t => /private/i.test(t.name));
            bookingForm(null, props, types, guests, { onSaved: () => setView('calendar'), prefill: { property_id: Number(d.property_id), check_in: d.from, check_out: d.to, amount: q.total, booking_type_id: priv ? priv.id : null } });
          } }, 'Create private booking →')));
      } catch (err) { result.innerHTML = ''; result.appendChild(el('div', { class: 'login-err' }, err.message || 'Could not get a quote')); }
    });
    wrap.appendChild(form); wrap.appendChild(result);
    openModal('Private booking estimator', wrap);
  }

  // ---------- TO-DO TASKS ----------
  function renderTodoRow(t, onToggle) {
    const today = isoToday();
    const isOverdue = t.status === 'open' && t.due_date && t.due_date < today;
    const cls = ['todo-item', t.status === 'done' ? 'done' : '', isOverdue ? 'overdue' : '', 'priority-' + (t.priority || 'medium')].filter(Boolean).join(' ');
    const row = el('div', { class: cls });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = t.status === 'done';
    cb.addEventListener('change', () => onToggle && onToggle());
    row.appendChild(cb);

    const meta = [];
    meta.push(el('span', { class: 'priority-badge ' + (t.priority || 'medium') }, t.priority || 'medium'));
    if (t.due_date) {
      const lbl = isOverdue
        ? el('span', { style: 'color:var(--danger);font-weight:600;' }, 'Overdue: ' + fmtDate(t.due_date))
        : el('span', null, '📅 ' + fmtDate(t.due_date));
      meta.push(lbl);
    } else {
      meta.push(el('span', { class: 'muted' }, 'No due date'));
    }
    if (t.property_name) meta.push(el('span', null, '🏠 ' + t.property_name));

    const body = el('div', { class: 'todo-body' });
    body.appendChild(el('div', { class: 'todo-title' }, t.title));
    if (t.description) body.appendChild(el('div', { class: 'todo-desc' }, t.description));
    body.appendChild(el('div', { class: 'todo-meta' }, meta));
    row.appendChild(body);
    return row;
  }

  VIEWS.todos = async (root) => {
    const [todos, props] = await Promise.all([API.todos.list(), API.properties.list()]);
    const today = isoToday();
    const inAWeek = new Date(); inAWeek.setDate(inAWeek.getDate() + 7);
    const inAWeekIso = inAWeek.toISOString().slice(0, 10);

    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'To Do'),
      el('button', { class: 'btn-primary', onclick: () => todoForm(null, props) }, '+ New task')
    ));

    // Filter bar
    const filter = el('div', { class: 'filter-bar' });
    const fProp = select('fProp', [{ value: '', label: 'All properties' }, { value: 'none', label: '— no property —' }].concat(props.map(p => ({ value: String(p.id), label: p.nickname }))), '');
    const fPri = select('fPri', [{ value: '', label: 'All priorities' }, { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }], '');
    const showCompletedWrap = el('label', { style: 'margin:0;display:flex;align-items:center;gap:6px;width:auto;' });
    const showCompletedCb = el('input', { type: 'checkbox', name: 'showCompleted', style: 'width:auto;' });
    showCompletedWrap.appendChild(showCompletedCb);
    showCompletedWrap.appendChild(el('span', null, 'Show completed'));
    filter.appendChild(fProp); filter.appendChild(fPri); filter.appendChild(showCompletedWrap);
    root.appendChild(filter);

    const list = el('div');
    root.appendChild(list);

    function render() {
      list.innerHTML = '';
      const filtered = todos.filter(t => {
        if (fProp.value === 'none' && t.property_id) return false;
        if (fProp.value && fProp.value !== 'none' && String(t.property_id) !== fProp.value) return false;
        if (fPri.value && t.priority !== fPri.value) return false;
        return true;
      });

      const open = filtered.filter(t => t.status === 'open');
      const done = filtered.filter(t => t.status === 'done').sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));

      const overdue = open.filter(t => t.due_date && t.due_date < today);
      const thisWeek = open.filter(t => t.due_date && t.due_date >= today && t.due_date <= inAWeekIso);
      const later = open.filter(t => t.due_date && t.due_date > inAWeekIso);
      const noDate = open.filter(t => !t.due_date);

      const sections = [
        { id: 'overdue', title: 'Overdue', tasks: overdue, cls: 'overdue' },
        { id: 'thisWeek', title: 'This week', tasks: thisWeek },
        { id: 'noDate', title: 'No due date', tasks: noDate.sort((a, b) => {
          const order = { high: 0, medium: 1, low: 2 };
          return (order[a.priority] || 1) - (order[b.priority] || 1);
        }) },
        { id: 'later', title: 'Later', tasks: later },
      ];

      let any = false;
      sections.forEach(s => {
        if (!s.tasks.length) return;
        any = true;
        const sec = el('div', { class: 'todo-section ' + (s.cls || '') });
        sec.appendChild(el('h3', null, s.title, el('span', { class: 'count' }, String(s.tasks.length))));
        s.tasks.forEach(t => sec.appendChild(taskRow(t)));
        list.appendChild(sec);
      });

      if (!any) {
        list.appendChild(el('div', { class: 'card empty' }, open.length ? 'No tasks match the current filter.' : 'No open tasks. Add one with + New task.'));
      }

      if (showCompletedCb.checked && done.length) {
        const sec = el('div', { class: 'todo-section completed' });
        sec.appendChild(el('h3', null, 'Completed', el('span', { class: 'count' }, String(done.length))));
        done.forEach(t => sec.appendChild(taskRow(t)));
        list.appendChild(sec);
      }
    }

    function taskRow(t) {
      const row = renderTodoRow(t, async () => {
        await API.todos.update(t.id, { status: t.status === 'open' ? 'done' : 'open' });
        setView('todos');
      });
      const actions = el('div', { class: 'todo-actions' },
        el('button', { class: 'btn-ghost small', onclick: () => todoForm(t, props) }, 'Edit'),
        el('button', { class: 'btn-danger small', onclick: async () => {
          if (!confirm('Delete this task?')) return;
          await API.todos.remove(t.id); setView('todos');
        }}, '×'),
      );
      row.appendChild(actions);
      return row;
    }

    [fProp, fPri, showCompletedCb].forEach(f => f.addEventListener('change', render));
    render();
  };

  function todoForm(t, props, opts) {
    const onSaved = (opts && opts.onSaved) || (() => setView('todos'));
    const form = el('form', { class: 'form-grid' });
    const propOpts = [{ value: '', label: '— none —' }].concat(props.map(p => ({ value: String(p.id), label: p.nickname })));
    const priOpts = [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }];

    form.appendChild(formField('Title *', input('title', { value: t?.title, required: true, placeholder: 'e.g. Cut the grass' })));
    form.appendChild(formField('Priority', select('priority', priOpts, t?.priority || 'medium')));
    form.appendChild(formField('Due date', input('due_date', { type: 'date', value: t?.due_date || '' })));
    form.appendChild(formField('Property (optional)', select('property_id', propOpts, t?.property_id || '')));
    form.appendChild(formField('Notes / details', textarea('description', t?.description, { rows: 3, placeholder: 'Where, what, anything specific...' }), { full: true }));
    if (t) {
      const statusOpts = [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }];
      form.appendChild(formField('Status', select('status', statusOpts, t.status)));
    }

    const buttons = el('div', { class: 'btn-row', style: 'grid-column: 1/-1; margin-top: 8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, t ? 'Save' : 'Create'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel'),
    );
    if (t) buttons.appendChild(el('button', { class: 'btn-danger', type: 'button', onclick: async () => {
      if (!confirm('Delete this task?')) return;
      await API.todos.remove(t.id); closeModal(); onSaved();
    }}, 'Delete'));
    form.appendChild(buttons);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readForm(form);
      const payload = {
        title: d.title,
        description: d.description,
        priority: d.priority,
        due_date: d.due_date || null,
        property_id: d.property_id ? Number(d.property_id) : null,
      };
      if (t) payload.status = d.status || 'open';
      try {
        if (t) await API.todos.update(t.id, payload); else await API.todos.create(payload);
        toast('Saved', 'success'); closeModal(); onSaved();
      } catch (e) {}
    });
    openModal(t ? 'Edit task' : 'New task', form);
  }

  // ---------- BOOKINGS ----------
  VIEWS.bookings = async (root) => {
    const [bookings, props, types, guests] = await Promise.all([
      API.bookings.list(), API.properties.list(), API.bookingTypes.list(), API.guests.list(),
    ]);
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Bookings'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn-ghost', onclick: () => setView('bulk') }, 'Bulk import'),
        el('button', { class: 'btn-primary', onclick: () => bookingForm(null, props, types, guests) }, '+ New booking'),
      ),
    ));
    if (!props.length) { root.appendChild(el('div', { class: 'card empty' }, 'Add a property first.')); return; }

    const filters = el('div', { class: 'filter-bar' });
    const fProp = select('fProp', [{ value: '', label: 'All properties' }].concat(props.map(p => ({ value: String(p.id), label: p.nickname }))), '');
    const fType = select('fType', [{ value: '', label: 'All types' }].concat(types.map(t => ({ value: String(t.id), label: t.name }))), '');
    const yearOpts = [{ value: '', label: 'All years' }];
    const cy = new Date().getFullYear();
    for (let y = cy + 1; y >= cy - 4; y--) yearOpts.push({ value: String(y), label: String(y) });
    const fYear = select('fYear', yearOpts, '');
    filters.appendChild(fProp); filters.appendChild(fType); filters.appendChild(fYear);

    const card = el('div', { class: 'card' });
    card.appendChild(filters);
    const summary = el('div', { class: 'kpi-grid' });
    card.appendChild(summary);
    const tbl = el('table');
    card.appendChild(tbl);
    root.appendChild(card);

    function render() {
      const filtered = bookings.filter(b => {
        if (fProp.value && String(b.property_id) !== fProp.value) return false;
        if (fType.value && String(b.booking_type_id) !== fType.value) return false;
        if (fYear.value && (b.check_in || '').slice(0, 4) !== fYear.value) return false;
        return true;
      });
      summary.innerHTML = '';
      const byType = {};
      filtered.forEach(b => {
        const k = b.booking_type_name || 'Unspecified';
        byType[k] = byType[k] || { count: 0, sum: 0 };
        byType[k].count++; byType[k].sum += b.amount || 0;
      });
      summary.appendChild(kpi('Total bookings (filtered)', filtered.length, ''));
      summary.appendChild(kpi('Total revenue (filtered)', fmtMoney(filtered.reduce((a, b) => a + (b.amount || 0), 0)), '', 'success'));
      Object.entries(byType).forEach(([type, v]) =>
        summary.appendChild(kpi(type, fmtMoney(v.sum), `${v.count} bookings • avg ${fmtMoney(v.sum/v.count)}`)));

      tbl.innerHTML = '';
      tbl.appendChild(el('thead', null, el('tr', null,
        el('th', null, 'Check-in'), el('th', null, 'Check-out'),
        el('th', null, 'Property'), el('th', null, 'Type'),
        el('th', null, 'Guest'), el('th', null, 'Contact'),
        el('th', { class: 'num' }, 'Amount'), el('th', null, ''),
      )));
      const tb = el('tbody');
      filtered.forEach(b => tb.appendChild(el('tr', null,
        el('td', null, fmtDate(b.check_in)),
        el('td', null, fmtDate(b.check_out)),
        el('td', null, b.property_name || ''),
        el('td', null, b.booking_type_name ? el('span', { class: 'badge ' + slug(b.booking_type_name) }, b.booking_type_name) : ''),
        el('td', null, b.guest_name || ''),
        el('td', null, b.contact_name || ''),
        el('td', { class: 'num' }, fmtMoney(b.amount)),
        el('td', null, el('div', { class: 'btn-row' },
          el('button', { class: 'btn-ghost small', onclick: () => openSmsModal(b) }, b.guest_notified_at ? '✓ SMS' : '📱 SMS'),
          el('button', { class: 'btn-ghost', onclick: () => bookingForm(b, props, types, guests) }, 'Edit'),
          el('button', { class: 'btn-danger', onclick: async () => {
            if (!confirm('Delete this booking?')) return;
            await API.bookings.remove(b.id); setView('bookings');
          }}, 'Delete'),
        )),
      )));
      tbl.appendChild(tb);
    }
    [fProp, fType, fYear].forEach(s => s.addEventListener('change', render));
    render();
  };

  function bookingForm(b, props, types, guests, opts) {
    const onSaved = (opts && opts.onSaved) || (() => setView('bookings'));
    const pf = b || (opts && opts.prefill) || {}; // prefill values for a new booking
    const form = el('form', { class: 'form-grid' });
    const propOpts = props.map(p => ({ value: String(p.id), label: p.nickname }));
    const typeOpts = [{ value: '', label: '— none —' }].concat(types.map(t => ({ value: String(t.id), label: t.name })));
    const guestOpts = [{ value: '', label: '— new guest below —' }].concat(guests.map(g => ({ value: String(g.id), label: g.name + (g.email ? ` <${g.email}>` : '') })));

    form.appendChild(formField('Property *', select('property_id', propOpts, pf.property_id)));
    form.appendChild(formField('Booking type', select('booking_type_id', typeOpts, pf.booking_type_id || '')));
    form.appendChild(formField('Check-in *', input('check_in', { type: 'date', value: pf.check_in || (opts && opts.defaultDate) || isoToday(), required: true })));
    form.appendChild(formField('Check-out', input('check_out', { type: 'date', value: pf.check_out })));
    form.appendChild(formField('Amount', input('amount', { type: 'number', value: pf.amount || '', step: '0.01' })));
    form.appendChild(formField('Existing guest', select('guest_id', guestOpts, pf.guest_id || '')));
    form.appendChild(formField('Contact name (free text)', input('contact_name', { value: pf.contact_name, placeholder: 'name on the booking' })));
    form.appendChild(formField('+ New guest name', input('new_guest_name', { value: '', placeholder: 'optional' })));
    form.appendChild(formField('+ New guest email', input('new_guest_email', { type: 'email' })));
    form.appendChild(formField('+ New guest phone', input('new_guest_phone')));
    form.appendChild(formField('Door code', input('door_code', { value: pf.door_code, placeholder: 'sent in pre-arrival message' })));
    form.appendChild(formField('Notes', textarea('notes', pf.notes), { full: true }));
    let cancelCb = null;
    if (b) {
      cancelCb = el('input', { type: 'checkbox', style: 'width:auto;' }); cancelCb.checked = b.status === 'cancelled';
      form.appendChild(el('label', { style: 'grid-column:1/-1;display:flex;gap:8px;align-items:center;' }, cancelCb, 'Cancelled (frees the calendar, excluded from revenue)'));
    }
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column: 1/-1; margin-top: 8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, b ? 'Save changes' : 'Create booking'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel'),
    ));
    // Upsells / add-ons (existing bookings only — needs a booking id)
    if (b) {
      const upWrap = el('div', { style: 'grid-column:1/-1;border-top:1px solid var(--border);margin-top:10px;padding-top:10px;' },
        el('strong', null, 'Add-ons / upsells'), el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px;' }, 'Firewood, early check-in, pet fee… counts as ancillary revenue.'));
      const list = el('div'); upWrap.appendChild(list);
      const renderUps = async () => {
        list.innerHTML = '';
        const [items, catalog] = await Promise.all([API.bookingUpsells.list(b.id), API.upsells.list()]);
        items.forEach(u => list.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;padding:2px 0;' },
          el('span', { style: 'flex:1;' }, `${u.name} ×${u.qty || 1}`), el('span', null, fmtMoney((u.price || 0) * (u.qty || 1))),
          el('button', { class: 'btn-danger', type: 'button', onclick: async () => { await API.bookingUpsells.remove(u.id); renderUps(); } }, '×'))));
        const catSel = select('add_upsell', [{ value: '', label: '+ add add-on…' }].concat(catalog.filter(c => c.active).map(c => ({ value: c.id + '|' + c.name + '|' + c.default_price, label: `${c.name} (${fmtMoney(c.default_price)})` }))), '');
        catSel.style.width = 'auto';
        catSel.addEventListener('change', async () => {
          if (!catSel.value) return; const [, name, price] = catSel.value.split('|');
          await API.bookingUpsells.create({ booking_id: b.id, name, price: Number(price) || 0, qty: 1 }); renderUps();
        });
        list.appendChild(el('div', { style: 'margin-top:6px;' }, catSel));
      };
      form.appendChild(upWrap); renderUps();
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readForm(form);
      const payload = {
        property_id: Number(d.property_id),
        booking_type_id: d.booking_type_id ? Number(d.booking_type_id) : null,
        guest_id: d.guest_id ? Number(d.guest_id) : null,
        check_in: d.check_in, check_out: d.check_out || null,
        amount: Number(d.amount) || 0, contact_name: d.contact_name, notes: d.notes,
        door_code: d.door_code || '',
      };
      if (cancelCb) payload.status = cancelCb.checked ? 'cancelled' : 'confirmed';
      if (!payload.guest_id && d.new_guest_name) {
        payload.new_guest = { name: d.new_guest_name, email: d.new_guest_email, phone: d.new_guest_phone };
      }
      try {
        if (b) await API.bookings.update(b.id, payload); else await API.bookings.create(payload);
        toast('Saved', 'success'); closeModal(); onSaved();
      } catch (e) {}
    });
    openModal(b ? 'Edit booking' : 'New booking', form);
  }

  function openSmsModal(booking) {
    const wrap = el('div');
    const msgTypes = [
      { value: 'welcome', label: 'Welcome Message' },
      { value: 'check_in', label: 'Check-in Instructions' },
      { value: 'attractions', label: 'Nearby Attractions' },
      { value: 'contact', label: 'Contact Info' },
      { value: 'all', label: 'All Combined' },
      { value: 'custom', label: 'Custom Message' },
    ];
    const typeSel = select('msg_type', msgTypes, 'all');
    const customWrap = el('div', { style: 'display:none; margin-top:8px;' });
    const customArea = textarea('custom_msg', '', { rows: 4, placeholder: 'Type your custom message here…' });
    customWrap.appendChild(customArea);

    typeSel.addEventListener('change', () => {
      customWrap.style.display = typeSel.value === 'custom' ? 'block' : 'none';
    });

    const info = el('div', { class: 'muted', style: 'font-size:12px; margin:8px 0;' },
      'Guest: ' + (booking.guest_name || booking.contact_name || '—') + ' • Property: ' + (booking.property_name || '—')
    );

    const sendBtn = el('button', { class: 'btn-primary', onclick: async () => {
      const type = typeSel.value;
      const payload = { message_type: type };
      if (type === 'custom') {
        payload.custom_message = customArea.value.trim();
        if (!payload.custom_message) { toast('Enter a message', 'error'); return; }
      }
      sendBtn.textContent = 'Sending…'; sendBtn.disabled = true;
      try {
        await API.notifyGuest(booking.id, payload);
        toast('SMS sent!', 'success');
        closeModal();
        setView('bookings');
      } catch (e) {
        toast(e.message || 'SMS failed', 'error');
        sendBtn.textContent = 'Send SMS'; sendBtn.disabled = false;
      }
    }}, 'Send SMS');

    wrap.appendChild(info);
    wrap.appendChild(formField('Message type', typeSel));
    wrap.appendChild(customWrap);
    wrap.appendChild(el('div', { class: 'btn-row', style: 'margin-top:12px;' },
      sendBtn,
      el('button', { class: 'btn-ghost', onclick: closeModal }, 'Cancel'),
    ));

    openModal('Send SMS to Guest', wrap);
  }

  // ---------- BULK IMPORT ----------
  VIEWS.bulk = async (root) => {
    const [props, types] = await Promise.all([API.properties.list(), API.bookingTypes.list()]);
    root.appendChild(el('h1', null, 'Bulk Import Bookings'));
    root.appendChild(el('p', { class: 'muted' },
      'Add rows below or paste from a spreadsheet (TSV — copy a block of cells from Excel/Google Sheets). ',
      'Required: Check-in, Property, Amount. Property and Booking type can be names — unknown booking types will be auto-created.'
    ));

    if (!props.length) { root.appendChild(el('div', { class: 'card empty' }, 'Add a property first.')); return; }

    // Paste-from-spreadsheet card
    const pasteCard = el('div', { class: 'card' });
    pasteCard.appendChild(el('h3', null, 'Paste from spreadsheet'));
    pasteCard.appendChild(el('p', { class: 'muted', style: 'font-size:12px;' },
      'Tab-separated columns in this order: Check-in (YYYY-MM-DD)  ·  Check-out  ·  Property  ·  Booking type  ·  Amount  ·  Contact name  ·  Guest email'));
    const pasteArea = textarea('paste', '', { rows: 5, placeholder: '2026-05-01\t2026-05-04\tLake Cottage\tAirbnb\t850\tJane Doe\tjane@example.com' });
    pasteCard.appendChild(pasteArea);
    pasteCard.appendChild(el('div', { class: 'btn-row', style: 'margin-top:8px;' },
      el('button', { class: 'btn-ghost', onclick: () => { pasteToRows(pasteArea.value); pasteArea.value = ''; } }, 'Add rows from paste')
    ));
    root.appendChild(pasteCard);

    // Grid card
    const card = el('div', { class: 'card' });
    const tbl = el('table', { class: 'bulk-table' });
    tbl.appendChild(el('thead', null, el('tr', null,
      el('th', null, '#'),
      el('th', null, 'Check-in *'),
      el('th', null, 'Check-out'),
      el('th', null, 'Property *'),
      el('th', null, 'Booking type'),
      el('th', { class: 'num' }, 'Amount'),
      el('th', null, 'Contact name'),
      el('th', null, 'Guest email'),
      el('th', null, ''),
    )));
    const tbody = el('tbody');
    tbl.appendChild(tbody);
    card.appendChild(tbl);

    const errorBox = el('div');
    card.appendChild(errorBox);

    card.appendChild(el('div', { class: 'btn-row', style: 'margin-top:12px;' },
      el('button', { class: 'btn-ghost', onclick: () => addRow() }, '+ Add row'),
      el('button', { class: 'btn-ghost', onclick: () => { tbody.innerHTML = ''; addRow(); addRow(); addRow(); errorBox.innerHTML = ''; } }, 'Clear all'),
      el('button', { class: 'btn-primary', onclick: () => importAll() }, 'Import all rows'),
    ));
    root.appendChild(card);

    function addRow(values) {
      values = values || {};
      const tr = el('tr');
      const propOpts = [{ value: '', label: '—' }].concat(props.map(p => ({ value: p.nickname, label: p.nickname })));
      const typeOpts = [{ value: '', label: '—' }].concat(types.map(t => ({ value: t.name, label: t.name })));

      const num = el('td', { class: 'row-num' });
      const ci = el('td', null, input('check_in', { type: 'date', value: values.check_in }));
      const co = el('td', null, input('check_out', { type: 'date', value: values.check_out }));
      const pr = el('td', null, select('property_name', propOpts, values.property_name || ''));
      const ty = el('td', null, select('booking_type_name', typeOpts, values.booking_type_name || ''));
      const am = el('td', { class: 'num' }, input('amount', { type: 'number', step: '0.01', value: values.amount }));
      const cn = el('td', null, input('contact_name', { value: values.contact_name }));
      const ge = el('td', null, input('guest_email', { type: 'email', value: values.guest_email }));
      const ac = el('td', { class: 'row-actions' },
        el('button', { class: 'icon-btn', title: 'Remove row', onclick: () => { tr.remove(); renumber(); } }, '×')
      );
      tr.appendChild(num); tr.appendChild(ci); tr.appendChild(co); tr.appendChild(pr); tr.appendChild(ty); tr.appendChild(am); tr.appendChild(cn); tr.appendChild(ge); tr.appendChild(ac);
      tbody.appendChild(tr);
      renumber();
      return tr;
    }
    function renumber() {
      $$('tr', tbody).forEach((tr, i) => { $('.row-num', tr).textContent = String(i + 1); });
    }
    function pasteToRows(text) {
      if (!text) return;
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      let added = 0;
      lines.forEach(line => {
        const cells = line.split('\t');
        if (!cells[0]) return;
        addRow({
          check_in: (cells[0] || '').trim(),
          check_out: (cells[1] || '').trim(),
          property_name: (cells[2] || '').trim(),
          booking_type_name: (cells[3] || '').trim(),
          amount: (cells[4] || '').trim(),
          contact_name: (cells[5] || '').trim(),
          guest_email: (cells[6] || '').trim(),
        });
        added++;
      });
      toast(`Added ${added} row${added === 1 ? '' : 's'} from paste`);
    }
    function readRow(tr) {
      const out = {};
      $$('input, select', tr).forEach(f => { out[f.name] = f.value.trim(); });
      out.guest_name = out.contact_name; // use contact name as the guest's name when creating
      return out;
    }
    async function importAll() {
      const rows = $$('tr', tbody).map(readRow).filter(r => r.check_in || r.amount || r.property_name);
      if (!rows.length) { toast('Nothing to import', 'error'); return; }
      try {
        const result = await API.bookings.bulk(rows);
        errorBox.innerHTML = '';
        if (result.errors.length) {
          const list = el('div', { class: 'card', style: 'margin-top:12px; background:#fef2f2; border-color:#fecaca;' });
          list.appendChild(el('strong', null, `${result.inserted} imported, ${result.errors.length} failed:`));
          result.errors.forEach(e => list.appendChild(el('div', { class: 'bulk-error' }, `Row ${e.row}: ${e.error}`)));
          errorBox.appendChild(list);
          // highlight error rows
          $$('tr', tbody).forEach((tr, i) => tr.classList.toggle('bulk-error-row', result.errors.some(e => e.row === i + 1)));
          toast(`Imported ${result.inserted} of ${rows.length}`, 'error');
        } else {
          toast(`Imported all ${result.inserted} bookings`, 'success');
          tbody.innerHTML = ''; addRow(); addRow(); addRow();
        }
      } catch (e) {}
    }

    // start with 5 empty rows
    for (let i = 0; i < 5; i++) addRow();
  };

  // ---------- BOOKING REQUESTS ----------
  VIEWS.requests = async (root) => {
    const requests = await API.bookingRequests.list();
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Booking Requests'),
      el('div', { class: 'muted' }, 'Inbound requests from the public booking page')
    ));
    if (!requests.length) {
      root.appendChild(el('div', { class: 'card empty' }, 'No booking requests yet.'));
      return;
    }
    const card = el('div', { class: 'card' });
    const tbl = el('table');
    tbl.appendChild(el('thead', null, el('tr', null,
      el('th', null, 'Status'), el('th', null, 'Submitted'),
      el('th', null, 'Guest'), el('th', null, 'Property'),
      el('th', null, 'Dates'), el('th', { class: 'num' }, 'Proposed'),
      el('th', null, 'Message'), el('th', null, ''),
    )));
    const tb = el('tbody');
    requests.forEach(r => {
      const actions = el('div', { class: 'btn-row' });
      if (r.status === 'pending') {
        actions.appendChild(el('button', { class: 'btn-primary small', onclick: async () => {
          if (!confirm(`Approve and create a booking for ${r.guest_name} at ${r.property_name}?`)) return;
          try { await API.bookingRequests.approve(r.id); toast('Approved — booking created', 'success'); setView('requests'); } catch (e) {}
        }}, 'Approve'));
        actions.appendChild(el('button', { class: 'btn-ghost small', onclick: async () => {
          await API.bookingRequests.reject(r.id); setView('requests');
        }}, 'Reject'));
      }
      actions.appendChild(el('button', { class: 'btn-danger small', onclick: async () => {
        if (!confirm('Delete this request?')) return;
        await API.bookingRequests.remove(r.id); setView('requests');
      }}, '×'));

      tb.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'badge ' + r.status }, r.status)),
        el('td', null, fmtDate(r.created_at)),
        el('td', null, el('strong', null, r.guest_name || '—'), el('div', { class: 'muted', style: 'font-size:12px;' }, r.guest_email || '')),
        el('td', null, r.property_name || ''),
        el('td', null, `${fmtDate(r.check_in)}${r.check_out ? ' → ' + fmtDate(r.check_out) : ''}`),
        el('td', { class: 'num' }, r.proposed_amount ? fmtMoney(r.proposed_amount) : '—'),
        el('td', null, el('div', { style: 'max-width:280px; font-size:12px;' }, r.message || el('span', { class: 'muted' }, '—'))),
        el('td', null, actions),
      ));
    });
    tbl.appendChild(tb);
    card.appendChild(tbl);
    root.appendChild(card);
  };

  // ---------- GUESTS ----------
  VIEWS.guests = async (root) => {
    const guests = await API.guests.list();
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Past & Booked Guests'),
      el('button', { class: 'btn-primary', onclick: () => guestForm() }, '+ New guest')
    ));
    if (!guests.length) {
      root.appendChild(el('div', { class: 'card empty' }, 'Guests are added automatically when you create a booking, or click + New guest.'));
      return;
    }
    const card = el('div', { class: 'card' });
    const tbl = el('table');
    tbl.appendChild(el('thead', null, el('tr', null,
      el('th', null, 'Name'), el('th', null, 'Email'), el('th', null, 'Phone'),
      el('th', null, 'Address'), el('th', null, 'Notes'), el('th', null, ''),
    )));
    const tb = el('tbody');
    guests.forEach(g => tb.appendChild(el('tr', null,
      el('td', null, el('strong', null, g.name)),
      el('td', null, g.email || ''),
      el('td', null, g.phone || ''),
      el('td', null, g.address || ''),
      el('td', null, (g.notes || '').slice(0, 80)),
      el('td', null, el('div', { class: 'btn-row' },
        el('button', { class: 'btn-ghost', onclick: () => guestForm(g) }, 'Edit'),
        el('button', { class: 'btn-danger', onclick: async () => {
          if (!confirm(`Delete guest "${g.name}"?`)) return;
          await API.guests.remove(g.id); setView('guests');
        }}, 'Delete'),
      )),
    )));
    tbl.appendChild(tb);
    card.appendChild(tbl);
    root.appendChild(card);
  };
  function guestForm(g) {
    const form = el('form', { class: 'form-grid' });
    form.appendChild(formField('Name *', input('name', { value: g?.name, required: true })));
    form.appendChild(formField('Email', input('email', { type: 'email', value: g?.email })));
    form.appendChild(formField('Phone', input('phone', { value: g?.phone })));
    form.appendChild(formField('Address', input('address', { value: g?.address })));
    form.appendChild(formField('Notes', textarea('notes', g?.notes), { full: true }));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column: 1/-1; margin-top: 8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, g ? 'Save' : 'Create'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel'),
    ));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readForm(form);
      try { if (g) await API.guests.update(g.id, d); else await API.guests.create(d); toast('Saved', 'success'); closeModal(); setView('guests'); } catch (e) {}
    });
    openModal(g ? 'Edit guest' : 'New guest', form);
  }

  // ---------- CLEANERS ----------
  VIEWS.cleaners = async (root) => {
    const list = await API.cleaners.list();
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Cleaners & Contacts'),
      el('button', { class: 'btn-primary', onclick: () => cleanerForm() }, '+ New cleaner')
    ));
    if (!list.length) { root.appendChild(el('div', { class: 'card empty' }, 'No cleaners yet — add the people who service your properties.')); return; }
    const card = el('div', { class: 'card' });
    const tbl = el('table');
    tbl.appendChild(el('thead', null, el('tr', null,
      el('th', null, 'Name'), el('th', null, 'Phone'), el('th', null, 'Email'),
      el('th', { class: 'num' }, 'Rate'), el('th', null, 'Notes'), el('th', null, ''),
    )));
    const tb = el('tbody');
    list.forEach(c => tb.appendChild(el('tr', null,
      el('td', null, el('strong', null, c.name)),
      el('td', null, c.phone ? el('a', { href: 'tel:' + c.phone }, c.phone) : ''),
      el('td', null, c.email ? el('a', { href: 'mailto:' + c.email }, c.email) : ''),
      el('td', { class: 'num' }, c.rate ? fmtMoney(c.rate) : ''),
      el('td', null, (c.notes || '').slice(0, 80)),
      el('td', null, el('div', { class: 'btn-row' },
        el('button', { class: 'btn-ghost', onclick: () => cleanerForm(c) }, 'Edit'),
        el('button', { class: 'btn-danger', onclick: async () => {
          if (!confirm(`Delete cleaner "${c.name}" and all their tasks?`)) return;
          await API.cleaners.remove(c.id); setView('cleaners');
        }}, 'Delete'),
      )),
    )));
    tbl.appendChild(tb);
    card.appendChild(tbl);
    root.appendChild(card);
  };
  function cleanerForm(c) {
    const form = el('form', { class: 'form-grid' });
    form.appendChild(formField('Name *', input('name', { value: c?.name, required: true })));
    form.appendChild(formField('Phone', input('phone', { value: c?.phone })));
    form.appendChild(formField('Email', input('email', { type: 'email', value: c?.email })));
    form.appendChild(formField('Rate (per visit)', input('rate', { type: 'number', value: c?.rate || '', step: '0.01' })));
    form.appendChild(formField('Notes', textarea('notes', c?.notes), { full: true }));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column: 1/-1; margin-top: 8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, c ? 'Save' : 'Create'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel'),
    ));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readForm(form);
      try { if (c) await API.cleaners.update(c.id, d); else await API.cleaners.create(d); toast('Saved', 'success'); closeModal(); setView('cleaners'); } catch (e) {}
    });
    openModal(c ? 'Edit cleaner' : 'New cleaner', form);
  }

  // ---------- CLEANER CALENDAR ----------
  let cleanerCursor = new Date();
  VIEWS.cleanerCal = async (root) => {
    const [tasks, cleaners, props] = await Promise.all([API.cleanerTasks.list(), API.cleaners.list(), API.properties.list()]);

    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Cleaner Calendar'),
      el('div', { class: 'muted' },
        'Tasks auto-created when a booking is added for a property with an assigned cleaner. Click a task to mark done or edit.'
      ),
    ));

    if (!cleaners.length) {
      root.appendChild(el('div', { class: 'card empty' }, 'Add at least one cleaner first, then assign them as the default cleaner on a property.'));
      return;
    }
    if (!props.some(p => p.default_cleaner_id)) {
      root.appendChild(el('div', { class: 'card', style: 'background:#fef3c7;border-color:#fde68a;' },
        '⚠ No properties have a default cleaner assigned yet. Edit a property and choose a cleaner to start auto-generating turnover tasks.'));
    }

    // Color per cleaner
    const palette = ['#0ea5e9', '#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#ef4444', '#6366f1'];
    const colorOf = (cleanerId) => {
      const idx = cleaners.findIndex(c => c.id === cleanerId);
      return palette[idx % palette.length] || '#64748b';
    };

    // Filter
    const wrap = el('div', { class: 'cal-wrap' });
    const head = el('div', { class: 'cal-head' });
    const monthLbl = el('h2', null, cleanerCursor.toLocaleDateString('en-CA', { year: 'numeric', month: 'long' }));
    const cleanerFilter = select('cleaner', [{ value: '', label: 'All cleaners' }].concat(cleaners.map(c => ({ value: String(c.id), label: c.name }))), '');
    cleanerFilter.style.width = 'auto';
    cleanerFilter.addEventListener('change', () => render());
    const prev = el('button', { class: 'btn-ghost', onclick: () => { cleanerCursor.setMonth(cleanerCursor.getMonth() - 1); setView('cleanerCal'); } }, '←');
    const next = el('button', { class: 'btn-ghost', onclick: () => { cleanerCursor.setMonth(cleanerCursor.getMonth() + 1); setView('cleanerCal'); } }, '→');
    const today = el('button', { class: 'btn-ghost', onclick: () => { cleanerCursor = new Date(); setView('cleanerCal'); } }, 'Today');
    const addBtn = el('button', { class: 'btn-primary small', onclick: () => cleanerTaskForm(null, cleaners, props) }, '+ New task');
    head.appendChild(el('div', { class: 'btn-row' }, prev, today, next));
    head.appendChild(monthLbl);
    head.appendChild(el('div', { class: 'btn-row' }, cleanerFilter, addBtn));
    wrap.appendChild(head);

    // legend
    const legend = el('div', { class: 'cleaner-legend' });
    cleaners.forEach((c, i) => legend.appendChild(el('span', null,
      el('span', { class: 'swatch', style: 'background:' + palette[i % palette.length] }),
      el('span', null, c.name)
    )));
    wrap.appendChild(legend);

    const grid = el('div', { class: 'cal-grid' });
    wrap.appendChild(grid);

    function render() {
      grid.innerHTML = '';
      const cleanerId = cleanerFilter.value;
      ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(n => grid.appendChild(el('div', { class: 'cal-dayname' }, n)));
      const first = new Date(cleanerCursor.getFullYear(), cleanerCursor.getMonth(), 1);
      const startDayIdx = first.getDay();
      const daysInMonth = new Date(cleanerCursor.getFullYear(), cleanerCursor.getMonth() + 1, 0).getDate();
      const todayStr = isoToday();
      const filtered = tasks.filter(t => !cleanerId || String(t.cleaner_id) === cleanerId);

      for (let i = 0; i < startDayIdx; i++) {
        const d = new Date(cleanerCursor.getFullYear(), cleanerCursor.getMonth(), -startDayIdx + i + 1);
        grid.appendChild(dayCell(d, true, filtered));
      }
      for (let day = 1; day <= daysInMonth; day++) {
        const d = new Date(cleanerCursor.getFullYear(), cleanerCursor.getMonth(), day);
        grid.appendChild(dayCell(d, false, filtered, todayStr));
      }
      const trailing = (7 - ((startDayIdx + daysInMonth) % 7)) % 7;
      for (let i = 1; i <= trailing; i++) {
        const d = new Date(cleanerCursor.getFullYear(), cleanerCursor.getMonth() + 1, i);
        grid.appendChild(dayCell(d, true, filtered));
      }
    }
    function dayCell(date, isOther, evs, todayStr) {
      const iso = date.toISOString().slice(0, 10);
      const cell = el('div', { class: 'cal-day' + (isOther ? ' other' : '') + (iso === todayStr ? ' today' : '') },
        el('div', { class: 'dnum' }, String(date.getDate())));
      evs.forEach(t => {
        if (t.due_date !== iso) return;
        const color = colorOf(t.cleaner_id);
        const sameDay = t.same_day_turnover;
        const deadlineLine = t.clean_by
          ? (sameDay ? '⚠ same-day turn' : 'clean by ' + fmtDate(t.clean_by))
          : 'no next booking';
        const tip = `${t.cleaner_name} → ${t.property_name}\n`
          + `Guest checkout: ${fmtDate(t.booking_check_out || t.due_date)}\n`
          + (t.clean_by
              ? `Clean by: ${fmtDate(t.clean_by)} — next guest checks in`
                + (sameDay ? ' (SAME-DAY TURNAROUND!)' : ` (${t.clean_window_days}-day window)`)
              : 'No upcoming booking — flexible')
          + (t.notes ? '\n' + t.notes : '');
        const ev = el('span', {
          class: 'cal-event cleaning' + (t.status === 'done' ? ' done' : ''),
          style: `background:${color}22; color:${color}; border-left:3px solid ${sameDay ? 'var(--danger)' : color}; padding-left:5px;`,
          title: tip,
          onclick: () => cleanerTaskForm(t, cleaners, props),
        },
          el('span', null, `🧹 ${t.cleaner_name}: ${t.property_name}`),
          el('span', {
            style: 'display:block;font-size:.78em;opacity:.9;'
              + (sameDay ? 'color:var(--danger);font-weight:700;opacity:1;' : ''),
          }, deadlineLine),
        );
        cell.appendChild(ev);
      });
      return cell;
    }
    render();
    root.appendChild(wrap);
  };

  function cleanerTaskForm(t, cleaners, props) {
    const form = el('form', { class: 'form-grid' });
    const cleanerOpts = cleaners.map(c => ({ value: String(c.id), label: c.name }));
    const propOpts = props.map(p => ({ value: String(p.id), label: p.nickname }));
    const statusOpts = [{ value: 'pending', label: 'Pending' }, { value: 'done', label: 'Done' }];

    form.appendChild(formField('Cleaner *', select('cleaner_id', cleanerOpts, t?.cleaner_id)));
    form.appendChild(formField('Property *', select('property_id', propOpts, t?.property_id)));
    form.appendChild(formField('Due date *', input('due_date', { type: 'date', value: t?.due_date || isoToday(), required: true })));
    form.appendChild(formField('Status', select('status', statusOpts, t?.status || 'pending')));
    form.appendChild(formField('Notes', textarea('notes', t?.notes), { full: true }));
    if (t?.booking_check_in) {
      form.appendChild(el('p', { class: 'muted', style: 'grid-column: 1/-1; font-size:12px;' },
        `Linked to booking: ${fmtDate(t.booking_check_in)} → ${fmtDate(t.booking_check_out)}, guest ${t.guest_name || '—'}`
      ));
    }
    if (t && (t.clean_by || t.clean_by === null)) {
      const sameDay = t.same_day_turnover;
      form.appendChild(el('p', {
        style: 'grid-column: 1/-1; font-size:12px;'
          + (sameDay ? 'color:var(--danger);font-weight:700;' : 'color:var(--muted);'),
      }, t.clean_by
          ? (sameDay
              ? `⚠ Clean by ${fmtDate(t.clean_by)} — SAME-DAY turnaround, next guest checks in that day.`
              : `🧽 Clean by ${fmtDate(t.clean_by)} — next guest checks in (${t.clean_window_days}-day window).`)
          : '🧽 No upcoming booking at this property — clean any time.'));
    }

    const buttons = el('div', { class: 'btn-row', style: 'grid-column: 1/-1; margin-top: 8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, t ? 'Save' : 'Create'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel'),
    );
    if (t) {
      const notifyBtn = el('button', { class: 'btn-primary small', type: 'button', style: 'margin-left:auto;', onclick: async () => {
        notifyBtn.textContent = 'Sending…';
        notifyBtn.disabled = true;
        try {
          await API.cleanerTasks.notify(t.id);
          toast('SMS sent to cleaner!', 'success');
          notifyBtn.textContent = '✓ Sent';
        } catch (e) {
          toast(e.message || 'Failed to send SMS', 'error');
          notifyBtn.textContent = '📱 Notify';
          notifyBtn.disabled = false;
        }
      }}, '📱 Notify');
      if (t.notified_at) notifyBtn.title = 'Last notified: ' + fmtDate(t.notified_at);
      buttons.appendChild(notifyBtn);
      buttons.appendChild(el('button', { class: 'btn-danger', type: 'button', onclick: async () => {
        if (!confirm('Delete this task?')) return;
        await API.cleanerTasks.remove(t.id); closeModal(); setView('cleanerCal');
      }}, 'Delete'));
    }
    form.appendChild(buttons);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readForm(form);
      try {
        if (t) await API.cleanerTasks.update(t.id, d); else await API.cleanerTasks.create(d);
        toast('Saved', 'success'); closeModal(); setView('cleanerCal');
      } catch (e) {}
    });
    openModal(t ? 'Edit cleaning task' : 'New cleaning task', form);
  }

  // ---------- MAILING LIST ----------
  VIEWS.mailing = async (root) => {
    const rows = await API.mailingList();
    const props = await API.properties.list();

    root.appendChild(el('h1', null, 'Mailing List — All Past Guests'));
    root.appendChild(el('p', { class: 'muted' },
      'Every guest who has stayed, with months since their last booking. Generate a personalized return-stay email for any of them.'
    ));
    if (!rows.length) {
      root.appendChild(el('div', { class: 'card empty' }, 'No guests yet — add bookings with guest emails to start building your list.'));
      return;
    }

    // Filter bar
    const filter = el('div', { class: 'filter-bar card', style: 'margin-bottom:16px;' });
    filter.appendChild(el('label', { style: 'margin:0; display:flex; align-items:center; gap:8px;' },
      el('span', { class: 'lbl', style: 'margin:0;' }, 'Discount %'),
      (() => { const i = input('discount', { type: 'number', value: 10 }); i.style.width = '80px'; return i; })()
    ));
    const eligibilityOpts = [
      { value: 'all', label: 'All guests' },
      { value: '11', label: 'Stayed 11+ months ago (year-later invite)' },
      { value: '6', label: 'Stayed 6+ months ago' },
    ];
    filter.appendChild(el('label', { style: 'margin:0;' },
      el('span', { class: 'lbl' }, 'Show'),
      select('elig', eligibilityOpts, '11')
    ));
    filter.appendChild(el('label', { style: 'margin:0;' },
      el('span', { class: 'lbl' }, 'Has email'),
      (() => {
        const wrap = el('div', { style: 'padding:8px 0;' });
        const cb = el('input', { type: 'checkbox', name: 'hasEmail', style: 'width:auto;' });
        cb.checked = true;
        wrap.appendChild(cb);
        return wrap;
      })()
    ));
    root.appendChild(filter);

    const card = el('div', { class: 'card' });
    const summary = el('div', { class: 'between', style: 'margin-bottom:12px;' });
    card.appendChild(summary);
    const tbl = el('table');
    card.appendChild(tbl);
    root.appendChild(card);

    function render() {
      const discount = Number($('input[name="discount"]', filter).value) || 0;
      const elig = $('select[name="elig"]', filter).value;
      const hasEmailReq = $('input[name="hasEmail"]', filter).checked;
      const filtered = rows.filter(r => {
        if (hasEmailReq && !r.guest_email) return false;
        if (elig !== 'all') {
          const min = Number(elig);
          if ((r.months_since_last == null) || r.months_since_last < min) return false;
        }
        return true;
      });

      summary.innerHTML = '';
      summary.appendChild(el('div', null, `${filtered.length} of ${rows.length} guest${rows.length === 1 ? '' : 's'}`));

      tbl.innerHTML = '';
      tbl.appendChild(el('thead', null, el('tr', null,
        el('th', null, 'Guest'), el('th', null, 'Email'),
        el('th', null, 'Last property'), el('th', null, 'Last stay'),
        el('th', { class: 'num' }, 'Months since'),
        el('th', { class: 'num' }, 'Total stays'),
        el('th', null, ''),
      )));
      const tb = el('tbody');
      filtered.forEach(r => {
        const property = props.find(p => p.id === r.last_property_id);
        const tr = el('tr', null,
          el('td', null, r.guest_name || el('span', { class: 'muted' }, '—')),
          el('td', null, r.guest_email || el('span', { class: 'muted' }, '—')),
          el('td', null, r.last_property_name || ''),
          el('td', null, fmtDate(r.last_check_in)),
          el('td', { class: 'num' }, r.months_since_last == null ? '—' : `${r.months_since_last} mo`),
          el('td', { class: 'num' }, String(r.total_stays)),
          el('td', null, el('div', { class: 'btn-row' },
            el('button', {
              class: 'btn-primary small',
              disabled: !r.guest_email ? '' : null,
              onclick: () => generateInvite(r, property, discount, tr),
            }, r.invite_sent ? 'Resend' : 'Email'),
            r.invite_sent ? el('span', { class: 'badge approved', style: 'align-self:center;' }, 'Sent') : null,
          )),
        );
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
    }
    function generateInvite(r, property, discount, tr) {
      if (!r.guest_email) return;
      const subject = `Come back to ${r.last_property_name || 'our place'} — ${discount}% off for returning guests`;
      const welcomeLine = property?.welcome_message ? `\n\n${property.welcome_message}\n` : '';
      const body =
`Hi ${r.guest_name || 'there'},

It was great hosting you at ${r.last_property_name || 'our place'} back in ${fmtDate(r.last_check_in)}. As a thank-you for being a past guest, I'd love to welcome you back this year with ${discount}% off your stay.${welcomeLine}

Just reply with the dates that work for you and I'll get you set up.

Looking forward to hosting you again,
Matt`;
      const mailto = `mailto:${encodeURIComponent(r.guest_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.location.href = mailto;
      // mark the underlying booking as invite_sent
      if (r.last_booking_id) {
        API.bookings.update(r.last_booking_id, { invite_sent: 1 }).catch(() => {});
      }
    }

    $$('input, select', filter).forEach(f => f.addEventListener('change', render));
    $$('input, select', filter).forEach(f => f.addEventListener('input', render));
    render();
  };


  // ---------- LICENSING ----------
  VIEWS.licensing = async (root) => {
    const props = await API.properties.list();
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Rental Licensing Tracker'),
      el('div', { class: 'muted' }, 'Short-Term Rental Accommodations Licensing — By-Law 2025-037'),
    ));
    if (!props.length) {
      root.appendChild(el('div', { class: 'card empty' }, 'Add a property first.'));
      return;
    }

    // Property selector
    const header = el('div', { class: 'between' });
    const propSel = select('prop', props.map(p => ({ value: String(p.id), label: p.nickname })), props[0].id);
    propSel.style.width = 'auto';
    propSel.addEventListener('change', () => renderProp(Number(propSel.value)));
    header.appendChild(propSel);
    root.appendChild(header);

    const wrap = el('div');
    root.appendChild(wrap);

    async function renderProp(propId) {
      let items = await API.licensing.list(propId);
      const property = props.find(p => p.id === propId);
      wrap.innerHTML = '';

      // If no items exist, offer to seed them
      if (!items.length) {
        const seedCard = el('div', { class: 'card' });
        seedCard.appendChild(el('p', null, 'No licensing checklist for this property yet.'));
        seedCard.appendChild(el('button', { class: 'btn-primary', onclick: async () => {
          await API.licensing.seed(propId);
          renderProp(propId);
        }}, 'Create licensing checklist'));
        wrap.appendChild(seedCard);
        return;
      }

      const total = items.length;
      const completed = items.filter(i => i.status === 'complete').length;
      const inProg = items.filter(i => i.status === 'in_progress').length;
      const pctDone = total > 0 ? Math.round((completed / total) * 100) : 0;
      const fillClass = pctDone >= 80 ? 'high' : pctDone >= 40 ? 'mid' : 'low';

      // License status for this property
      const statusCard = el('div', { class: 'card' });
      const statusRow = el('div', { class: 'between' });
      const licBadgeCls = property.license_status === 'licensed' ? 'licensed' : property.license_status === 'pending' ? 'license-pending' : 'unlicensed';
      const licLabel = property.license_status === 'licensed' ? 'Licensed' : property.license_status === 'pending' ? 'Pending' : 'Unlicensed';
      const statusLabel = el('div', null,
        el('strong', null, property.nickname),
        ' — License status: ',
        el('span', { class: 'badge ' + licBadgeCls }, licLabel),
        property.license_renewal_date ? el('span', { class: 'muted', style: 'margin-left:12px;' }, 'Renewal: ' + fmtDate(property.license_renewal_date)) : null,
      );
      const statusSelect = select('license_status',
        [{ value: 'unlicensed', label: 'Unlicensed' }, { value: 'pending', label: 'Pending' }, { value: 'licensed', label: 'Licensed' }],
        property.license_status || 'unlicensed'
      );
      statusSelect.classList.add('license-status-select');
      statusSelect.addEventListener('change', async () => {
        await API.properties.update(propId, { ...property, license_status: statusSelect.value });
        property.license_status = statusSelect.value;
        renderProp(propId);
      });
      const renewalInput = input('license_renewal_date', { type: 'date', value: property.license_renewal_date || '' });
      renewalInput.style.width = '160px';
      renewalInput.addEventListener('change', async () => {
        await API.properties.update(propId, { ...property, license_renewal_date: renewalInput.value || null });
        property.license_renewal_date = renewalInput.value || null;
        toast('Renewal date saved', 'success');
      });

      statusRow.appendChild(statusLabel);
      statusRow.appendChild(el('div', { class: 'btn-row', style: 'align-items:center;' },
        el('span', { class: 'lbl', style: 'margin:0; white-space:nowrap;' }, 'Status:'), statusSelect,
        el('span', { class: 'lbl', style: 'margin:0 0 0 12px; white-space:nowrap;' }, 'Renewal:'), renewalInput,
      ));
      statusCard.appendChild(statusRow);

      // Progress bar
      const progWrap = el('div', { class: 'license-progress' });
      progWrap.appendChild(el('div', { class: 'between', style: 'margin-bottom:0;' },
        el('span', null, completed + ' of ' + total + ' steps complete'),
        el('span', { style: 'font-weight:600;' }, pctDone + '%'),
      ));
      const bar = el('div', { class: 'license-progress-bar' });
      bar.appendChild(el('div', { class: 'license-progress-fill ' + fillClass, style: 'width:' + pctDone + '%;' }));
      progWrap.appendChild(bar);
      if (inProg > 0) progWrap.appendChild(el('div', { class: 'muted', style: 'font-size:12px; margin-top:4px;' }, inProg + ' in progress'));
      statusCard.appendChild(progWrap);
      wrap.appendChild(statusCard);

      // Checklist items
      const listCard = el('div', { class: 'card' });
      listCard.appendChild(el('div', { class: 'between', style: 'margin-bottom:12px;' },
        el('h2', null, 'Application Checklist'),
        el('button', { class: 'btn-ghost small', onclick: () => licensingItemForm(null, propId, renderProp) }, '+ Add step'),
      ));

      items.forEach(item => {
        var isComplete = item.status === 'complete';
        var row = el('div', { class: 'licensing-item ' + item.status });
        var cb = el('input', { type: 'checkbox' });
        cb.checked = isComplete;
        cb.addEventListener('change', async () => {
          var newStatus = cb.checked ? 'complete' : 'not_started';
          await API.licensing.update(item.id, { status: newStatus });
          renderProp(propId);
        });
        row.appendChild(cb);

        var body = el('div', { class: 'lic-body' });
        body.appendChild(el('div', { class: 'lic-title' }, item.step_name));
        if (item.description) body.appendChild(el('div', { class: 'lic-desc' }, item.description));
        var meta = [];
        if (item.bylaw_ref) meta.push(el('span', null, '📜 ' + item.bylaw_ref));
        if (item.status === 'in_progress') meta.push(el('span', { class: 'badge warning' }, 'In Progress'));
        if (item.completed_date) meta.push(el('span', null, '✓ ' + fmtDate(item.completed_date)));
        if (meta.length) body.appendChild(el('div', { class: 'lic-meta' }, meta));
        if (item.notes) body.appendChild(el('div', { class: 'lic-notes' }, item.notes));

        // File upload section for allowed steps
        if (item.uploads_allowed) {
          var uploadSection = el('div', { class: 'lic-uploads' });

          // Show existing attachments
          if (item.attachments && item.attachments.length) {
            var fileList = el('div', { class: 'lic-file-list' });
            item.attachments.forEach(att => {
              var isImage = /^image\//i.test(att.mime_type);
              var fileRow = el('div', { class: 'lic-file-row' });
              if (isImage && att.url) {
                fileRow.appendChild(el('img', { class: 'lic-file-thumb', src: att.url, alt: att.original_name }));
              } else {
                fileRow.appendChild(el('span', { class: 'lic-file-icon' }, '📄'));
              }
              fileRow.appendChild(el('a', { class: 'lic-file-name', href: att.url || '#', target: '_blank' }, att.original_name));
              fileRow.appendChild(el('span', { class: 'muted', style: 'font-size:11px;' }, (att.size / 1024).toFixed(0) + ' KB'));
              fileRow.appendChild(el('button', { class: 'btn-danger small', title: 'Remove', onclick: async () => {
                if (!confirm('Remove this file?')) return;
                await API.licensing.deleteFile(item.id, att.path);
                renderProp(propId);
              }}, '×'));
              fileList.appendChild(fileRow);
            });
            uploadSection.appendChild(fileList);
          }

          // Upload button
          var fileInput = el('input', { type: 'file', multiple: true, style: 'display:none', accept: 'image/*,.pdf,.doc,.docx,.dwg' });
          var uploadBtn = el('button', { class: 'btn-ghost small lic-upload-btn', onclick: () => fileInput.click() }, '📎 Upload files');
          fileInput.addEventListener('change', async () => {
            if (!fileInput.files.length) return;
            var fd = new FormData();
            for (var f of fileInput.files) fd.append('files', f);
            uploadBtn.textContent = 'Uploading…';
            uploadBtn.disabled = true;
            try {
              await API.licensing.upload(item.id, fd);
              toast('Files uploaded', 'success');
              renderProp(propId);
            } catch (e) {
              toast('Upload failed', 'error');
              uploadBtn.textContent = '📎 Upload files';
              uploadBtn.disabled = false;
            }
          });
          uploadSection.appendChild(el('div', { class: 'lic-upload-area' }, fileInput, uploadBtn));
          body.appendChild(uploadSection);
        }

        row.appendChild(body);

        var actions = el('div', { class: 'lic-actions' });
        if (!isComplete) {
          actions.appendChild(el('button', { class: 'btn-ghost small', onclick: async () => {
            await API.licensing.update(item.id, { status: 'in_progress' });
            renderProp(propId);
          }}, 'In Progress'));
        }
        actions.appendChild(el('button', { class: 'btn-ghost small', onclick: () => licensingItemForm(item, propId, renderProp) }, 'Edit'));
        actions.appendChild(el('button', { class: 'btn-danger small', onclick: async () => {
          if (!confirm('Delete this licensing step?')) return;
          await API.licensing.remove(item.id);
          renderProp(propId);
        }}, '×'));
        row.appendChild(actions);
        listCard.appendChild(row);
      });
      wrap.appendChild(listCard);
    }
    renderProp(props[0].id);
  };

  function licensingItemForm(item, propId, refresh) {
    var form = el('form', { class: 'form-grid' });
    var statusOpts = [
      { value: 'not_started', label: 'Not Started' },
      { value: 'in_progress', label: 'In Progress' },
      { value: 'complete', label: 'Complete' },
    ];
    form.appendChild(formField('Step name *', input('step_name', { value: item ? item.step_name : '', required: true })));
    form.appendChild(formField('Status', select('status', statusOpts, item ? item.status : 'not_started')));
    form.appendChild(formField('Description', textarea('description', item ? item.description : '', { rows: 2 }), { full: true }));
    form.appendChild(formField('By-Law reference', input('bylaw_ref', { value: item ? item.bylaw_ref : '', placeholder: 'e.g. Section 4.4 (h)' })));
    form.appendChild(formField('Sort order', input('sort_order', { type: 'number', value: item ? item.sort_order : 99 })));
    form.appendChild(formField('Notes', textarea('notes', item ? item.notes : '', { rows: 3, placeholder: 'Your progress notes, file locations, etc.' }), { full: true }));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column: 1/-1; margin-top: 8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, item ? 'Save' : 'Add step'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel'),
    ));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      var d = readForm(form);
      var payload = {
        step_name: d.step_name,
        description: d.description,
        bylaw_ref: d.bylaw_ref,
        sort_order: Number(d.sort_order) || 99,
        status: d.status,
        notes: d.notes,
      };
      try {
        if (item) await API.licensing.update(item.id, payload);
        else await API.licensing.create({ ...payload, property_id: propId });
        toast('Saved', 'success'); closeModal(); refresh(propId);
      } catch (e) {}
    });
    openModal(item ? 'Edit licensing step' : 'New licensing step', form);
  }

  // ---------- MAINTENANCE ----------
  VIEWS.maintenance = async (root) => {
    const props = await API.properties.list();
    if (!props.length) {
      root.appendChild(el('h1', null, 'Maintenance Checklist'));
      root.appendChild(el('div', { class: 'card empty' }, 'Add a property first.'));
      return;
    }
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Maintenance Checklist'),
      (() => {
        const sel = select('prop', props.map(p => ({ value: String(p.id), label: p.nickname })), props[0].id);
        sel.style.width = 'auto';
        sel.addEventListener('change', () => renderProp(Number(sel.value)));
        return sel;
      })(),
    ));
    const wrap = el('div');
    root.appendChild(wrap);
    async function renderProp(propId) {
      const items = await API.maintenance.list(propId);
      wrap.innerHTML = '';
      const card = el('div', { class: 'card' });
      const totalOut = items.filter(i => !i.in_stock).length;
      const summary = el('div', { class: 'between' },
        el('div', null, items.length + ' items tracked • ', el('strong', null, totalOut + ' need restocking')),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn-ghost', onclick: () => addItemForm(propId, renderProp) }, '+ Add item'),
          el('button', { class: 'btn-ghost', onclick: async () => {
            if (!confirm('Mark all items as in stock?')) return;
            for (const it of items.filter(i => !i.in_stock)) {
              await API.maintenance.update(it.id, { item_name: it.item_name, category: it.category, in_stock: 1, notes: it.notes });
            }
            renderProp(propId);
          }}, 'Mark all in-stock'),
        ),
      );
      card.appendChild(summary);
      const byCat = {};
      items.forEach(i => { (byCat[i.category || 'Other'] = byCat[i.category || 'Other'] || []).push(i); });
      Object.entries(byCat).sort().forEach(([cat, list]) => {
        const sec = el('div', { class: 'checklist-section' });
        sec.appendChild(el('h4', null, cat));
        list.forEach(item => {
          const row = el('div', { class: 'checklist-item' + (item.in_stock ? '' : ' out') });
          const cb = el('input', { type: 'checkbox' });
          cb.checked = !!item.in_stock;
          cb.addEventListener('change', async () => {
            await API.maintenance.update(item.id, { item_name: item.item_name, category: item.category, in_stock: cb.checked ? 1 : 0, notes: item.notes });
            renderProp(propId);
          });
          row.appendChild(cb);
          row.appendChild(el('span', { class: 'name' }, item.item_name));
          if (item.notes) row.appendChild(el('span', { class: 'muted', style: 'font-size: 12px;' }, item.notes));
          row.appendChild(el('div', { class: 'item-actions btn-row' },
            el('button', { class: 'btn-ghost small', onclick: () => addItemForm(propId, renderProp, item) }, 'Edit'),
            el('button', { class: 'btn-danger small', onclick: async () => {
              if (!confirm('Delete this item?')) return;
              await API.maintenance.remove(item.id); renderProp(propId);
            }}, '×'),
          ));
          sec.appendChild(row);
        });
        card.appendChild(sec);
      });
      wrap.appendChild(card);
    }
    renderProp(props[0].id);
  };

  function addItemForm(propId, refresh, item) {
    const form = el('form', { class: 'form-grid' });
    form.appendChild(formField('Item *', input('item_name', { value: item?.item_name, required: true })));
    form.appendChild(formField('Category', input('category', { value: item?.category, placeholder: 'e.g. Kitchen' })));
    form.appendChild(formField('Notes', textarea('notes', item?.notes), { full: true }));
    const cb = el('input', { type: 'checkbox', name: 'in_stock' });
    cb.checked = item ? !!item.in_stock : true;
    form.appendChild(formField('In stock', cb));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column: 1/-1; margin-top: 8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, item ? 'Save' : 'Add'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel'),
    ));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readForm(form);
      const payload = { item_name: d.item_name, category: d.category, in_stock: d.in_stock ? 1 : 0, notes: d.notes };
      try {
        if (item) await API.maintenance.update(item.id, payload);
        else await API.maintenance.create({ ...payload, property_id: propId });
        toast('Saved', 'success'); closeModal(); refresh(propId);
      } catch (e) {}
    });
    openModal(item ? 'Edit item' : 'New item', form);
  }

  // ---------- SMS INBOX ----------
  VIEWS.smsInbox = async (root) => {
    const messages = await API.smsMessages.list();
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'SMS Inbox'),
      el('div', { class: 'muted' }, 'All sent and received text messages. Replies from guests and cleaners appear here.'),
    ));

    if (!messages.length) {
      root.appendChild(el('div', { class: 'card empty' }, 'No messages yet. Send a guest welcome SMS or cleaner notification to get started.'));
      return;
    }

    const unread = messages.filter(m => m.direction === 'inbound' && !m.read);
    if (unread.length) {
      root.appendChild(el('div', { class: 'banner warn' },
        el('span', { class: 'banner-icon' }, '📬'),
        el('span', null, el('strong', null, unread.length + ' unread'), ' inbound message' + (unread.length > 1 ? 's' : '')),
      ));
    }

    const card = el('div', { class: 'card' });
    const list = el('div', { class: 'sms-list' });

    messages.forEach(m => {
      const isIn = m.direction === 'inbound';
      const row = el('div', { class: 'sms-row ' + (isIn ? 'inbound' : 'outbound') + (!m.read && isIn ? ' unread' : '') });

      const icon = el('div', { class: 'sms-icon' }, isIn ? '📩' : '📤');
      const body = el('div', { class: 'sms-body' });

      const who = m.guest_name || m.cleaner_name || (isIn ? m.from_number : m.to_number);
      const role = m.guest_name ? 'Guest' : m.cleaner_name ? 'Cleaner' : '';
      const timestamp = m.sent_at || m.received_at || '';

      body.appendChild(el('div', { class: 'sms-header' },
        el('strong', null, who),
        role ? el('span', { class: 'badge', style: 'margin-left:6px;' }, role) : null,
        el('span', { class: 'muted', style: 'margin-left:auto; font-size:12px;' }, fmtDate(timestamp)),
      ));
      body.appendChild(el('div', { class: 'sms-text' }, m.body || '(empty)'));

      if (isIn && !m.read) {
        const markBtn = el('button', { class: 'btn-ghost small', onclick: async () => {
          await API.smsMessages.markRead(m.id);
          row.classList.remove('unread');
          markBtn.remove();
        }}, 'Mark read');
        body.appendChild(markBtn);
      }

      row.appendChild(icon);
      row.appendChild(body);
      list.appendChild(row);
    });

    card.appendChild(list);
    root.appendChild(card);
  };

  // ========================================================
  // PROFIT & AUTOMATION VIEWS (Phases C–H)
  // ========================================================
  const EXPENSE_CATEGORIES = ['Cleaning', 'Supplies', 'Utilities', 'Mortgage/Interest', 'Property Tax', 'Maintenance', 'Repairs', 'Insurance', 'Licensing', 'Internet/Cable', 'Platform Fees', 'Furnishings', 'Marketing', 'Other'];
  let financialsYear = new Date().getFullYear();
  let financialsProp = ''; // '' = all properties

  function simpleTable(headers, rows) {
    const tbl = el('table');
    tbl.appendChild(el('thead', null, el('tr', null, ...headers.map(h => el('th', h.num ? { class: 'num' } : null, h.label || h)))));
    const tb = el('tbody');
    rows.forEach(r => tb.appendChild(el('tr', null, ...r.map((c, i) => el('td', headers[i] && headers[i].num ? { class: 'num' } : null, c)))));
    tbl.appendChild(tb);
    return tbl;
  }
  function downloadCsv(filename, headerArr, rows) {
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = [headerArr.map(esc).join(',')].concat(rows.map(r => r.map(esc).join(','))).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = el('a', { href: url, download: filename }); document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  // ---------- MONEY / FINANCIALS ----------
  VIEWS.financials = async (root) => {
    const [f, props, types] = await Promise.all([API.financials(financialsYear, financialsProp || null), API.properties.list(), API.bookingTypes.list()]);
    const m = f.metrics || {};
    const yearSel = select('fy', (() => { const o = []; const cy = new Date().getFullYear(); for (let y = cy + 1; y >= cy - 4; y--) o.push({ value: String(y), label: String(y) }); return o; })(), String(financialsYear));
    yearSel.style.width = 'auto';
    yearSel.addEventListener('change', () => { financialsYear = Number(yearSel.value); setView('financials'); });
    const propSel = select('fp', [{ value: '', label: 'All properties' }].concat(props.map(p => ({ value: String(p.id), label: p.nickname }))), financialsProp);
    propSel.style.width = 'auto';
    propSel.addEventListener('change', () => { financialsProp = propSel.value; setView('financials'); });
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Money' + (financialsProp ? ' — ' + ((props.find(p => String(p.id) === financialsProp) || {}).nickname || '') : '')),
      el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;' }, el('span', { class: 'muted' }, 'Year'), yearSel,
        el('span', { class: 'muted' }, 'Property'), propSel,
        el('button', { class: 'btn-ghost', onclick: () => exportPnl(f) }, '⬇ Export P&L'))));

    root.appendChild(el('div', { class: 'kpi-grid' },
      kpi('Net Profit', fmtMoney(f.net_profit), `${(f.margin * 100).toFixed(1)}% margin`, f.net_profit >= 0 ? 'success' : 'danger'),
      kpi('Total Revenue', fmtMoney(f.total_revenue), `incl. ${fmtMoney(f.ancillary_revenue)} add-ons`),
      kpi('Platform Fees', fmtMoney(f.platform_fees), 'paid to channels', f.platform_fees > 0 ? 'warn' : null),
      kpi('Expenses', fmtMoney(f.total_expenses), 'tracked costs', f.total_expenses > 0 ? 'warn' : null),
      kpi('Tax Set-Aside', fmtMoney(f.tax_setaside), `${f.tax_setaside_percent}% of net`, 'warn'),
      kpi('Ancillary Revenue', fmtMoney(f.ancillary_revenue), 'upsells / add-ons'),
    ));

    // Net profit by property
    const pcard = el('div', { class: 'card' });
    pcard.appendChild(el('h2', null, 'Net Profit by Property'));
    pcard.appendChild(simpleTable(
      ['Property', { label: 'Revenue', num: true }, { label: 'Fees', num: true }, { label: 'Expenses', num: true }, { label: 'Net Profit', num: true }, { label: 'Margin', num: true }],
      f.by_property.map(p => [p.nickname, fmtMoney(p.revenue), fmtMoney(p.fees), fmtMoney(p.expenses), fmtMoney(p.net_profit), (p.margin * 100).toFixed(0) + '%'])));
    root.appendChild(pcard);

    // By channel (effective rate) + editable fees
    const ccard = el('div', { class: 'card' });
    ccard.appendChild(el('div', { class: 'between' }, el('h2', null, 'By Channel (after fees)'),
      el('button', { class: 'btn-ghost small', onclick: () => editChannelFees(types) }, 'Edit channel fees')));
    ccard.appendChild(simpleTable(
      ['Channel', { label: 'Fee %', num: true }, { label: 'Bookings', num: true }, { label: 'Revenue', num: true }, { label: 'Fees', num: true }, { label: 'Net', num: true }, { label: 'Effective', num: true }],
      f.by_channel.map(c => [c.type + (c.is_direct ? ' ✦' : ''), c.fee_percent + '%', c.bookings, fmtMoney(c.revenue), fmtMoney(c.fees), fmtMoney(c.net), (c.effective_rate * 100).toFixed(0) + '%'])));
    ccard.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px;' }, '✦ = direct booking (no platform fee)'));
    root.appendChild(ccard);

    // Expense categories
    if (f.expense_categories.length) {
      const ecard = el('div', { class: 'card' });
      ecard.appendChild(el('div', { class: 'between' }, el('h2', null, 'Expenses by Category'),
        el('button', { class: 'btn-ghost small', onclick: () => setView('expenses') }, 'Manage expenses →')));
      ecard.appendChild(simpleTable(['Category', { label: 'Amount', num: true }], f.expense_categories.map(c => [c.category, fmtMoney(c.amount)])));
      root.appendChild(ecard);
    } else {
      root.appendChild(el('div', { class: 'card empty' },
        el('div', null, 'No expenses tracked yet — your "net profit" is just revenue minus fees. '),
        el('button', { class: 'btn-primary', style: 'margin-top:8px;', onclick: () => setView('expenses') }, 'Add expenses to see true profit')));
    }

    // P&L by month
    const pnlCard = el('div', { class: 'card' });
    pnlCard.appendChild(el('h2', null, `Monthly P&L — ${f.year}`));
    pnlCard.appendChild(simpleTable(
      ['Month', { label: 'Revenue', num: true }, { label: 'Fees', num: true }, { label: 'Expenses', num: true }, { label: 'Net', num: true }],
      f.pnl_by_month.filter(r => r.revenue || r.expenses).map(r => [r.label, fmtMoney(r.revenue), fmtMoney(r.fees), fmtMoney(r.expenses), fmtMoney(r.net)])));
    root.appendChild(pnlCard);

    // Performance metrics
    const mcard = el('div', { class: 'card' });
    mcard.appendChild(el('h2', null, 'Performance Metrics'));
    mcard.appendChild(el('div', { class: 'kpi-grid' },
      kpi('Direct Booking %', (m.direct_booking_pct * 100).toFixed(0) + '%', 'fee-free bookings'),
      kpi('Repeat Guest %', (m.repeat_guest_rate * 100).toFixed(0) + '%', 'guests who rebooked'),
      kpi('Avg Lead Time', m.avg_lead_time_days + ' days', 'booking → check-in'),
      kpi('Avg Length of Stay', m.avg_length_of_stay + ' nights', ''),
      kpi('Cancellation Rate', (m.cancellation_rate * 100).toFixed(0) + '%', '', m.cancellation_rate > 0.1 ? 'warn' : null),
      kpi('Reviews', m.review_count ? m.avg_rating + '★' : '—', `${m.review_count} reviews`),
      kpi('Cost / Turnover', fmtMoney(m.cost_per_turnover), 'cleaning ÷ stays'),
      kpi('YoY Revenue', m.yoy_revenue_change == null ? '—' : (m.yoy_revenue_change > 0 ? '+' : '') + (m.yoy_revenue_change * 100).toFixed(0) + '%', `vs ${f.year - 1}`, m.yoy_revenue_change >= 0 ? 'success' : 'danger'),
    ));
    root.appendChild(mcard);

    function exportPnl(f) {
      downloadCsv(`pnl-${f.year}.csv`, ['Month', 'Revenue', 'Fees', 'Expenses', 'Net'],
        f.pnl_by_month.map(r => [r.label, r.revenue, r.fees, r.expenses, r.net]));
    }
  };

  function editChannelFees(types) {
    const form = el('form', { class: 'form-grid' });
    const inputs = types.map(t => {
      const fee = input('fee_' + t.id, { type: 'number', step: '0.1', value: t.fee_percent == null ? 0 : t.fee_percent });
      fee.style.width = '70px';
      const fixed = input('fixed_' + t.id, { type: 'number', step: '0.01', value: t.fee_fixed == null ? 0 : t.fee_fixed });
      fixed.style.width = '80px';
      const direct = el('input', { type: 'checkbox', name: 'direct_' + t.id, style: 'width:auto;' }); direct.checked = !!t.is_direct;
      form.appendChild(el('div', { style: 'grid-column:1/-1;display:flex;gap:8px;align-items:center;flex-wrap:wrap;' },
        el('strong', { style: 'width:120px;' }, t.name),
        el('span', { class: 'muted' }, '%'), fee,
        el('span', { class: 'muted' }, '+ $/booking'), fixed,
        el('label', { style: 'display:flex;gap:4px;align-items:center;' }, direct, 'direct')));
      return { t, fee, fixed, direct };
    });
    form.appendChild(el('div', { class: 'muted', style: 'grid-column:1/-1;font-size:12px;' },
      'Use % for commission channels (Airbnb, VRBO) and "$/booking" for flat per-booking fees. A flat annual listing fee (e.g. Cottages Canada) is best tracked as an Expense instead.'));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, 'Save fees'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      for (const { t, fee, fixed, direct } of inputs) await API.bookingTypeUpdate(t.id, { fee_percent: Number(fee.value) || 0, fee_fixed: Number(fixed.value) || 0, is_direct: direct.checked ? 1 : 0 });
      toast('Channel fees saved', 'success'); closeModal(); setView('financials');
    });
    openModal('Channel fees', form);
  }

  // ---------- ANNUAL ROI / CASH-ON-CASH P&L ----------
  let roiYear = new Date().getFullYear();
  VIEWS.roi = async (root) => {
    const data = await API.roi.get(roiYear);
    const yearSel = select('ry', (() => { const o = []; const cy = new Date().getFullYear(); for (let y = cy + 1; y >= cy - 3; y--) o.push({ value: String(y), label: String(y) }); return o; })(), String(roiYear));
    yearSel.style.width = 'auto';
    yearSel.addEventListener('change', () => { roiYear = Number(yearSel.value); setView('roi'); });
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, `Annual ROI — ${data.year}`),
      el('div', { style: 'display:flex;gap:8px;align-items:center;' }, el('span', { class: 'muted' }, 'Year'), yearSel)));
    root.appendChild(el('div', { class: 'muted', style: 'margin:-8px 0 16px;font-size:13px;' },
      'One P&L per building (Retreat + Hideaway share 4488 East Road). STR revenue and tracked expenses flow in automatically from bookings; enter the annual costs below and Save to update the return numbers.'));

    root.appendChild(el('div', { class: 'kpi-grid' },
      kpi('Cash flow (booked)', fmtMoney(data.totals.cash_flow), 'all buildings, income on the books', data.totals.cash_flow >= 0 ? 'success' : 'danger'),
      kpi('Trending cash flow', fmtMoney(data.totals.trending_cash_flow), 'if season gaps fill + off-season forecast', data.totals.trending_cash_flow >= 0 ? 'success' : 'danger'),
      kpi('Your share (booked / trending)', fmtMoney(data.totals.your_cash_flow) + ' / ' + fmtMoney(data.totals.your_trending_cash_flow), 'after ownership splits', data.totals.your_trending_cash_flow >= 0 ? 'success' : 'danger'),
      kpi('Portfolio NOI', fmtMoney(data.totals.noi), 'before mortgage interest'),
      kpi('Total income', fmtMoney(data.totals.total_income), 'STR net + other income'),
    ));

    for (const b of data.buildings) root.appendChild(roiBuildingCard(b, data));
  };

  function roiBuildingCard(b, data) {
    const c = b.computed, inp = b.inputs || {};
    const t = c.trending || {};
    const card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'between' },
      el('div', null, el('h2', { style: 'margin-bottom:2px;' }, b.name), el('div', { class: 'muted', style: 'font-size:12px;' }, b.sub + (c.ownership_pct !== 100 ? ` • you own ${c.ownership_pct}%` : '') + (c.ownership_period && c.ownership_period.fraction < 1 ? ` • owned ${fmtDate(c.ownership_period.from)} → ${fmtDate(c.ownership_period.to)} (${Math.round(c.ownership_period.fraction * 100)}% of year — costs prorated)` : ''))),
      el('div', { class: 'kpi-mini-row' },
        roiMini('Cash flow (booked)', fmtMoney(c.cash_flow), c.cash_flow >= 0 ? 'success' : 'danger'),
        roiMini('Trending', fmtMoney(t.cash_flow), t.cash_flow >= 0 ? 'success' : 'danger'),
        roiMini('Cash-on-cash (trend)', t.cash_on_cash == null ? '—' : (t.cash_on_cash * 100).toFixed(1) + '%', t.cash_on_cash == null ? null : t.cash_on_cash >= 0.08 ? 'success' : 'warn'),
        roiMini('Cap rate', c.cap_rate == null ? '—' : (c.cap_rate * 100).toFixed(1) + '%', null),
        c.ownership_pct !== 100 ? roiMini('Your share (trend)', fmtMoney(c.your_trending_cash_flow), c.your_trending_cash_flow >= 0 ? 'success' : 'danger') : null)));
    if (inp.notes) card.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 10px;font-style:italic;' }, '📝 ' + inp.notes));

    const grid = el('div', { class: 'roi-grid' });
    const money = v => fmtMoney(v);
    const roLine = (label, val, cls) => el('div', { class: 'stat-line ' + (cls || '') }, el('span', null, label), el('strong', null, money(val)));

    // Left: P&L (computed income + editable expense lines)
    const pnl = el('div', { class: 'roi-pnl' });
    pnl.appendChild(el('h3', null, `Income — STR net of ${money(c.platform_fees)} platform fees`));
    // Seasonal segments
    pnl.appendChild(roLine(c.segments.pre.label, c.segments.pre.revenue));
    pnl.appendChild(roLine(c.segments.season.label, c.segments.season.revenue));
    pnl.appendChild(roLine(c.segments.post.label, c.segments.post.revenue));
    // Per-property split (4488 = Retreat + Hideaway)
    if (c.by_property.length > 1) {
      pnl.appendChild(el('div', { class: 'muted', style: 'font-size:12px;padding:2px 0 4px;' },
        'By property: ' + c.by_property.map(p => `${p.nickname} ${money(p.total)}`).join(' • ')));
    }
    // Expandable monthly breakdown
    const monthlyWrap = el('div', { class: 'roi-monthly hidden' });
    const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mtbl = el('table', { class: 'roi-monthly-table' });
    mtbl.appendChild(el('thead', null, el('tr', null,
      el('th', null, 'Month'),
      ...c.by_property.map(p => el('th', { class: 'num' }, p.nickname)),
      c.by_property.length > 1 ? el('th', { class: 'num' }, 'Total') : null)));
    const mtb = el('tbody');
    mNames.forEach((mn, i) => {
      if (!c.monthly_total[i] && !c.by_property.some(p => p.monthly[i])) return; // skip $0 months
      mtb.appendChild(el('tr', null,
        el('td', null, mn),
        ...c.by_property.map(p => el('td', { class: 'num' }, money(p.monthly[i]))),
        c.by_property.length > 1 ? el('td', { class: 'num' }, el('strong', null, money(c.monthly_total[i]))) : null));
    });
    mtb.appendChild(el('tr', null,
      el('td', null, el('strong', null, 'Year')),
      ...c.by_property.map(p => el('td', { class: 'num' }, el('strong', null, money(p.total)))),
      c.by_property.length > 1 ? el('td', { class: 'num' }, el('strong', null, money(c.str_net))) : null));
    mtbl.appendChild(mtb);
    monthlyWrap.appendChild(mtbl);
    const expandBtn = el('button', { class: 'btn-ghost small', type: 'button', style: 'margin:4px 0;' }, '▸ Monthly breakdown');
    expandBtn.addEventListener('click', () => {
      const open = monthlyWrap.classList.toggle('hidden');
      expandBtn.textContent = (open ? '▸' : '▾') + ' Monthly breakdown';
    });
    pnl.appendChild(expandBtn);
    pnl.appendChild(monthlyWrap);

    const otherIncome = roiInput(inp.other_income);
    pnl.appendChild(roiEditLine('Other income' + (inp.other_income_note ? ` — ${inp.other_income_note}` : ''), otherIncome));
    pnl.appendChild(roLine('Total income (booked)', c.total_income, 'roi-total'));

    // Forecast lines → trending. Each off-season month is editable individually
    // (e.g. long-term tenant rent Jan–May); trending uses max(booked, forecast) per month.
    pnl.appendChild(el('h3', { style: 'margin-top:12px;' }, 'Forecast (feeds the trending number)'));
    const fc = c.forecast || { pre_months: [], post_months: [] };
    if (fc.legacy_mode) {
      pnl.appendChild(el('div', { class: 'muted', style: 'font-size:12px;padding:2px 0;' },
        'Currently using your old single pre/post-season figures — enter monthly amounts below and Save to switch to per-month forecasting.'));
    }
    const fcInputs = {};
    const fcMonthRow = (title, months, total) => {
      const row = el('div', { class: 'roi-fc-months' });
      months.forEach(r => {
        const i = el('input', { type: 'number', step: '0.01', value: r.forecast ? String(r.forecast) : '', placeholder: r.actual ? String(Math.round(r.actual)) : '0', title: r.label + (r.actual ? ` — ${fmtMoney(r.actual)} already booked; trending uses the higher of booked vs forecast` : ' — nothing booked yet') });
        fcInputs[r.month] = i;
        row.appendChild(el('div', { class: 'roi-fc-month' }, el('span', null, r.label), i));
      });
      return el('div', { class: 'roi-fc-group' },
        el('div', { class: 'stat-line' }, el('span', null, title), el('strong', null, fmtMoney(total || 0))),
        row);
    };
    pnl.appendChild(fcMonthRow('Before season — monthly (LTR rent, winter stays…)', fc.pre_months, fc.pre_total));
    pnl.appendChild(fcMonthRow('After season — monthly (Oct–Dec)', fc.post_months, fc.post_total));
    pnl.appendChild(roLine('Remaining season potential (3+ night gaps)', c.potential_remaining_season));
    pnl.appendChild(roLine('Trending income (gaps fill + forecasts land)', t.income, 'roi-total'));

    pnl.appendChild(el('h3', { style: 'margin-top:12px;' }, 'Operating expenses' + (c.ownership_period && c.ownership_period.fraction < 1 ? ` (annual inputs × ${Math.round(c.ownership_period.fraction * 100)}% owned)` : '')));
    const itemInputs = {};
    for (const it of data.expense_items) {
      itemInputs[it.key] = roiInput(inp[it.key]);
      const shown = c.ownership_period && c.ownership_period.fraction < 1 && Number(inp[it.key])
        ? `${it.label} (→ ${money((Number(inp[it.key]) || 0) * c.ownership_period.fraction)})` : it.label;
      pnl.appendChild(roiEditLine(shown, itemInputs[it.key]));
    }
    pnl.appendChild(roLine('STR costs tracked in app (cleaning, supplies…)', c.tracked_costs));
    pnl.appendChild(roLine('NOI (booked income − operating costs)', c.noi, 'roi-total'));
    pnl.appendChild(roLine(`Mortgage interest (${c.interest_source})`, -c.mortgage_interest));
    pnl.appendChild(roLine('Cash flow (booked)', c.cash_flow, 'roi-grand ' + (c.cash_flow >= 0 ? 'pos' : 'neg')));
    pnl.appendChild(roLine('Cash flow (trending)', t.cash_flow, 'roi-grand ' + (t.cash_flow >= 0 ? 'pos' : 'neg')));
    grid.appendChild(pnl);

    // Right: financing & return inputs
    const fin = el('div', { class: 'roi-fin' });
    fin.appendChild(el('h3', null, 'Financing & return basis'));
    const value = roiInput(inp.property_value), debt = roiInput(inp.debt_balance);
    const rate = roiInput(inp.mortgage_rate_pct, '0.01'), override = roiInput(inp.mortgage_interest_override);
    const cash = roiInput(inp.cash_invested), own = roiInput(inp.ownership_pct, '1');
    fin.appendChild(roiEditLine('Property value ($)', value));
    fin.appendChild(roiEditLine('Mortgage balance ($)', debt));
    fin.appendChild(roiEditLine('Mortgage interest rate (%)', rate));
    fin.appendChild(roiEditLine('Actual interest paid ($, overrides rate calc)', override));
    fin.appendChild(roiEditLine('Cash invested ($, blank = use equity)', cash));
    fin.appendChild(roiEditLine('Your ownership (%)', own));
    fin.appendChild(el('h3', { style: 'margin-top:12px;' }, 'Ownership period (prorates annual costs)'));
    const ownedFrom = el('input', { type: 'date', value: inp.owned_from || '' });
    const ownedTo = el('input', { type: 'date', value: inp.owned_to || '' });
    ownedFrom.style.width = '150px'; ownedTo.style.width = '150px';
    fin.appendChild(roiEditLine('Owned from (blank = Jan 1)', ownedFrom));
    fin.appendChild(roiEditLine('Owned until (blank = Dec 31)', ownedTo));
    fin.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px;' },
      `Equity ${money(c.equity)} • return basis: ${c.cash_basis}. Cash flow is NOI minus interest only — principal paydown builds equity on top. Trending assumes the remaining 3+ night season blocks fill and off-season forecasts land (uses whichever is higher: booked or forecast).`));
    const saveBtn = el('button', { class: 'btn-primary', style: 'margin-top:12px;' }, 'Save ' + b.name);
    saveBtn.addEventListener('click', async () => {
      const forecast_monthly = {};
      for (const m of Object.keys(fcInputs)) forecast_monthly[m] = Number(fcInputs[m].value) || 0;
      const payload = {
        other_income: Number(otherIncome.value) || 0,
        forecast_monthly,
        property_value: Number(value.value) || 0,
        debt_balance: Number(debt.value) || 0,
        mortgage_rate_pct: Number(rate.value) || 0,
        mortgage_interest_override: Number(override.value) || 0,
        cash_invested: Number(cash.value) || 0,
        ownership_pct: Number(own.value) || 0,
        owned_from: ownedFrom.value || null,
        owned_to: ownedTo.value || null,
      };
      for (const k of Object.keys(itemInputs)) payload[k] = Number(itemInputs[k].value) || 0;
      try {
        await API.roi.save({ year: data.year, buildings: { [b.key]: payload } });
        toast(b.name + ' saved', 'success'); setView('roi');
      } catch (e) {}
    });
    fin.appendChild(saveBtn);
    grid.appendChild(fin);

    card.appendChild(grid);
    return card;
  }
  function roiMini(label, value, mod) {
    return el('div', { class: 'roi-mini ' + (mod || '') }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value));
  }
  function roiInput(val, step) {
    const i = el('input', { type: 'number', step: step || '0.01', value: val == null || val === 0 ? '' : String(val), placeholder: '0' });
    i.style.width = '110px'; i.style.textAlign = 'right';
    return i;
  }
  function roiEditLine(label, inputEl) {
    return el('div', { class: 'stat-line roi-edit' }, el('span', null, label), inputEl);
  }

  // ---------- INSIGHTS ----------
  VIEWS.insights = async (root) => {
    const data = await API.insights();
    root.appendChild(el('div', { class: 'between' },
      el('h1', null, 'Insights'),
      el('span', { class: 'muted' }, 'Generated from live bookings, last year\'s history, pricing, gaps & reviews')));
    const sevMeta = {
      act:   { label: 'Act now', cls: 'insight-act' },
      watch: { label: 'Worth a look', cls: 'insight-watch' },
      good:  { label: 'Working', cls: 'insight-good' },
    };
    if (!data.properties.length) { root.appendChild(el('div', { class: 'card empty' }, 'No properties yet.')); return; }
    for (const p of data.properties) {
      const card = el('div', { class: 'card' });
      const s = p.stats;
      const w14 = s.windows.next_14, w30 = s.windows.next_30, ja = s.july_august;
      card.appendChild(el('div', { class: 'between' },
        el('h2', null, p.nickname),
        el('div', { class: 'muted', style: 'font-size:12px;' }, `${fmtMoney(w30.revenue)} on the books next 30 days`)));
      // KPI strip: the numbers we manage the business by.
      const kpiCell = (label, value, sub, occ) => el('div', { class: 'stat-window' },
        el('div', { class: 'label' }, label),
        el('div', { class: 'value' }, value),
        occ != null ? occBar(occ) : null,
        el('div', { class: 'sub' }, sub));
      card.appendChild(el('div', { class: 'stat-windows', style: 'margin-bottom:8px;' },
        kpiCell('Next 14 days', pct(w14.occupancy), `${w14.occupied_nights}/14 nights booked`, w14.occupancy),
        kpiCell('Next 30 days', pct(w30.occupancy), `${w30.occupied_nights}/30 nights booked`, w30.occupancy),
        kpiCell('Summer · Jul–Aug', pct(ja.occupancy), `${ja.occupied_nights}/${ja.days} nights • LY ${pct(ja.last_year.occupancy)}`, ja.occupancy),
        kpiCell('Revenue / night', s.season.adr_achieved != null ? fmtMoney(s.season.adr_achieved) : '—',
          w30.adr != null ? `next 30d bookings ${fmtMoney(w30.adr)}` : 'no upcoming bookings', null)));
      if (!p.insights.length) {
        card.appendChild(el('div', { class: 'empty' }, 'Nothing urgent — this property looks healthy.'));
      } else {
        const order = { act: 0, watch: 1, good: 2 };
        p.insights.sort((a, b) => (order[a.severity] || 1) - (order[b.severity] || 1));
        for (const t of p.insights) {
          const meta = sevMeta[t.severity] || sevMeta.watch;
          card.appendChild(el('div', { class: 'insight ' + meta.cls },
            el('div', { class: 'insight-head' },
              el('span', { class: 'insight-badge' }, meta.label),
              el('strong', null, t.title)),
            el('div', { class: 'insight-detail' }, t.detail)));
        }
      }
      root.appendChild(card);
    }

    // Building-level P&L insights (annual ROI / cash-on-cash)
    if (data.buildings && data.buildings.length) {
      root.appendChild(el('div', { class: 'between', style: 'margin-top:24px;' },
        el('h1', { style: 'font-size:20px;' }, `Building P&L — ${data.roi_year}`),
        el('button', { class: 'btn-ghost small', onclick: () => setView('roi') }, 'Open Annual ROI tab →')));
      for (const b of data.buildings) {
        const card = el('div', { class: 'card' });
        const c = b.computed;
        card.appendChild(el('div', { class: 'between' },
          el('h2', null, `${b.name} (${b.sub})`),
          el('div', { class: 'muted', style: 'font-size:12px;' },
            `income ${fmtMoney(c.total_income)} • NOI ${fmtMoney(c.noi)} • cash flow ${fmtMoney(c.cash_flow)}${c.trending ? ' • trending ' + fmtMoney(c.trending.cash_flow) : ''}${c.cash_on_cash != null ? ' • CoC ' + (c.cash_on_cash * 100).toFixed(1) + '%' : ''}`)));
        if (!b.insights.length) card.appendChild(el('div', { class: 'empty' }, 'P&L looks healthy.'));
        else {
          const order = { act: 0, watch: 1, good: 2 };
          b.insights.sort((x, y) => (order[x.severity] || 1) - (order[y.severity] || 1));
          for (const t of b.insights) {
            const meta = sevMeta[t.severity] || sevMeta.watch;
            card.appendChild(el('div', { class: 'insight ' + meta.cls },
              el('div', { class: 'insight-head' }, el('span', { class: 'insight-badge' }, meta.label), el('strong', null, t.title)),
              el('div', { class: 'insight-detail' }, t.detail)));
          }
        }
        root.appendChild(card);
      }
    }
  };

  // ---------- EXPENSES ----------
  VIEWS.expenses = async (root) => {
    const [expenses, props] = await Promise.all([API.expenses.list(), API.properties.list()]);
    root.appendChild(el('div', { class: 'between' }, el('h1', null, 'Expenses'),
      el('button', { class: 'btn-primary', onclick: () => expenseForm(null, props) }, '+ Add expense')));
    const total = expenses.reduce((a, e) => a + (e.amount || 0), 0);
    root.appendChild(el('div', { class: 'kpi-grid' },
      kpi('Total Expenses', fmtMoney(total), `${expenses.length} entries`, total > 0 ? 'warn' : null)));
    const card = el('div', { class: 'card' });
    if (!expenses.length) card.appendChild(el('div', { class: 'empty' }, 'No expenses yet. Track cleaning, supplies, utilities, fees, etc. to see true net profit on the Money tab.'));
    else {
      const tbl = el('table');
      tbl.appendChild(el('thead', null, el('tr', null, el('th', null, 'Date'), el('th', null, 'Category'), el('th', null, 'Property'), el('th', null, 'Vendor'), el('th', { class: 'num' }, 'Amount'), el('th', null, ''))));
      const tb = el('tbody');
      expenses.forEach(e => tb.appendChild(el('tr', null,
        el('td', null, fmtDate(e.date)), el('td', null, e.category || ''), el('td', null, e.property_name || '—'),
        el('td', null, e.vendor || ''), el('td', { class: 'num' }, fmtMoney(e.amount)),
        el('td', null, el('div', { class: 'btn-row' },
          el('button', { class: 'btn-ghost', onclick: () => expenseForm(e, props) }, 'Edit'),
          el('button', { class: 'btn-danger', onclick: async () => { if (confirm('Delete expense?')) { await API.expenses.remove(e.id); setView('expenses'); } } }, 'Delete'))))));
      tbl.appendChild(tb); card.appendChild(tbl);
    }
    root.appendChild(card);
  };
  function expenseForm(e, props) {
    const form = el('form', { class: 'form-grid' });
    form.appendChild(formField('Amount *', input('amount', { type: 'number', step: '0.01', value: e?.amount, required: true })));
    form.appendChild(formField('Date', input('date', { type: 'date', value: e?.date || isoToday() })));
    form.appendChild(formField('Category', select('category', EXPENSE_CATEGORIES.map(c => ({ value: c, label: c })), e?.category || 'Cleaning')));
    form.appendChild(formField('Property', select('property_id', [{ value: '', label: '— all / general —' }].concat(props.map(p => ({ value: String(p.id), label: p.nickname }))), e?.property_id || '')));
    form.appendChild(formField('Vendor', input('vendor', { value: e?.vendor })));
    form.appendChild(formField('Notes', textarea('notes', e?.notes), { full: true }));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, e ? 'Save' : 'Add expense'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel')));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault(); const d = readForm(form);
      const payload = { amount: Number(d.amount) || 0, date: d.date, category: d.category, property_id: d.property_id || null, vendor: d.vendor, notes: d.notes };
      try { if (e) await API.expenses.update(e.id, payload); else await API.expenses.create(payload); toast('Saved', 'success'); closeModal(); setView('expenses'); } catch (err) {}
    });
    openModal(e ? 'Edit expense' : 'Add expense', form);
  }

  // ---------- UPSELL CATALOG ----------
  VIEWS.upsellCatalog = async (root) => {
    const upsells = await API.upsells.list();
    root.appendChild(el('div', { class: 'between' }, el('h1', null, 'Upsell Catalog'),
      el('button', { class: 'btn-primary', onclick: () => upsellForm(null) }, '+ Add upsell')));
    root.appendChild(el('div', { class: 'muted', style: 'margin-bottom:12px;' }, 'Add-ons you can attach to bookings (firewood, early check-in, pet fee…). These power your ancillary-revenue metric.'));
    const card = el('div', { class: 'card' });
    const tbl = el('table');
    tbl.appendChild(el('thead', null, el('tr', null, el('th', null, 'Upsell'), el('th', { class: 'num' }, 'Default price'), el('th', null, 'Active'), el('th', null, ''))));
    const tb = el('tbody');
    upsells.forEach(u => tb.appendChild(el('tr', null,
      el('td', null, u.name), el('td', { class: 'num' }, fmtMoney(u.default_price)), el('td', null, u.active ? 'Yes' : 'No'),
      el('td', null, el('div', { class: 'btn-row' },
        el('button', { class: 'btn-ghost', onclick: () => upsellForm(u) }, 'Edit'),
        el('button', { class: 'btn-danger', onclick: async () => { if (confirm('Delete upsell?')) { await API.upsells.remove(u.id); setView('upsellCatalog'); } } }, 'Delete'))))));
    tbl.appendChild(tb); card.appendChild(tbl); root.appendChild(card);
  };
  function upsellForm(u) {
    const form = el('form', { class: 'form-grid' });
    form.appendChild(formField('Name *', input('name', { value: u?.name, required: true })));
    form.appendChild(formField('Default price', input('default_price', { type: 'number', step: '0.01', value: u?.default_price })));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, 'Save'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel')));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault(); const d = readForm(form);
      try { if (u) await API.upsells.update(u.id, { name: d.name, default_price: Number(d.default_price) || 0 }); else await API.upsells.create({ name: d.name, default_price: Number(d.default_price) || 0 }); toast('Saved', 'success'); closeModal(); setView('upsellCatalog'); } catch (err) {}
    });
    openModal(u ? 'Edit upsell' : 'Add upsell', form);
  }

  // ---------- REVIEWS ----------
  VIEWS.reviews = async (root) => {
    const [reviews, props] = await Promise.all([API.reviews.list(), API.properties.list()]);
    root.appendChild(el('div', { class: 'between' }, el('h1', null, 'Reviews'),
      el('button', { class: 'btn-primary', onclick: () => reviewForm(null, props) }, '+ Add review')));
    const avg = reviews.length ? (reviews.reduce((a, r) => a + (Number(r.rating) || 0), 0) / reviews.length).toFixed(2) : '—';
    root.appendChild(el('div', { class: 'kpi-grid' }, kpi('Average Rating', avg + (reviews.length ? '★' : ''), `${reviews.length} reviews`, 'success')));
    const card = el('div', { class: 'card' });
    if (!reviews.length) card.appendChild(el('div', { class: 'empty' }, 'No reviews logged yet.'));
    else {
      const tbl = el('table');
      tbl.appendChild(el('thead', null, el('tr', null, el('th', null, 'Date'), el('th', null, 'Property'), el('th', null, 'Platform'), el('th', { class: 'num' }, 'Rating'), el('th', null, 'Review'), el('th', null, ''))));
      const tb = el('tbody');
      reviews.forEach(r => tb.appendChild(el('tr', null,
        el('td', null, fmtDate(r.review_date)), el('td', null, r.property_name || '—'), el('td', null, r.platform || ''),
        el('td', { class: 'num' }, (r.rating || 0) + '★'), el('td', null, (r.text || '').slice(0, 80)),
        el('td', null, el('button', { class: 'btn-danger', onclick: async () => { if (confirm('Delete review?')) { await API.reviews.remove(r.id); setView('reviews'); } } }, 'Delete')))));
      tbl.appendChild(tb); card.appendChild(tbl);
    }
    root.appendChild(card);
  };
  function reviewForm(r, props) {
    const form = el('form', { class: 'form-grid' });
    form.appendChild(formField('Property', select('property_id', [{ value: '', label: '—' }].concat(props.map(p => ({ value: String(p.id), label: p.nickname }))), r?.property_id || '')));
    form.appendChild(formField('Platform', select('platform', ['Airbnb', 'VRBO', 'Cottages Canada', 'Google', 'Direct'].map(p => ({ value: p, label: p })), r?.platform || 'Airbnb')));
    form.appendChild(formField('Rating (1–5)', input('rating', { type: 'number', step: '0.1', value: r?.rating || 5 })));
    form.appendChild(formField('Date', input('review_date', { type: 'date', value: r?.review_date || isoToday() })));
    form.appendChild(formField('Review text', textarea('text', r?.text), { full: true }));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, 'Save'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel')));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault(); const d = readForm(form);
      try { await API.reviews.create({ property_id: d.property_id || null, platform: d.platform, rating: Number(d.rating) || 0, review_date: d.review_date, text: d.text }); toast('Saved', 'success'); closeModal(); setView('reviews'); } catch (err) {}
    });
    openModal('Add review', form);
  }

  // ---------- PRICING (PriceLabs) ----------
  VIEWS.pricing = async (root) => {
    const [data, props, listings] = await Promise.all([API.pricing(), API.properties.list(), API.pricelabs.listings().catch(() => [])]);
    root.appendChild(el('div', { class: 'between' }, el('h1', null, 'Pricing — PriceLabs'),
      el('button', { class: 'btn-primary', onclick: async (e) => { e.target.textContent = 'Refreshing…'; e.target.disabled = true; try { const r = await API.pricelabs.refresh(); toast('Pulled rates for ' + r.filter(x => !x.error).length + ' properties', 'success'); } catch (err) {} setView('pricing'); } }, '⟳ Refresh rates')));
    if (data.listings_error) root.appendChild(el('div', { class: 'card', style: 'border-color:#fecaca;background:#fef2f2;' }, 'PriceLabs error: ' + data.listings_error));

    data.properties.forEach(p => {
      const card = el('div', { class: 'card' });
      const listingOpts = [{ value: '', label: '— not linked —' }].concat(listings.map(l => ({ value: l.id + '|' + l.pms, label: l.name + ' (' + l.pms + ')' })));
      const sel = select('pl_' + p.property_id, listingOpts, p.pricelabs_listing_id ? (p.pricelabs_listing_id + '|' + p.pricelabs_pms) : '');
      sel.style.width = 'auto';
      sel.addEventListener('change', async () => {
        const [id, pms] = sel.value ? sel.value.split('|') : ['', ''];
        await API.properties.update(p.property_id, { ...(props.find(x => x.id === p.property_id)), pricelabs_listing_id: id, pricelabs_pms: pms });
        toast('Linked — click Refresh rates', 'success');
      });
      card.appendChild(el('div', { class: 'between' }, el('h2', null, p.nickname),
        el('div', { style: 'display:flex;gap:8px;align-items:center;' }, el('span', { class: 'muted', style: 'font-size:12px;' }, 'PriceLabs listing'), sel)));
      if (p.summary) {
        const s = p.summary;
        card.appendChild(el('div', { class: 'kpi-grid' },
          kpi('Recommended base', s.recommended_base_price && s.recommended_base_price !== 'Unavailable' ? fmtMoney(s.recommended_base_price) : '—', `range ${fmtMoney(s.min)}–${fmtMoney(s.max)}`, 'success'),
          kpi('Occupancy 30d', s.occupancy_next_30 || '—', `market ${s.market_occupancy_next_30 || '—'}`),
          kpi('Occupancy 60d', s.occupancy_next_60 || '—', `market ${s.market_occupancy_next_60 || '—'}`),
        ));
      }
      if (p.prices && p.prices.length) {
        card.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin:8px 0 4px;' }, 'Next 14 nights (PriceLabs recommended):'));
        const next = p.prices.filter(x => x.date >= isoToday()).slice(0, 14);
        card.appendChild(simpleTable(['Date', { label: 'Recommended', num: true }, { label: 'Current', num: true }, { label: 'Min stay', num: true }, 'Demand'],
          next.map(d => [fmtDate(d.date), fmtMoney(d.recommended_price), fmtMoney(d.user_price), (d.min_stay || '') + (d.min_stay ? 'n' : ''), d.demand || ''])));
      } else if (p.pricelabs_listing_id) {
        card.appendChild(el('div', { class: 'muted' }, 'No cached rates yet — click "Refresh rates".'));
      } else {
        card.appendChild(el('div', { class: 'muted' }, 'Link this property to a PriceLabs listing above to pull recommended nightly rates.'));
      }
      root.appendChild(card);
    });
  };

  // ---------- GUEST MESSAGING ----------
  VIEWS.messaging = async (root) => {
    const [templates, scheduled, settings] = await Promise.all([API.messageTemplates.list(), API.messagesScheduled(), API.settings.get()]);
    const autosend = !!settings.messaging_autosend_enabled;
    root.appendChild(el('h1', null, 'Guest Messaging'));

    // Autosend toggle
    const toggleCard = el('div', { class: 'card', style: autosend ? '' : 'border-color:#fde68a;background:#fffbeb;' });
    const cb = el('input', { type: 'checkbox', style: 'width:auto;' }); cb.checked = autosend;
    cb.addEventListener('change', async () => { await API.settings.update({ messaging_autosend_enabled: cb.checked }); toast(cb.checked ? 'Auto-send ON' : 'Auto-send OFF', 'success'); setView('messaging'); });
    toggleCard.appendChild(el('label', { style: 'display:flex;gap:10px;align-items:center;cursor:pointer;' }, cb,
      el('div', null, el('strong', null, 'Automatic sending'),
        el('div', { class: 'muted', style: 'font-size:13px;' }, autosend ? 'Messages send automatically via SMS when due.' : 'OFF — nothing sends automatically. Turn on once you\'ve reviewed templates. You can still "Send now" manually below.'))));
    root.appendChild(toggleCard);

    // Templates
    const tcard = el('div', { class: 'card' });
    tcard.appendChild(el('h2', null, 'Message Templates'));
    tcard.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px;' }, 'Tokens: {guest} {property} {checkin} {checkout} {door_code} {address} {checkin_instructions}'));
    templates.forEach(t => {
      const row = el('div', { style: 'border-top:1px solid var(--border);padding:8px 0;' });
      const en = el('input', { type: 'checkbox', style: 'width:auto;' }); en.checked = !!t.enabled;
      en.addEventListener('change', async () => { await API.messageTemplates.update(t.id, { enabled: en.checked ? 1 : 0 }); toast('Updated', 'success'); });
      row.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;' }, en,
        el('strong', null, t.stage.replace(/_/g, ' ')),
        el('span', { class: 'muted', style: 'font-size:12px;' }, t.offset_days === 0 ? 'on the day' : (t.offset_days > 0 ? `${t.offset_days}d after` : `${-t.offset_days}d before`)),
        el('button', { class: 'btn-ghost small', style: 'margin-left:auto;', onclick: () => templateForm(t) }, 'Edit')));
      row.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-top:4px;' }, t.body));
      tcard.appendChild(row);
    });
    root.appendChild(tcard);

    // Scheduled queue (upcoming, unsent)
    const qcard = el('div', { class: 'card' });
    qcard.appendChild(el('h2', null, 'Upcoming & Due Messages'));
    const pending = scheduled.filter(s => !s.sent).slice(0, 40);
    if (!pending.length) qcard.appendChild(el('div', { class: 'empty' }, 'Nothing scheduled.'));
    else pending.forEach(s => {
      const due = s.due;
      const row = el('div', { class: 'todo-item', style: 'align-items:flex-start;' });
      const info = el('div', { style: 'flex:1;' },
        el('div', null, el('strong', null, s.guest_name || '(no guest)'), ' · ', s.stage.replace(/_/g, ' '),
          el('span', { class: due ? 'badge warning' : 'badge', style: 'margin-left:6px;' }, due ? 'DUE ' + fmtDate(s.send_date) : fmtDate(s.send_date))),
        el('div', { class: 'muted', style: 'font-size:12px;' }, (s.property_name || '') + (s.guest_phone ? '' : ' · ⚠ no phone on file') + ' — ' + (s.preview || '').slice(0, 70)));
      const btn = el('button', { class: 'btn-ghost small', onclick: async () => {
        if (!s.guest_phone) { toast('Guest has no phone number', 'error'); return; }
        if (!confirm('Send this ' + s.stage.replace(/_/g, ' ') + ' SMS to ' + s.guest_name + '?')) return;
        btn.textContent = 'Sending…'; btn.disabled = true;
        try { await API.sendMessage({ booking_id: s.booking_id, stage: s.stage }); toast('Sent', 'success'); setView('messaging'); }
        catch (e) { btn.textContent = 'Send now'; btn.disabled = false; }
      } }, 'Send now');
      row.appendChild(info); row.appendChild(btn);
      qcard.appendChild(row);
    });
    root.appendChild(qcard);
  };
  function templateForm(t) {
    const form = el('form', { class: 'form-grid' });
    form.appendChild(formField('Offset days (− before / + after anchor)', input('offset_days', { type: 'number', value: t.offset_days })));
    form.appendChild(formField('Send hour (0–23)', input('send_hour', { type: 'number', value: t.send_hour })));
    form.appendChild(formField('Message body', textarea('body', t.body, { rows: 5 }), { full: true }));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, 'Save template'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel')));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault(); const d = readForm(form);
      try { await API.messageTemplates.update(t.id, { body: d.body, offset_days: Number(d.offset_days) || 0, send_hour: Number(d.send_hour) || 9 }); toast('Saved', 'success'); closeModal(); setView('messaging'); } catch (e) {}
    });
    openModal('Edit ' + t.stage.replace(/_/g, ' ') + ' template', form);
  }

  // ---------- SETTINGS ----------
  VIEWS.settings = async (root) => {
    const s = await API.settings.get();
    root.appendChild(el('h1', null, 'Settings'));
    const form = el('form', { class: 'card form-grid' });
    form.appendChild(formField('Tax set-aside %', input('tax_setaside_percent', { type: 'number', step: '0.5', value: s.tax_setaside_percent == null ? 25 : s.tax_setaside_percent })));
    form.appendChild(formField('STR season start (MM-DD)', input('season_start_md', { value: s.season_start_md || '06-01', placeholder: '06-01' })));
    form.appendChild(formField('STR season end (MM-DD)', input('season_end_md', { value: s.season_end_md || '10-01', placeholder: '10-01' })));
    const autocb = el('input', { type: 'checkbox', name: 'messaging_autosend_enabled', style: 'width:auto;' }); autocb.checked = !!s.messaging_autosend_enabled;
    form.appendChild(el('label', { style: 'grid-column:1/-1;display:flex;gap:8px;align-items:center;' }, autocb, 'Auto-send guest messages (SMS) when due'));
    form.appendChild(el('div', { class: 'muted', style: 'grid-column:1/-1;font-size:12px;' }, 'Tax set-aside is applied to net profit on the Money tab (HST/MAT/income). Channel fees are edited on the Money tab.'));
    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' }, el('button', { class: 'btn-primary', type: 'submit' }, 'Save settings')));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault(); const d = readForm(form);
      await API.settings.update({ tax_setaside_percent: Number(d.tax_setaside_percent) || 0, messaging_autosend_enabled: autocb.checked, season_start_md: d.season_start_md || '06-01', season_end_md: d.season_end_md || '10-01' });
      toast('Settings saved', 'success'); setView('settings');
    });
    root.appendChild(form);

    // Change password (current logged-in user)
    const pwCard = el('form', { class: 'card form-grid' });
    pwCard.appendChild(el('h2', { style: 'grid-column:1/-1;' }, 'Change your password'));
    pwCard.appendChild(el('div', { class: 'muted', style: 'grid-column:1/-1;font-size:13px;' }, 'Signed in as ' + ((Auth.session && Auth.session.email) || '')));
    const np = input('new_password', { type: 'password', placeholder: 'New password (min 6 chars)' });
    const cp = input('confirm_password', { type: 'password', placeholder: 'Confirm new password' });
    pwCard.appendChild(formField('New password', np));
    pwCard.appendChild(formField('Confirm password', cp));
    const pwErr = el('div', { class: 'login-err', style: 'grid-column:1/-1;' });
    pwCard.appendChild(pwErr);
    pwCard.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;' }, el('button', { class: 'btn-primary', type: 'submit' }, 'Update password')));
    pwCard.addEventListener('submit', async (ev) => {
      ev.preventDefault(); pwErr.textContent = '';
      if ((np.value || '').length < 6) { pwErr.textContent = 'Password must be at least 6 characters.'; return; }
      if (np.value !== cp.value) { pwErr.textContent = 'Passwords do not match.'; return; }
      try { await Auth.updatePassword(np.value); toast('Password updated', 'success'); np.value = ''; cp.value = ''; }
      catch (e) { pwErr.textContent = e.message || 'Failed'; }
    });
    root.appendChild(pwCard);
  };

  // ---------- RESERVATIONS NEEDING DETAILS (editable list) ----------
  VIEWS.needsDetails = async (root) => {
    const [events, props, types, guests] = await Promise.all([API.calendar(), API.properties.list(), API.bookingTypes.list(), API.guests.list()]);
    const reserved = events.filter(e => e.kind === 'reserved').sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    root.appendChild(el('div', { class: 'between' }, el('h1', null, 'Reservations Needing Details'),
      el('button', { class: 'btn-ghost', onclick: () => setView('calendar') }, 'Open calendar →')));
    root.appendChild(el('div', { class: 'muted', style: 'margin-bottom:12px;' },
      'Synced Airbnb/VRBO reservations with no amount or guest yet. Fill each in and save — it becomes a tracked booking and drops off this list.'));
    if (!reserved.length) { root.appendChild(el('div', { class: 'card empty' }, '🎉 All caught up — every synced reservation has its details.')); return; }
    const guestOpts = [{ value: '', label: '— new guest below —' }].concat(guests.map(g => ({ value: String(g.id), label: g.name + (g.email ? ` <${g.email}>` : '') })));
    reserved.forEach(ev => {
      const card = el('form', { class: 'card form-grid' });
      card.appendChild(el('div', { class: 'between', style: 'grid-column:1/-1;' },
        el('strong', null, (ev.property_name || 'Property') + ' · ' + (ev.guest_name || 'Reserved')),
        el('span', { class: 'muted', style: 'font-size:13px;' }, (ev.source || '').toUpperCase() + ' · ' + fmtDate(ev.start) + ' → ' + fmtDate(ev.end))));
      const amount = input('amount', { type: 'number', step: '0.01', placeholder: 'e.g. 975.00' });
      const guestSel = select('guest_id', guestOpts, '');
      const newName = input('new_guest_name', { value: ev.guest_name || '', placeholder: 'guest name' });
      card.appendChild(formField('Amount', amount));
      card.appendChild(formField('Existing guest', guestSel));
      card.appendChild(formField('+ New guest', newName));
      card.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;' }, el('button', { class: 'btn-primary', type: 'submit' }, 'Save & confirm')));
      card.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = { amount: Number(amount.value) || 0 };
        if (guestSel.value) payload.guest_id = Number(guestSel.value);
        else if (newName.value) { payload.new_guest = { name: newName.value }; payload.guest_name = newName.value; }
        else if (ev.guest_name) payload.guest_name = ev.guest_name;
        try {
          await API.claimSynced(ev.synced_event_id, payload);
          toast('Saved', 'success'); card.remove();
          if (!root.querySelectorAll('form.card').length) setView('needsDetails');
        } catch (err) {}
      });
      root.appendChild(card);
    });
  };

  // ---------- LONG-TERM RENTAL ----------
  const LTR_STATUS = [{ value: 'applied', label: 'Applied' }, { value: 'screening', label: 'Screening' }, { value: 'approved', label: 'Approved' }, { value: 'secured', label: 'Secured (signed)' }, { value: 'rejected', label: 'Rejected' }];
  VIEWS.ltr = async (root) => {
    const data = await API.ltr.overview();
    const props = data.properties;
    const applyUrl = location.origin + '/apply';
    root.appendChild(el('div', { class: 'between' }, el('h1', null, 'Long-Term Rental'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn-ghost', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(applyUrl); toast('Application link copied', 'success'); } }, '🔗 Copy application link'),
        el('button', { class: 'btn-ghost', onclick: () => window.open('/apply', '_blank') }, 'Preview →'),
        el('button', { class: 'btn-primary', onclick: () => applicantForm(null, props) }, '+ Add applicant'))));
    root.appendChild(el('div', { class: 'muted', style: 'margin-bottom:12px;' }, 'Off-season tenancy (Oct–June). Share the application link on Facebook Marketplace; applications appear below. Click a property to edit its listing.'));

    // At-a-glance status
    const grid = el('div', { class: 'kpi-grid' });
    props.forEach(p => {
      const secured = p.ltr_status === 'secured';
      const statusTxt = secured ? 'Tenant secured' : (p.ltr_listed ? 'Vacant — listed' : 'Not listed');
      const card = el('div', { class: 'kpi', style: 'cursor:pointer;', onclick: () => ltrListingForm(p, data.applicants.filter(a => a.property_id === p.id)) });
      card.appendChild(el('div', { class: 'label' }, p.nickname));
      card.appendChild(el('div', { class: 'value', style: 'font-size:17px;color:' + (secured ? 'var(--danger)' : (p.ltr_listed ? 'var(--success)' : 'var(--muted)')) }, statusTxt));
      card.appendChild(el('div', { class: 'sub' }, (p.ltr_rent ? fmtMoney(p.ltr_rent) + '/mo · ' : '') + p.applicant_count + ' applicant' + (p.applicant_count === 1 ? '' : 's') + (p.secured_tenant_name ? ' · ' + p.secured_tenant_name : '')));
      grid.appendChild(card);
    });
    root.appendChild(grid);

    // Applicants table
    const card = el('div', { class: 'card' });
    card.appendChild(el('h2', null, 'Applicants'));
    if (!data.applicants.length) card.appendChild(el('div', { class: 'empty' }, 'No applicants yet. Share the application link to start receiving them.'));
    else {
      const tbl = el('table');
      tbl.appendChild(el('thead', null, el('tr', null,
        el('th', null, 'Name'), el('th', null, 'Property'), el('th', { class: 'num' }, 'Income'), el('th', { class: 'num' }, 'Credit'), el('th', null, 'Move-in'), el('th', null, 'Status'), el('th', null, ''))));
      const tb = el('tbody');
      data.applicants.forEach(a => tb.appendChild(el('tr', null,
        el('td', null, el('strong', null, a.name || '—'), a.email ? el('div', { class: 'muted', style: 'font-size:11px;' }, a.email) : null),
        el('td', null, a.property_name || '—'),
        el('td', { class: 'num' }, a.annual_income ? fmtMoney(a.annual_income) : '—'),
        el('td', { class: 'num' }, a.credit_score || '—'),
        el('td', null, a.desired_move_in || '—'),
        el('td', null, el('span', { class: 'badge ' + (a.status === 'secured' || a.status === 'approved' ? 'success' : (a.status === 'rejected' ? '' : 'warning')) }, a.status || 'applied')),
        el('td', null, el('div', { class: 'btn-row' },
          el('button', { class: 'btn-ghost small', onclick: () => applicantForm(a, props) }, 'View'),
          el('button', { class: 'btn-danger small', onclick: async () => { if (confirm('Delete applicant?')) { await API.ltrApplicants.remove(a.id); setView('ltr'); } } }, '×'))))));
      tbl.appendChild(tb); card.appendChild(tbl);
    }
    root.appendChild(card);
  };

  function ltrListingForm(p, applicants) {
    const form = el('form', { class: 'form-grid' });
    const listed = el('input', { type: 'checkbox', style: 'width:auto;' }); listed.checked = !!p.ltr_listed;
    form.appendChild(el('label', { style: 'grid-column:1/-1;display:flex;gap:8px;align-items:center;' }, listed, 'Listed for long-term rental (shows on the public application page)'));
    form.appendChild(formField('Status', select('ltr_status', [{ value: 'vacant', label: 'Vacant' }, { value: 'secured', label: 'Tenant secured' }], p.ltr_status || 'vacant')));
    form.appendChild(formField('Monthly rent ($)', input('ltr_rent', { type: 'number', value: p.ltr_rent || '' })));
    form.appendChild(formField('Available from', input('ltr_available_date', { type: 'date', value: p.ltr_available_date })));
    const securedOpts = [{ value: '', label: '— none —' }].concat((applicants || []).map(a => ({ value: String(a.id), label: a.name + (a.credit_score ? ' (credit ' + a.credit_score + ')' : '') })));
    form.appendChild(formField('Secured tenant', select('ltr_secured_applicant_id', securedOpts, p.ltr_secured_applicant_id || '')));
    form.appendChild(formField('Description (for Facebook Marketplace)', textarea('ltr_description', p.ltr_description, { rows: 5, placeholder: 'Beautiful 2-bed cottage on the lake, fully furnished, available October to May…' }), { full: true }));
    form.appendChild(formField('Lease terms / details', textarea('ltr_lease_terms', p.ltr_lease_terms, { rows: 3, placeholder: 'e.g. 8-month lease Oct–May, $X deposit, utilities included, no smoking, pets negotiable' }), { full: true }));

    // Photos
    const photoWrap = el('div', { style: 'grid-column:1/-1;' }, el('strong', null, 'Photos'));
    const list = el('div', { class: 'lic-file-list', style: 'display:flex;gap:8px;flex-wrap:wrap;margin:6px 0;' });
    (p.ltr_photos || []).forEach(ph => {
      const cell = el('div', { style: 'position:relative;' });
      if (ph.url) cell.appendChild(el('img', { src: ph.url, style: 'width:110px;height:82px;object-fit:cover;border-radius:6px;border:1px solid var(--border);' }));
      cell.appendChild(el('button', { class: 'btn-danger small', type: 'button', style: 'position:absolute;top:2px;right:2px;', onclick: async () => { await API.ltr.deletePhoto(p.id, ph.path); ltrListingForm({ ...p, ltr_photos: (p.ltr_photos || []).filter(x => x.path !== ph.path) }, applicants); } }, '×'));
      list.appendChild(cell);
    });
    photoWrap.appendChild(list);
    const fileInput = el('input', { type: 'file', multiple: true, accept: 'image/*', style: 'display:none;' });
    fileInput.addEventListener('change', async () => {
      if (!fileInput.files.length) return;
      const fd = new FormData(); for (const f of fileInput.files) fd.append('files', f);
      try { const updated = await API.ltr.uploadPhotos(p.id, fd); toast('Photos uploaded', 'success'); ltrListingForm(updated, applicants); } catch (e) {}
    });
    photoWrap.appendChild(el('button', { class: 'btn-ghost', type: 'button', onclick: () => fileInput.click() }, '+ Upload photos'));
    photoWrap.appendChild(fileInput);
    form.appendChild(photoWrap);

    form.appendChild(el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;flex-wrap:wrap;' },
      el('button', { class: 'btn-primary', type: 'submit' }, 'Save listing'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: () => copyListing(p) }, '📋 Copy listing text'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(location.origin + '/apply?property=' + p.id); toast('Apply link copied', 'success'); } }, '🔗 Apply link'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); const d = readForm(form);
      try {
        await API.ltr.updateListing(p.id, {
          ltr_listed: listed.checked ? 1 : 0, ltr_status: d.ltr_status, ltr_rent: Number(d.ltr_rent) || 0,
          ltr_available_date: d.ltr_available_date || '', ltr_description: d.ltr_description, ltr_lease_terms: d.ltr_lease_terms,
          ltr_secured_applicant_id: d.ltr_secured_applicant_id || null,
        });
        toast('Listing saved', 'success'); closeModal(); setView('ltr');
      } catch (e) {}
    });
    openModal('Listing — ' + p.nickname, form);
  }
  function copyListing(p) {
    const parts = [p.nickname];
    if (p.ltr_rent) parts.push(fmtMoney(p.ltr_rent) + '/month');
    if (p.ltr_available_date) parts.push('Available from ' + p.ltr_available_date);
    if (p.ltr_description) parts.push('\n' + p.ltr_description);
    if (p.ltr_lease_terms) parts.push('\nTerms: ' + p.ltr_lease_terms);
    parts.push('\nApply here: ' + location.origin + '/apply?property=' + p.id);
    navigator.clipboard && navigator.clipboard.writeText(parts.join('\n'));
    toast('Listing copied — paste into Facebook Marketplace', 'success');
  }
  function applicantForm(a, props) {
    const form = el('form', { class: 'form-grid' });
    const propOpts = [{ value: '', label: '— general / unassigned —' }].concat(props.map(p => ({ value: String(p.id), label: p.nickname })));
    form.appendChild(formField('Property', select('property_id', propOpts, a?.property_id || '')));
    form.appendChild(formField('Status', select('status', LTR_STATUS, a?.status || 'applied')));
    form.appendChild(formField('Name *', input('name', { value: a?.name, required: true })));
    form.appendChild(formField('Email', input('email', { type: 'email', value: a?.email })));
    form.appendChild(formField('Phone', input('phone', { value: a?.phone })));
    form.appendChild(formField('Desired move-in', input('desired_move_in', { type: 'date', value: a?.desired_move_in })));
    form.appendChild(formField('Annual income ($)', input('annual_income', { type: 'number', value: a?.annual_income || '' })));
    form.appendChild(formField('Credit score', input('credit_score', { type: 'number', value: a?.credit_score || '' })));
    form.appendChild(formField('Occupants', input('occupants', { type: 'number', value: a?.occupants || '' })));
    form.appendChild(formField('Pets', input('pets', { value: a?.pets })));
    form.appendChild(formField('Employer', input('employer', { value: a?.employer })));
    form.appendChild(formField('Job title', input('job_title', { value: a?.job_title })));
    form.appendChild(formField('Current address', input('current_address', { value: a?.current_address }), { full: true }));
    form.appendChild(formField('References', textarea('references_info', a?.references_info), { full: true }));
    form.appendChild(formField('Notes', textarea('notes', a?.notes), { full: true }));
    const btns = el('div', { class: 'btn-row', style: 'grid-column:1/-1;margin-top:8px;' },
      el('button', { class: 'btn-primary', type: 'submit' }, a ? 'Save' : 'Add applicant'),
      el('button', { class: 'btn-ghost', type: 'button', onclick: closeModal }, 'Cancel'));
    if (a && a.property_id) {
      btns.appendChild(el('button', { class: 'btn-ghost', type: 'button', style: 'margin-left:auto;', onclick: async () => {
        await API.ltrApplicants.update(a.id, { status: 'secured' });
        await API.ltr.updateListing(a.property_id, { ltr_status: 'secured', ltr_secured_applicant_id: a.id });
        toast('Marked as secured tenant', 'success'); closeModal(); setView('ltr');
      } }, '✓ Set as secured tenant'));
    }
    form.appendChild(btns);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); const d = readForm(form);
      const payload = {
        property_id: d.property_id || null, status: d.status, name: d.name, email: d.email, phone: d.phone,
        desired_move_in: d.desired_move_in, annual_income: Number(d.annual_income) || 0, credit_score: Number(d.credit_score) || 0,
        occupants: Number(d.occupants) || 0, pets: d.pets, employer: d.employer, job_title: d.job_title,
        current_address: d.current_address, references_info: d.references_info, notes: d.notes,
      };
      try { if (a) await API.ltrApplicants.update(a.id, payload); else await API.ltrApplicants.create(payload); toast('Saved', 'success'); closeModal(); setView('ltr'); } catch (e) {}
    });
    openModal(a ? 'Applicant — ' + (a.name || '') : 'Add applicant', form);
  }

  // ---------- ANNUAL FORECAST ----------
  let annualYear = new Date().getFullYear();
  VIEWS.annual = async (root) => {
    const data = await API.annualPrediction.get(annualYear);
    const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const SEASON = [6, 7, 8];
    const manual = {}; data.properties.forEach(p => { manual[p.id] = Object.assign({}, (data.manual || {})[p.id] || {}); });
    const actual = (pid, m) => Number((data.actuals[pid] || {})[m] || 0);
    const potential = (pid, m) => Number(((data.potential || {})[pid] || {})[m] || 0);
    const prob = (pid, m) => { const v = manual[pid]['p' + m]; return v == null || v === '' ? 0 : Math.max(0, Math.min(100, Number(v) || 0)); };
    const manualVal = (pid, m) => { const v = manual[pid][m]; return v == null || v === '' ? 0 : Number(v) || 0; };
    const cellTotal = (pid, m) => SEASON.includes(m) ? (actual(pid, m) + prob(pid, m) / 100 * potential(pid, m)) : manualVal(pid, m);

    const yearOpts = []; const cy = new Date().getFullYear(); for (let y = cy + 1; y >= cy - 2; y--) yearOpts.push({ value: String(y), label: String(y) });
    const yearSel = select('ay', yearOpts, String(annualYear)); yearSel.style.width = 'auto';
    yearSel.addEventListener('change', () => { annualYear = Number(yearSel.value); setView('annual'); });
    const saveBtn = el('button', { class: 'btn-primary', onclick: async () => { await API.annualPrediction.save({ year: annualYear, values: manual }); toast('Forecast saved', 'success'); } }, 'Save forecast');
    root.appendChild(el('div', { class: 'between' }, el('h1', null, 'Annual Forecast'),
      el('div', { style: 'display:flex;gap:8px;align-items:center;' }, el('span', { class: 'muted' }, 'Year'), yearSel, saveBtn)));
    root.appendChild(el('div', { class: 'muted', style: 'margin-bottom:12px;' }, 'Jun–Aug show booked (•) + remaining fillable potential × your fill-probability %. Other months are manual forecasts. Click Save (persists for both of you).'));

    const card = el('div', { class: 'card', style: 'overflow-x:auto;' });
    const tbl = el('table', { class: 'annual-table' });
    tbl.appendChild(el('thead', null, el('tr', null, el('th', null, 'Property'),
      ...ALL.map(m => el('th', { class: 'num' }, LABELS[m - 1] + (SEASON.includes(m) ? ' •' : ''))), el('th', { class: 'num' }, 'Total'))));
    const tb = el('tbody');
    const rowTot = {}, colTot = {}, cellTotEl = {}; let grandTd;
    function recompute() {
      let grand = 0; const sums = {};
      data.properties.forEach(p => {
        let rt = 0;
        ALL.forEach(m => { const v = cellTotal(p.id, m); rt += v; sums[m] = (sums[m] || 0) + v; if (cellTotEl[p.id + '_' + m]) cellTotEl[p.id + '_' + m].textContent = '= ' + fmtMoney(v); });
        rowTot[p.id].textContent = fmtMoney(rt); grand += rt;
      });
      ALL.forEach(m => { colTot[m].textContent = fmtMoney(sums[m] || 0); });
      grandTd.textContent = fmtMoney(grand);
    }
    data.properties.forEach(p => {
      const tr = el('tr', null, el('td', null, el('strong', null, p.nickname)));
      ALL.forEach(m => {
        if (SEASON.includes(m)) {
          const pot = potential(p.id, m);
          const probInp = el('input', { type: 'number', min: '0', max: '100', value: manual[p.id]['p' + m] != null ? manual[p.id]['p' + m] : '', placeholder: '%', style: 'width:46px;text-align:right;' });
          probInp.addEventListener('input', () => { manual[p.id]['p' + m] = probInp.value; recompute(); });
          const tot = el('div', { class: 'annual-cell-total' });
          cellTotEl[p.id + '_' + m] = tot;
          tr.appendChild(el('td', { class: 'num annual-season' },
            el('div', { class: 'annual-actual' }, fmtMoney(actual(p.id, m))),
            el('div', { class: 'muted', style: 'font-size:11px;' }, pot ? '+pot ' + fmtMoney(pot) : 'no open'),
            el('div', { style: 'display:flex;align-items:center;gap:2px;justify-content:flex-end;' }, probInp, el('span', { class: 'muted', style: 'font-size:11px;' }, '%')),
            tot));
        } else {
          const inp = el('input', { type: 'number', step: '1', value: manual[p.id][m] != null ? manual[p.id][m] : '', placeholder: '0', style: 'width:72px;text-align:right;' });
          inp.addEventListener('input', () => { manual[p.id][m] = inp.value; recompute(); });
          tr.appendChild(el('td', { class: 'num' }, inp));
        }
      });
      const rt = el('td', { class: 'num', style: 'font-weight:700;' }); rowTot[p.id] = rt; tr.appendChild(rt);
      tb.appendChild(tr);
    });
    const totRow = el('tr', { style: 'border-top:2px solid var(--border);font-weight:700;' }, el('td', null, 'All properties'));
    ALL.forEach(m => { const td = el('td', { class: 'num' }); colTot[m] = td; totRow.appendChild(td); });
    grandTd = el('td', { class: 'num', style: 'color:var(--success);' }); totRow.appendChild(grandTd);
    tb.appendChild(totRow);
    tbl.appendChild(tb); card.appendChild(tbl); root.appendChild(card);
    recompute();
  };

  // ---------- LOGIN GATE + BOOT ----------
  function showLogin(message) {
    const bar = document.querySelector('.topbar'); if (bar) bar.style.display = 'none';
    let ov = $('#loginOverlay');
    if (!ov) { ov = el('div', { id: 'loginOverlay', class: 'login-overlay' }); document.body.appendChild(ov); }
    ov.innerHTML = '';
    const form = el('form', { class: 'login-card' });
    const email = el('input', { type: 'email', placeholder: 'Email', autocomplete: 'username', required: 'true' });
    const pass = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: 'true' });
    const errBox = el('div', { class: 'login-err' });
    const btn = el('button', { class: 'btn-primary', type: 'submit' }, 'Sign in');
    form.appendChild(el('h1', null, 'Rental Tracker'));
    form.appendChild(el('p', { class: 'muted', style: 'margin:0 0 12px;' }, 'Sign in to your command center'));
    if (message) form.appendChild(el('div', { class: 'login-msg' }, message));
    form.appendChild(email); form.appendChild(pass); form.appendChild(errBox); form.appendChild(btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); errBox.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
      try { await Auth.login(email.value.trim(), pass.value); ov.remove(); await startApp(); }
      catch (err) { errBox.textContent = err.message || 'Login failed'; btn.disabled = false; btn.textContent = 'Sign in'; }
    });
    ov.appendChild(form);
    ov.style.display = 'flex';
    setTimeout(() => email.focus(), 50);
  }

  function ensureLogoutButton() {
    if ($('#logoutBtn')) return;
    const bar = document.querySelector('.topbar'); if (!bar) return;
    bar.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin-left:8px;' },
      el('span', { class: 'muted', id: 'userEmail', style: 'font-size:12px;' }, (Auth.session && Auth.session.email) || ''),
      el('button', { id: 'logoutBtn', class: 'btn-ghost small', onclick: () => { Auth.logout(); location.reload(); } }, 'Log out'),
    ));
  }

  let appStarted = false;
  async function startApp() {
    const bar = document.querySelector('.topbar'); if (bar) bar.style.display = '';
    if (!appStarted) { appStarted = true; ensureLogoutButton(); refreshBadges(); setInterval(refreshBadges, 30000); }
    const ue = $('#userEmail'); if (ue && Auth.session) ue.textContent = Auth.session.email;
    setView('dashboard');
  }

  (async function boot() {
    try { await Auth.loadConfig(); } catch (e) {}
    Auth.restore();
    const token = await Auth.token();
    if (token) await startApp(); else showLogin();
  })();
})();
