// ============ STATE ============
const state = {
  currentSection: 'dashboard',
  properties: [],
  bookings: [],
  guests: [],
  cleaners: [],
  bookingTypes: [],
  todos: [],
  maintenance: [],
  licensing: [],
  syncedEvents: [],
  calendarMonth: new Date().getMonth(),
  calendarYear: new Date().getFullYear(),
  currentToolTab: 'evaluation'
};

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupModal();
  setupMobileMenu();
  setCurrentDate();
  loadSection('dashboard');
});

function setCurrentDate() {
  const el = document.getElementById('currentDate');
  if (el) {
    el.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
}

// ============ NAVIGATION ============
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const section = item.dataset.section;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      document.getElementById('pageTitle').textContent = item.textContent.trim();
      loadSection(section);
      // Close mobile menu
      document.getElementById('sidebar').classList.remove('open');
    });
  });
}

function setupMobileMenu() {
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
}

// ============ API HELPERS ============
async function api(path, options = {}) {
  try {
    const res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    return await res.json();
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

// ============ TOAST ============
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ============ MODAL ============
function setupModal() {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
}

function openModal(title, contentHtml) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = contentHtml;
  document.getElementById('modalOverlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

// ============ SECTION LOADER ============
async function loadSection(section) {
  state.currentSection = section;
  const area = document.getElementById('contentArea');
  area.innerHTML = '<div style="text-align:center;padding:60px;"><div class="loading-spinner"></div></div>';

  switch (section) {
    case 'dashboard': await renderDashboard(); break;
    case 'properties': await renderProperties(); break;
    case 'calendar': await renderCalendar(); break;
    case 'bookings': await renderBookings(); break;
    case 'guests': await renderGuests(); break;
    case 'cleaners': await renderCleaners(); break;
    case 'mailing': await renderMailing(); break;
    case 'tools': await renderTools(); break;
  }
}

// ============ DASHBOARD ============
async function renderDashboard() {
  const area = document.getElementById('contentArea');
  try {
    const stats = await api('/dashboard');
    area.innerHTML = `
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="metric-label">Earnings YTD</div>
          <div class="metric-value">$${stats.totalEarnings.toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
          <div class="metric-sub">${stats.totalBookings} bookings this year</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Occupancy Rate</div>
          <div class="metric-value">${stats.occupancyRate}%</div>
          <div class="metric-sub">${stats.totalBookedNights} of ${stats.totalAvailableNights} nights</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">
            <span class="tooltip-trigger">
              RevPAR
              <span class="tooltip-icon">?</span>
              <span class="tooltip-content">
                <strong>RevPAR (Revenue Per Available Room)</strong><br><br>
                = Total Revenue &divide; Total Available Room Nights<br><br>
                It measures how well you're filling rooms at profitable rates. Calculated as:<br><br>
                <strong>Occupancy Rate &times; Average Daily Rate</strong><br><br>
                A higher RevPAR means you're doing a good job of both keeping occupancy high and commanding strong nightly rates.
              </span>
            </span>
          </div>
          <div class="metric-value">$${stats.revPAR.toFixed(2)}</div>
          <div class="metric-sub">Revenue per available room night</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Avg Nightly Rate</div>
          <div class="metric-value">$${stats.avgNightlyRate.toFixed(2)}</div>
          <div class="metric-sub">${stats.totalProperties} properties tracked</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Total Bookings</div>
          <div class="metric-value">${stats.totalBookings}</div>
          <div class="metric-sub">Year to date</div>
        </div>
      </div>
      <div class="section-header">
        <h3>Recent Bookings</h3>
      </div>
      <div class="table-wrapper" id="recentBookingsTable"></div>
    `;

    // Load recent bookings
    const bookings = await api('/bookings');
    const recent = bookings.slice(0, 10);
    const table = document.getElementById('recentBookingsTable');
    if (recent.length === 0) {
      table.innerHTML = '<div class="empty-state"><p>No bookings yet. Add your first booking to see data here.</p></div>';
    } else {
      table.innerHTML = `
        <table class="data-table">
          <thead><tr><th>Property</th><th>Guest</th><th>Check In</th><th>Check Out</th><th>Amount</th></tr></thead>
          <tbody>
            ${recent.map(b => `<tr>
              <td>${b.rental_properties?.nickname || '-'}</td>
              <td>${b.contact_name || b.rental_guests?.name || '-'}</td>
              <td>${b.check_in ? new Date(b.check_in).toLocaleDateString() : '-'}</td>
              <td>${b.check_out ? new Date(b.check_out).toLocaleDateString() : '-'}</td>
              <td>$${(parseFloat(b.amount) || 0).toFixed(2)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      `;
    }
  } catch (err) {
    area.innerHTML = '<div class="empty-state"><p>Error loading dashboard data.</p></div>';
  }
}

// ============ PROPERTIES ============
async function renderProperties() {
  const area = document.getElementById('contentArea');
  try {
    state.properties = await api('/properties');
    area.innerHTML = `
      <div class="section-header">
        <h3>Properties (${state.properties.length})</h3>
        <button class="btn btn-primary" onclick="showPropertyForm()">+ Add Property</button>
      </div>
      <div class="table-wrapper">
        ${state.properties.length === 0 ? '<div class="empty-state"><p>No properties added yet.</p></div>' : `
        <table class="data-table">
          <thead><tr><th>Nickname</th><th>Address</th><th>License</th><th>iCal</th><th>Actions</th></tr></thead>
          <tbody>
            ${state.properties.map(p => `<tr>
              <td><strong>${p.nickname || '-'}</strong></td>
              <td>${p.address || '-'}</td>
              <td><span class="badge ${p.license_status === 'active' ? 'badge-success' : 'badge-warning'}">${p.license_status || 'none'}</span></td>
              <td>${p.airbnb_ical_url ? '<span class="badge badge-info">Airbnb</span>' : ''} ${p.vrbo_ical_url ? '<span class="badge badge-info">VRBO</span>' : ''}</td>
              <td class="action-btns">
                <button class="action-btn" onclick="showPropertyForm('${p.id}')" title="Edit">&#9998;</button>
                <button class="action-btn" onclick="syncProperty('${p.id}')" title="Sync iCal">&#8635;</button>
                <button class="action-btn delete" onclick="deleteProperty('${p.id}')" title="Delete">&#10005;</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`}
      </div>
    `;
  } catch (err) {
    area.innerHTML = '<div class="empty-state"><p>Error loading properties.</p></div>';
  }
}

function showPropertyForm(id) {
  const property = id ? state.properties.find(p => p.id === id) : {};
  openModal(id ? 'Edit Property' : 'Add Property', `
    <form id="propertyForm">
      <div class="form-group">
        <label>Nickname</label>
        <input class="form-control" name="nickname" value="${property.nickname || ''}" required>
      </div>
      <div class="form-group">
        <label>Address</label>
        <input class="form-control" name="address" value="${property.address || ''}">
      </div>
      <div class="form-group">
        <label>Airbnb iCal URL</label>
        <input class="form-control" name="airbnb_ical_url" value="${property.airbnb_ical_url || ''}" placeholder="https://...">
      </div>
      <div class="form-group">
        <label>VRBO iCal URL</label>
        <input class="form-control" name="vrbo_ical_url" value="${property.vrbo_ical_url || ''}" placeholder="https://...">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>License Status</label>
          <select class="form-control" name="license_status">
            <option value="" ${!property.license_status ? 'selected' : ''}>None</option>
            <option value="active" ${property.license_status === 'active' ? 'selected' : ''}>Active</option>
            <option value="pending" ${property.license_status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="expired" ${property.license_status === 'expired' ? 'selected' : ''}>Expired</option>
          </select>
        </div>
        <div class="form-group">
          <label>License Renewal Date</label>
          <input class="form-control" type="date" name="license_renewal_date" value="${property.license_renewal_date || ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Welcome Message</label>
        <textarea class="form-control" name="welcome_message">${property.welcome_message || ''}</textarea>
      </div>
      <div class="form-group">
        <label>Check-in Instructions</label>
        <textarea class="form-control" name="check_in_instructions">${property.check_in_instructions || ''}</textarea>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea class="form-control" name="notes">${property.notes || ''}</textarea>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="public_bookable" ${property.public_bookable ? 'checked' : ''}> Publicly bookable</label>
      </div>
      <button type="submit" class="btn btn-primary">${id ? 'Update' : 'Add'} Property</button>
    </form>
  `);

  document.getElementById('propertyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.public_bookable = fd.has('public_bookable');

    try {
      if (id) {
        await api(`/properties/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        showToast('Property updated');
      } else {
        await api('/properties', { method: 'POST', body: JSON.stringify(body) });
        showToast('Property added');
      }
      closeModal();
      renderProperties();
    } catch (err) { /* toast shown by api() */ }
  });
}

async function syncProperty(id) {
  try {
    const result = await api('/sync-ical', { method: 'POST', body: JSON.stringify({ property_id: id }) });
    showToast(`Synced ${result.synced} events`);
  } catch (err) { /* toast shown */ }
}

async function deleteProperty(id) {
  if (!confirm('Delete this property? This cannot be undone.')) return;
  try {
    await api(`/properties/${id}`, { method: 'DELETE' });
    showToast('Property deleted');
    renderProperties();
  } catch (err) { /* toast shown */ }
}

// ============ CALENDAR ============
async function renderCalendar() {
  const area = document.getElementById('contentArea');
  try {
    if (state.properties.length === 0) {
      state.properties = await api('/properties');
    }

    area.innerHTML = `
      <div class="section-header">
        <h3>Calendar</h3>
        <div class="filter-bar">
          <select id="calPropertyFilter" onchange="updateCalendar()">
            <option value="">All Properties</option>
            ${state.properties.map(p => `<option value="${p.id}">${p.nickname}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="calendar-container">
        <div class="calendar-header">
          <button class="btn btn-sm btn-secondary" onclick="changeMonth(-1)">&larr; Prev</button>
          <h4 id="calendarTitle"></h4>
          <button class="btn btn-sm btn-secondary" onclick="changeMonth(1)">Next &rarr;</button>
        </div>
        <div class="calendar-grid" id="calendarGrid"></div>
      </div>
    `;
    await updateCalendar();
  } catch (err) {
    area.innerHTML = '<div class="empty-state"><p>Error loading calendar.</p></div>';
  }
}

async function updateCalendar() {
  const propertyFilter = document.getElementById('calPropertyFilter')?.value;
  let url = '/synced-events';
  if (propertyFilter) url += `?property_id=${propertyFilter}`;

  try {
    state.syncedEvents = await api(url);
  } catch (e) {
    state.syncedEvents = [];
  }

  // Also get manual bookings
  let bookingsUrl = '/bookings';
  if (propertyFilter) bookingsUrl += `?property_id=${propertyFilter}`;
  try {
    state.bookings = await api(bookingsUrl);
  } catch (e) {
    state.bookings = [];
  }

  drawCalendar();
}

function changeMonth(delta) {
  state.calendarMonth += delta;
  if (state.calendarMonth > 11) { state.calendarMonth = 0; state.calendarYear++; }
  if (state.calendarMonth < 0) { state.calendarMonth = 11; state.calendarYear--; }
  drawCalendar();
}

function drawCalendar() {
  const title = document.getElementById('calendarTitle');
  const grid = document.getElementById('calendarGrid');
  if (!title || !grid) return;

  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  title.textContent = `${months[state.calendarMonth]} ${state.calendarYear}`;

  const firstDay = new Date(state.calendarYear, state.calendarMonth, 1).getDay();
  const daysInMonth = new Date(state.calendarYear, state.calendarMonth + 1, 0).getDate();
  const today = new Date();

  let html = '';
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  dayNames.forEach(d => { html += `<div class="calendar-day-header">${d}</div>`; });

  // Previous month padding
  const prevDays = new Date(state.calendarYear, state.calendarMonth, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) {
    html += `<div class="calendar-day other-month"><span class="day-number">${prevDays - i}</span></div>`;
  }

  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${state.calendarYear}-${String(state.calendarMonth + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday = today.getFullYear() === state.calendarYear && today.getMonth() === state.calendarMonth && today.getDate() === day;

    // Find events for this day
    const events = getEventsForDate(dateStr);

    html += `<div class="calendar-day ${isToday ? 'today' : ''}">
      <span class="day-number">${day}</span>
      ${events.map(e => `<div class="calendar-event ${e.type}">${e.label}</div>`).join('')}
    </div>`;
  }

  // Next month padding
  const totalCells = firstDay + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= remaining; i++) {
    html += `<div class="calendar-day other-month"><span class="day-number">${i}</span></div>`;
  }

  grid.innerHTML = html;
}

function getEventsForDate(dateStr) {
  const events = [];

  // Synced iCal events
  state.syncedEvents.forEach(ev => {
    if (ev.start_date <= dateStr && ev.end_date > dateStr) {
      events.push({ type: ev.source || 'manual', label: ev.summary || 'Blocked' });
    }
  });

  // Manual bookings
  state.bookings.forEach(b => {
    const ci = b.check_in ? b.check_in.split('T')[0] : null;
    const co = b.check_out ? b.check_out.split('T')[0] : null;
    if (ci && co && ci <= dateStr && co > dateStr) {
      events.push({ type: 'manual', label: b.contact_name || 'Booking' });
    }
  });

  return events;
}

// ============ BOOKINGS ============
async function renderBookings() {
  const area = document.getElementById('contentArea');
  try {
    if (state.properties.length === 0) state.properties = await api('/properties');
    state.bookings = await api('/bookings');

    area.innerHTML = `
      <div class="section-header">
        <h3>Bookings (${state.bookings.length})</h3>
        <button class="btn btn-primary" onclick="showBookingForm()">+ Add Booking</button>
      </div>
      <div class="table-wrapper">
        ${state.bookings.length === 0 ? '<div class="empty-state"><p>No bookings yet.</p></div>' : `
        <table class="data-table">
          <thead><tr><th>Property</th><th>Contact</th><th>Check In</th><th>Check Out</th><th>Amount</th><th>Type</th><th>Actions</th></tr></thead>
          <tbody>
            ${state.bookings.map(b => `<tr>
              <td>${b.rental_properties?.nickname || '-'}</td>
              <td>${b.contact_name || b.rental_guests?.name || '-'}</td>
              <td>${b.check_in ? new Date(b.check_in).toLocaleDateString() : '-'}</td>
              <td>${b.check_out ? new Date(b.check_out).toLocaleDateString() : '-'}</td>
              <td>$${(parseFloat(b.amount) || 0).toFixed(2)}</td>
              <td>${b.rental_booking_types?.name || '-'}</td>
              <td class="action-btns">
                <button class="action-btn" onclick="showBookingForm('${b.id}')" title="Edit">&#9998;</button>
                <button class="action-btn delete" onclick="deleteBooking('${b.id}')" title="Delete">&#10005;</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`}
      </div>
    `;
  } catch (err) {
    area.innerHTML = '<div class="empty-state"><p>Error loading bookings.</p></div>';
  }
}

function showBookingForm(id) {
  const booking = id ? state.bookings.find(b => b.id === id) : {};
  openModal(id ? 'Edit Booking' : 'Add Booking', `
    <form id="bookingForm">
      <div class="form-group">
        <label>Property</label>
        <select class="form-control" name="property_id" required>
          <option value="">Select property...</option>
          ${state.properties.map(p => `<option value="${p.id}" ${booking.property_id === p.id ? 'selected' : ''}>${p.nickname}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Check In</label>
          <input class="form-control" type="date" name="check_in" value="${booking.check_in ? booking.check_in.split('T')[0] : ''}" required>
        </div>
        <div class="form-group">
          <label>Check Out</label>
          <input class="form-control" type="date" name="check_out" value="${booking.check_out ? booking.check_out.split('T')[0] : ''}" required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Amount ($)</label>
          <input class="form-control" type="number" step="0.01" name="amount" value="${booking.amount || ''}">
        </div>
        <div class="form-group">
          <label>Contact Name</label>
          <input class="form-control" name="contact_name" value="${booking.contact_name || ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Guest</label>
        <select class="form-control" name="guest_id" id="bookingGuestSelect">
          <option value="">None</option>
        </select>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea class="form-control" name="notes">${booking.notes || ''}</textarea>
      </div>
      <button type="submit" class="btn btn-primary">${id ? 'Update' : 'Add'} Booking</button>
    </form>
  `);

  // Load guests for dropdown
  api('/guests').then(guests => {
    const sel = document.getElementById('bookingGuestSelect');
    if (sel) {
      guests.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        if (booking.guest_id === g.id) opt.selected = true;
        sel.appendChild(opt);
      });
    }
  });

  document.getElementById('bookingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    if (!body.guest_id) delete body.guest_id;
    if (body.amount) body.amount = parseFloat(body.amount);

    try {
      if (id) {
        await api(`/bookings/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        showToast('Booking updated');
      } else {
        await api('/bookings', { method: 'POST', body: JSON.stringify(body) });
        showToast('Booking added');
      }
      closeModal();
      renderBookings();
    } catch (err) { /* toast shown */ }
  });
}

async function deleteBooking(id) {
  if (!confirm('Delete this booking?')) return;
  try {
    await api(`/bookings/${id}`, { method: 'DELETE' });
    showToast('Booking deleted');
    renderBookings();
  } catch (err) { /* toast shown */ }
}

// ============ GUESTS ============
async function renderGuests() {
  const area = document.getElementById('contentArea');
  try {
    state.guests = await api('/guests');
    area.innerHTML = `
      <div class="section-header">
        <h3>Guests (${state.guests.length})</h3>
        <button class="btn btn-primary" onclick="showGuestForm()">+ Add Guest</button>
      </div>
      <div class="table-wrapper">
        ${state.guests.length === 0 ? '<div class="empty-state"><p>No guests added yet.</p></div>' : `
        <table class="data-table">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Notes</th><th>Actions</th></tr></thead>
          <tbody>
            ${state.guests.map(g => `<tr>
              <td><strong>${g.name || '-'}</strong></td>
              <td>${g.email || '-'}</td>
              <td>${g.phone || '-'}</td>
              <td>${(g.notes || '').substring(0, 50)}</td>
              <td class="action-btns">
                <button class="action-btn" onclick="showGuestForm('${g.id}')" title="Edit">&#9998;</button>
                <button class="action-btn delete" onclick="deleteGuest('${g.id}')" title="Delete">&#10005;</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`}
      </div>
    `;
  } catch (err) {
    area.innerHTML = '<div class="empty-state"><p>Error loading guests.</p></div>';
  }
}

function showGuestForm(id) {
  const guest = id ? state.guests.find(g => g.id === id) : {};
  openModal(id ? 'Edit Guest' : 'Add Guest', `
    <form id="guestForm">
      <div class="form-group">
        <label>Name</label>
        <input class="form-control" name="name" value="${guest.name || ''}" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Email</label>
          <input class="form-control" type="email" name="email" value="${guest.email || ''}">
        </div>
        <div class="form-group">
          <label>Phone</label>
          <input class="form-control" name="phone" value="${guest.phone || ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Address</label>
        <input class="form-control" name="address" value="${guest.address || ''}">
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea class="form-control" name="notes">${guest.notes || ''}</textarea>
      </div>
      <button type="submit" class="btn btn-primary">${id ? 'Update' : 'Add'} Guest</button>
    </form>
  `);

  document.getElementById('guestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    try {
      if (id) {
        await api(`/guests/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        showToast('Guest updated');
      } else {
        await api('/guests', { method: 'POST', body: JSON.stringify(body) });
        showToast('Guest added');
      }
      closeModal();
      renderGuests();
    } catch (err) { /* toast shown */ }
  });
}

async function deleteGuest(id) {
  if (!confirm('Delete this guest?')) return;
  try {
    await api(`/guests/${id}`, { method: 'DELETE' });
    showToast('Guest deleted');
    renderGuests();
  } catch (err) { /* toast shown */ }
}

// ============ CLEANERS ============
async function renderCleaners() {
  const area = document.getElementById('contentArea');
  try {
    state.cleaners = await api('/cleaners');
    area.innerHTML = `
      <div class="section-header">
        <h3>Cleaners (${state.cleaners.length})</h3>
        <button class="btn btn-primary" onclick="showCleanerForm()">+ Add Cleaner</button>
      </div>
      <div class="table-wrapper">
        ${state.cleaners.length === 0 ? '<div class="empty-state"><p>No cleaners added yet.</p></div>' : `
        <table class="data-table">
          <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Rate</th><th>Notes</th><th>Actions</th></tr></thead>
          <tbody>
            ${state.cleaners.map(c => `<tr>
              <td><strong>${c.name || '-'}</strong></td>
              <td>${c.phone || '-'}</td>
              <td>${c.email || '-'}</td>
              <td>${c.rate ? '$' + c.rate : '-'}</td>
              <td>${(c.notes || '').substring(0, 40)}</td>
              <td class="action-btns">
                <button class="action-btn" onclick="showCleanerForm('${c.id}')" title="Edit">&#9998;</button>
                <button class="action-btn delete" onclick="deleteCleaner('${c.id}')" title="Delete">&#10005;</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`}
      </div>
    `;
  } catch (err) {
    area.innerHTML = '<div class="empty-state"><p>Error loading cleaners.</p></div>';
  }
}

function showCleanerForm(id) {
  const cleaner = id ? state.cleaners.find(c => c.id === id) : {};
  openModal(id ? 'Edit Cleaner' : 'Add Cleaner', `
    <form id="cleanerForm">
      <div class="form-group">
        <label>Name</label>
        <input class="form-control" name="name" value="${cleaner.name || ''}" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Phone</label>
          <input class="form-control" name="phone" value="${cleaner.phone || ''}">
        </div>
        <div class="form-group">
          <label>Email</label>
          <input class="form-control" type="email" name="email" value="${cleaner.email || ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Rate ($)</label>
        <input class="form-control" type="number" step="0.01" name="rate" value="${cleaner.rate || ''}">
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea class="form-control" name="notes">${cleaner.notes || ''}</textarea>
      </div>
      <button type="submit" class="btn btn-primary">${id ? 'Update' : 'Add'} Cleaner</button>
    </form>
  `);

  document.getElementById('cleanerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    if (body.rate) body.rate = parseFloat(body.rate);
    try {
      if (id) {
        await api(`/cleaners/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        showToast('Cleaner updated');
      } else {
        await api('/cleaners', { method: 'POST', body: JSON.stringify(body) });
        showToast('Cleaner added');
      }
      closeModal();
      renderCleaners();
    } catch (err) { /* toast shown */ }
  });
}

async function deleteCleaner(id) {
  if (!confirm('Delete this cleaner?')) return;
  try {
    await api(`/cleaners/${id}`, { method: 'DELETE' });
    showToast('Cleaner deleted');
    renderCleaners();
  } catch (err) { /* toast shown */ }
}

// ============ MAILING LIST ============
async function renderMailing() {
  const area = document.getElementById('contentArea');
  try {
    const mailingList = await api('/mailing-list');
    area.innerHTML = `
      <div class="section-header">
        <h3>Mailing List (${mailingList.length} past guests)</h3>
      </div>
      ${mailingList.length === 0 ? '<div class="empty-state"><p>No guests with email addresses found in bookings.</p></div>' : `
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr><th>Name</th><th>Email</th><th>Last Stay</th><th>Property</th><th>Stays</th><th>Actions</th></tr></thead>
          <tbody>
            ${mailingList.map(g => `<tr>
              <td><strong>${g.name || '-'}</strong></td>
              <td>${g.email || '-'}</td>
              <td>${g.lastStay ? new Date(g.lastStay).toLocaleDateString() : '-'}</td>
              <td>${g.property || '-'}</td>
              <td>${g.bookingCount}</td>
              <td><button class="btn btn-sm btn-secondary" onclick="generateInviteEmail('${encodeURIComponent(g.name)}', '${encodeURIComponent(g.email)}', '${encodeURIComponent(g.property)}')">Generate Email</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
      <div id="emailPreviewArea"></div>
    `;
  } catch (err) {
    area.innerHTML = '<div class="empty-state"><p>Error loading mailing list.</p></div>';
  }
}

function generateInviteEmail(name, email, property) {
  name = decodeURIComponent(name);
  email = decodeURIComponent(email);
  property = decodeURIComponent(property);

  const emailBody = `Hi ${name},

Hope you've been doing well! We wanted to reach out because we'd love to have you back at ${property}.

Since your last stay, we've made some improvements and would be happy to offer you a returning-guest rate if you're interested in booking again.

If you have any dates in mind, just let us know and we'll check availability for you.

Looking forward to hearing from you!

Best regards,
Matt`;

  const previewArea = document.getElementById('emailPreviewArea');
  previewArea.innerHTML = `
    <div style="margin-top: 24px;">
      <h4 style="margin-bottom: 12px;">Email Preview for ${name} (${email})</h4>
      <div class="email-preview">${emailBody}</div>
      <div style="margin-top: 12px;">
        <a href="mailto:${email}?subject=We'd love to have you back at ${property}!&body=${encodeURIComponent(emailBody)}" class="btn btn-primary">Open in Email Client</a>
      </div>
    </div>
  `;
}

// ============ TOOLS ============
async function renderTools() {
  const area = document.getElementById('contentArea');
  if (state.properties.length === 0) {
    try { state.properties = await api('/properties'); } catch (e) { state.properties = []; }
  }

  area.innerHTML = `
    <div class="tools-tabs">
      <button class="tool-tab active" onclick="switchToolTab('evaluation')">Property Evaluation</button>
      <button class="tool-tab" onclick="switchToolTab('maintenance')">Maintenance</button>
      <button class="tool-tab" onclick="switchToolTab('licensing')">Licensing</button>
      <button class="tool-tab" onclick="switchToolTab('todos')">To-Dos</button>
    </div>
    <div class="tool-panel active" id="panel-evaluation"></div>
    <div class="tool-panel" id="panel-maintenance"></div>
    <div class="tool-panel" id="panel-licensing"></div>
    <div class="tool-panel" id="panel-todos"></div>
  `;

  renderEvaluation();
}

function switchToolTab(tab) {
  state.currentToolTab = tab;
  document.querySelectorAll('.tool-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tool-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tool-tab[onclick*="${tab}"]`).classList.add('active');
  document.getElementById(`panel-${tab}`).classList.add('active');

  switch (tab) {
    case 'evaluation': renderEvaluation(); break;
    case 'maintenance': renderMaintenance(); break;
    case 'licensing': renderLicensing(); break;
    case 'todos': renderTodos(); break;
  }
}

// ---- Property Evaluation ----
function renderEvaluation() {
  const panel = document.getElementById('panel-evaluation');
  panel.innerHTML = `
    <div class="section-header">
      <h3>Property Evaluation vs Ontario STR Benchmarks</h3>
    </div>
    <div class="form-row" style="margin-bottom: 24px;">
      <div class="form-group">
        <label>Select Property</label>
        <select class="form-control" id="evalProperty" onchange="loadEvalData()">
          <option value="">Custom Input</option>
          ${state.properties.map(p => `<option value="${p.id}">${p.nickname}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Occupancy Rate (%)</label>
        <input class="form-control" type="number" id="evalOccupancy" value="50" step="0.1">
      </div>
      <div class="form-group">
        <label>Average Daily Rate ($)</label>
        <input class="form-control" type="number" id="evalADR" value="200" step="1">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Nightly Rate ($)</label>
        <input class="form-control" type="number" id="evalNightly" value="180" step="1">
      </div>
      <div class="form-group">
        <label>Monthly Expenses ($)</label>
        <input class="form-control" type="number" id="evalExpenses" value="1500" step="1">
      </div>
    </div>
    <button class="btn btn-primary" onclick="runEvaluation()" style="margin-top: 12px;">Run Evaluation</button>
    <div id="evalResults"></div>
  `;
}

async function loadEvalData() {
  const propId = document.getElementById('evalProperty').value;
  if (!propId) return;

  try {
    const stats = await api('/dashboard');
    document.getElementById('evalOccupancy').value = stats.occupancyRate || 50;
    document.getElementById('evalADR').value = stats.avgNightlyRate || 200;
    document.getElementById('evalNightly').value = stats.avgNightlyRate || 180;
  } catch (e) { /* use defaults */ }
}

function runEvaluation() {
  const occupancy = parseFloat(document.getElementById('evalOccupancy').value) || 0;
  const adr = parseFloat(document.getElementById('evalADR').value) || 0;
  const nightly = parseFloat(document.getElementById('evalNightly').value) || 0;
  const expenses = parseFloat(document.getElementById('evalExpenses').value) || 0;
  const revpar = (occupancy / 100) * adr;
  const monthlyRevenue = (occupancy / 100) * 30 * nightly;
  const monthlyProfit = monthlyRevenue - expenses;

  // Ontario benchmarks
  const benchmarks = {
    occupancy: { low: 55, high: 65, label: 'Occupancy Rate' },
    adr: { low: 180, high: 250, label: 'Avg Daily Rate' },
    revpar: { low: 100, high: 160, label: 'RevPAR' }
  };

  function getStatus(val, bench) {
    if (val >= bench.high) return 'above';
    if (val >= bench.low) return 'neutral';
    return 'below';
  }

  function getStatusLabel(val, bench) {
    if (val >= bench.high) return 'Above Avg';
    if (val >= bench.low) return 'Average';
    return 'Below Avg';
  }

  const results = document.getElementById('evalResults');
  results.innerHTML = `
    <div class="eval-grid">
      <div class="eval-card">
        <h4>Your Metrics</h4>
        <div class="benchmark-row">
          <span class="benchmark-label">Occupancy Rate</span>
          <span class="benchmark-value ${getStatus(occupancy, benchmarks.occupancy)}">${occupancy.toFixed(1)}% - ${getStatusLabel(occupancy, benchmarks.occupancy)}</span>
        </div>
        <div class="benchmark-row">
          <span class="benchmark-label">Avg Daily Rate</span>
          <span class="benchmark-value ${getStatus(adr, benchmarks.adr)}">$${adr.toFixed(2)} - ${getStatusLabel(adr, benchmarks.adr)}</span>
        </div>
        <div class="benchmark-row">
          <span class="benchmark-label">RevPAR</span>
          <span class="benchmark-value ${getStatus(revpar, benchmarks.revpar)}">$${revpar.toFixed(2)} - ${getStatusLabel(revpar, benchmarks.revpar)}</span>
        </div>
        <div class="benchmark-row">
          <span class="benchmark-label">Monthly Revenue (est.)</span>
          <span class="benchmark-value neutral">$${monthlyRevenue.toFixed(2)}</span>
        </div>
        <div class="benchmark-row">
          <span class="benchmark-label">Monthly Profit (est.)</span>
          <span class="benchmark-value ${monthlyProfit >= 0 ? 'above' : 'below'}">$${monthlyProfit.toFixed(2)}</span>
        </div>
      </div>
      <div class="eval-card">
        <h4>Ontario STR Benchmarks</h4>
        <div class="benchmark-row">
          <span class="benchmark-label">Avg Occupancy</span>
          <span class="benchmark-value neutral">55% - 65%</span>
        </div>
        <div class="benchmark-row">
          <span class="benchmark-label">Avg Daily Rate</span>
          <span class="benchmark-value neutral">$180 - $250</span>
        </div>
        <div class="benchmark-row">
          <span class="benchmark-label">Avg RevPAR</span>
          <span class="benchmark-value neutral">$100 - $160</span>
        </div>
        <div class="benchmark-row" style="margin-top: 16px; border-top: 1px solid var(--border); padding-top: 16px;">
          <span class="benchmark-label" style="font-size: 0.75rem; color: var(--text-muted);">
            Benchmarks based on Ontario short-term rental market averages. Your performance is color-coded:<br>
            <span style="color: var(--success);">Green = Above average</span> |
            <span style="color: var(--warning);">Yellow = Average</span> |
            <span style="color: var(--danger);">Red = Below average</span>
          </span>
        </div>
      </div>
    </div>
  `;
}

// ---- Maintenance ----
async function renderMaintenance() {
  const panel = document.getElementById('panel-maintenance');
  try {
    state.maintenance = await api('/maintenance');
    panel.innerHTML = `
      <div class="section-header">
        <h3>Maintenance & Inventory</h3>
        <div class="btn-group">
          <select id="maintPropertyFilter" onchange="filterMaintenance()" class="form-control" style="width:auto;">
            <option value="">All Properties</option>
            ${state.properties.map(p => `<option value="${p.id}">${p.nickname}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" onclick="showMaintenanceForm()">+ Add Item</button>
        </div>
      </div>
      <div class="table-wrapper" id="maintenanceList">
        ${renderMaintenanceTable(state.maintenance)}
      </div>
    `;
  } catch (err) {
    panel.innerHTML = '<div class="empty-state"><p>Error loading maintenance items.</p></div>';
  }
}

function renderMaintenanceTable(items) {
  if (items.length === 0) return '<div class="empty-state"><p>No maintenance items.</p></div>';
  return `
    <table class="data-table">
      <thead><tr><th>Item</th><th>Category</th><th>Property</th><th>In Stock</th><th>Actions</th></tr></thead>
      <tbody>
        ${items.map(m => `<tr>
          <td>${m.item_name || '-'}</td>
          <td>${m.category || '-'}</td>
          <td>${m.rental_properties?.nickname || '-'}</td>
          <td><span class="badge ${m.in_stock ? 'badge-success' : 'badge-danger'}">${m.in_stock ? 'Yes' : 'No'}</span></td>
          <td class="action-btns">
            <button class="action-btn" onclick="showMaintenanceForm('${m.id}')" title="Edit">&#9998;</button>
            <button class="action-btn delete" onclick="deleteMaintenance('${m.id}')" title="Delete">&#10005;</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}

function filterMaintenance() {
  const propId = document.getElementById('maintPropertyFilter').value;
  const filtered = propId ? state.maintenance.filter(m => m.property_id === propId) : state.maintenance;
  document.getElementById('maintenanceList').innerHTML = renderMaintenanceTable(filtered);
}

function showMaintenanceForm(id) {
  const item = id ? state.maintenance.find(m => m.id === id) : {};
  openModal(id ? 'Edit Item' : 'Add Maintenance Item', `
    <form id="maintForm">
      <div class="form-group">
        <label>Property</label>
        <select class="form-control" name="property_id" required>
          ${state.properties.map(p => `<option value="${p.id}" ${item.property_id === p.id ? 'selected' : ''}>${p.nickname}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Item Name</label>
          <input class="form-control" name="item_name" value="${item.item_name || ''}" required>
        </div>
        <div class="form-group">
          <label>Category</label>
          <input class="form-control" name="category" value="${item.category || ''}" placeholder="e.g., Supplies, Furniture">
        </div>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="in_stock" ${item.in_stock !== false ? 'checked' : ''}> In Stock</label>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea class="form-control" name="notes">${item.notes || ''}</textarea>
      </div>
      <button type="submit" class="btn btn-primary">${id ? 'Update' : 'Add'} Item</button>
    </form>
  `);

  document.getElementById('maintForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.in_stock = fd.has('in_stock');
    try {
      if (id) {
        await api(`/maintenance/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        showToast('Item updated');
      } else {
        await api('/maintenance', { method: 'POST', body: JSON.stringify(body) });
        showToast('Item added');
      }
      closeModal();
      renderMaintenance();
    } catch (err) { /* toast shown */ }
  });
}

async function deleteMaintenance(id) {
  if (!confirm('Delete this item?')) return;
  try {
    await api(`/maintenance/${id}`, { method: 'DELETE' });
    showToast('Item deleted');
    renderMaintenance();
  } catch (err) { /* toast shown */ }
}

// ---- Licensing ----
async function renderLicensing() {
  const panel = document.getElementById('panel-licensing');
  try {
    state.licensing = await api('/licensing');
    panel.innerHTML = `
      <div class="section-header">
        <h3>Licensing Checklist</h3>
        <div class="btn-group">
          <select id="licPropertyFilter" onchange="filterLicensing()" class="form-control" style="width:auto;">
            <option value="">All Properties</option>
            ${state.properties.map(p => `<option value="${p.id}">${p.nickname}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" onclick="showLicensingForm()">+ Add Step</button>
        </div>
      </div>
      <div id="licensingList">${renderLicensingList(state.licensing)}</div>
    `;
  } catch (err) {
    panel.innerHTML = '<div class="empty-state"><p>Error loading licensing items.</p></div>';
  }
}

function renderLicensingList(items) {
  if (items.length === 0) return '<div class="empty-state"><p>No licensing steps.</p></div>';
  return items.map(item => `
    <div class="license-item">
      <div class="license-status ${item.status || 'not-started'}" onclick="toggleLicenseStatus('${item.id}', '${item.status}')">
        ${item.status === 'complete' ? '&#10003;' : item.status === 'pending' ? '...' : ''}
      </div>
      <div style="flex:1;">
        <div style="font-weight:500; font-size:0.9rem;">${item.step_name || '-'}</div>
        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${item.description || ''} ${item.bylaw_ref ? '(Ref: ' + item.bylaw_ref + ')' : ''}</div>
        ${item.rental_properties ? `<div style="font-size:0.7rem; color:var(--text-muted);">${item.rental_properties.nickname}</div>` : ''}
      </div>
      <div class="action-btns">
        <button class="action-btn" onclick="showLicensingForm('${item.id}')" title="Edit">&#9998;</button>
        <button class="action-btn delete" onclick="deleteLicensing('${item.id}')" title="Delete">&#10005;</button>
      </div>
    </div>
  `).join('');
}

function filterLicensing() {
  const propId = document.getElementById('licPropertyFilter').value;
  const filtered = propId ? state.licensing.filter(l => l.property_id === propId) : state.licensing;
  document.getElementById('licensingList').innerHTML = renderLicensingList(filtered);
}

async function toggleLicenseStatus(id, current) {
  const next = current === 'complete' ? 'not-started' : current === 'pending' ? 'complete' : 'pending';
  try {
    await api(`/licensing/${id}`, { method: 'PUT', body: JSON.stringify({ status: next, completed_date: next === 'complete' ? new Date().toISOString().split('T')[0] : null }) });
    renderLicensing();
  } catch (err) { /* toast shown */ }
}

function showLicensingForm(id) {
  const item = id ? state.licensing.find(l => l.id === id) : {};
  openModal(id ? 'Edit Step' : 'Add Licensing Step', `
    <form id="licForm">
      <div class="form-group">
        <label>Property</label>
        <select class="form-control" name="property_id" required>
          ${state.properties.map(p => `<option value="${p.id}" ${item.property_id === p.id ? 'selected' : ''}>${p.nickname}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Step Name</label>
        <input class="form-control" name="step_name" value="${item.step_name || ''}" required>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea class="form-control" name="description">${item.description || ''}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Bylaw Reference</label>
          <input class="form-control" name="bylaw_ref" value="${item.bylaw_ref || ''}">
        </div>
        <div class="form-group">
          <label>Sort Order</label>
          <input class="form-control" type="number" name="sort_order" value="${item.sort_order || 0}">
        </div>
      </div>
      <div class="form-group">
        <label>Status</label>
        <select class="form-control" name="status">
          <option value="not-started" ${item.status === 'not-started' ? 'selected' : ''}>Not Started</option>
          <option value="pending" ${item.status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="complete" ${item.status === 'complete' ? 'selected' : ''}>Complete</option>
        </select>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea class="form-control" name="notes">${item.notes || ''}</textarea>
      </div>
      <button type="submit" class="btn btn-primary">${id ? 'Update' : 'Add'} Step</button>
    </form>
  `);

  document.getElementById('licForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    if (body.sort_order) body.sort_order = parseInt(body.sort_order);
    try {
      if (id) {
        await api(`/licensing/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        showToast('Step updated');
      } else {
        await api('/licensing', { method: 'POST', body: JSON.stringify(body) });
        showToast('Step added');
      }
      closeModal();
      renderLicensing();
    } catch (err) { /* toast shown */ }
  });
}

async function deleteLicensing(id) {
  if (!confirm('Delete this step?')) return;
  try {
    await api(`/licensing/${id}`, { method: 'DELETE' });
    showToast('Step deleted');
    renderLicensing();
  } catch (err) { /* toast shown */ }
}

// ---- To-Dos ----
async function renderTodos() {
  const panel = document.getElementById('panel-todos');
  try {
    state.todos = await api('/todos');
    const pending = state.todos.filter(t => t.status !== 'completed');
    const completed = state.todos.filter(t => t.status === 'completed');

    panel.innerHTML = `
      <div class="section-header">
        <h3>To-Do List</h3>
        <button class="btn btn-primary btn-sm" onclick="showTodoForm()">+ Add To-Do</button>
      </div>
      <div id="todoList">
        ${pending.length === 0 && completed.length === 0 ? '<div class="empty-state"><p>No to-dos yet.</p></div>' : ''}
        ${pending.map(t => renderTodoItem(t)).join('')}
        ${completed.length > 0 ? `<h4 style="margin: 20px 0 12px; font-size: 0.85rem; color: var(--text-muted);">Completed (${completed.length})</h4>` : ''}
        ${completed.map(t => renderTodoItem(t)).join('')}
      </div>
    `;
  } catch (err) {
    panel.innerHTML = '<div class="empty-state"><p>Error loading to-dos.</p></div>';
  }
}

function renderTodoItem(t) {
  const isComplete = t.status === 'completed';
  const priorityClass = t.priority ? `priority-${t.priority}` : '';
  return `
    <div class="todo-item ${isComplete ? 'completed' : ''} ${priorityClass}">
      <div class="todo-checkbox ${isComplete ? 'checked' : ''}" onclick="toggleTodo('${t.id}', '${t.status}')"></div>
      <div class="todo-content">
        <div class="todo-title">${t.title || '-'}</div>
        <div class="todo-meta">
          ${t.priority ? t.priority.charAt(0).toUpperCase() + t.priority.slice(1) + ' priority' : ''}
          ${t.due_date ? ' | Due: ' + new Date(t.due_date).toLocaleDateString() : ''}
          ${t.rental_properties?.nickname ? ' | ' + t.rental_properties.nickname : ''}
        </div>
      </div>
      <div class="action-btns">
        <button class="action-btn" onclick="showTodoForm('${t.id}')" title="Edit">&#9998;</button>
        <button class="action-btn delete" onclick="deleteTodo('${t.id}')" title="Delete">&#10005;</button>
      </div>
    </div>
  `;
}

async function toggleTodo(id, currentStatus) {
  const newStatus = currentStatus === 'completed' ? 'pending' : 'completed';
  try {
    await api(`/todos/${id}`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
    renderTodos();
  } catch (err) { /* toast shown */ }
}

function showTodoForm(id) {
  const todo = id ? state.todos.find(t => t.id === id) : {};
  openModal(id ? 'Edit To-Do' : 'Add To-Do', `
    <form id="todoForm">
      <div class="form-group">
        <label>Title</label>
        <input class="form-control" name="title" value="${todo.title || ''}" required>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea class="form-control" name="description">${todo.description || ''}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Priority</label>
          <select class="form-control" name="priority">
            <option value="low" ${todo.priority === 'low' ? 'selected' : ''}>Low</option>
            <option value="medium" ${todo.priority === 'medium' ? 'selected' : ''}>Medium</option>
            <option value="high" ${todo.priority === 'high' ? 'selected' : ''}>High</option>
          </select>
        </div>
        <div class="form-group">
          <label>Due Date</label>
          <input class="form-control" type="date" name="due_date" value="${todo.due_date ? todo.due_date.split('T')[0] : ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Property (optional)</label>
        <select class="form-control" name="property_id">
          <option value="">None</option>
          ${state.properties.map(p => `<option value="${p.id}" ${todo.property_id === p.id ? 'selected' : ''}>${p.nickname}</option>`).join('')}
        </select>
      </div>
      <button type="submit" class="btn btn-primary">${id ? 'Update' : 'Add'} To-Do</button>
    </form>
  `);

  document.getElementById('todoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    if (!body.property_id) body.property_id = null;
    if (!body.due_date) body.due_date = null;
    try {
      if (id) {
        await api(`/todos/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        showToast('To-do updated');
      } else {
        body.status = 'pending';
        await api('/todos', { method: 'POST', body: JSON.stringify(body) });
        showToast('To-do added');
      }
      closeModal();
      renderTodos();
    } catch (err) { /* toast shown */ }
  });
}

async function deleteTodo(id) {
  if (!confirm('Delete this to-do?')) return;
  try {
    await api(`/todos/${id}`, { method: 'DELETE' });
    showToast('To-do deleted');
    renderTodos();
  } catch (err) { /* toast shown */ }
}
