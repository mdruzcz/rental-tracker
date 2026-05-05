// Short-Term Rental Tracker — Express + JSON-file store backend.
// No native deps; runs anywhere Node 18+ is installed.
// Run: npm install && npm start  (then open http://localhost:3004)
//
// Twilio creds are loaded from a local .env (gitignored). Copy
// .env.example to .env and fill in your real values before running.

const fs = require('fs');
const path = require('path');
const express = require('express');
const ical = require('node-ical');
const multer = require('multer');
const twilio = require('twilio');

// Load .env (no dotenv dep - keep it minimal)
(() => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const PORT = 3004;

// Twilio SMS config (env-only - never commit real values)
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_FROM || '';
const twilioClient = (TWILIO_SID && TWILIO_AUTH) ? twilio(TWILIO_SID, TWILIO_AUTH) : null;
if (!twilioClient) {
  console.warn('[startup] Twilio creds not set - SMS features disabled. Copy .env.example to .env and fill in values.');
}
const DB_PATH = path.join(__dirname, 'rental.db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer config — store files with unique names
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    cb(null, Date.now() + '-' + base + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20 MB max

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use('/api/public', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const EMPTY = {
  next_id: { properties: 1, booking_types: 1, guests: 1, bookings: 1, cleaners: 1, maintenance_items: 1, synced_events: 1, cleaner_tasks: 1, booking_requests: 1, todos: 1, licensing_items: 1, sms_messages: 1 },
  properties: [], booking_types: [], guests: [], bookings: [],
  cleaners: [], maintenance_items: [], synced_events: [],
  cleaner_tasks: [], booking_requests: [], todos: [],
  licensing_items: [], sms_messages: [],
};

let store;
function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    for (const k of Object.keys(EMPTY)) if (!(k in store)) store[k] = EMPTY[k];
    for (const k of Object.keys(EMPTY.next_id)) {
      if (store.next_id[k] == null) store.next_id[k] = (store[k]?.length || 0) + 1;
    }
    store.properties.forEach(p => {
      if (p.welcome_message == null) p.welcome_message = '';
      if (p.default_cleaner_id == null) p.default_cleaner_id = null;
      if (p.public_bookable == null) p.public_bookable = 0;
      if (p.check_in_instructions == null) p.check_in_instructions = '';
      if (p.nearby_attractions == null) p.nearby_attractions = '';
      if (p.contact_info == null) p.contact_info = '';
      if (p.license_status == null) p.license_status = 'unlicensed';
      if (p.license_renewal_date == null) p.license_renewal_date = null;
    });
    // Migrate existing licensing_items
    const UPLOAD_STEP_NAMES = new Set(['Exterior Photographs', 'Site Plan & Floor Plan', 'Parking Management Plan']);
    (store.licensing_items || []).forEach(l => {
      if (l.attachments == null) l.attachments = [];
      if (l.uploads_allowed == null) l.uploads_allowed = UPLOAD_STEP_NAMES.has(l.step_name) ? 1 : 0;
    });
  } catch (e) {
    store = JSON.parse(JSON.stringify(EMPTY));
    saveStore();
  }
}
function saveStore() {
  fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(store, null, 2));
  fs.renameSync(DB_PATH + '.tmp', DB_PATH);
}
loadStore();

const nowIso = () => new Date().toISOString();
function nextId(table) { return store.next_id[table]++; }
function tableInsert(table, row) {
  const id = nextId(table);
  const newRow = { id, created_at: nowIso(), ...row };
  store[table].push(newRow);
  saveStore();
  return newRow;
}
function tableUpdate(table, id, patch) {
  const idx = store[table].findIndex(r => r.id === Number(id));
  if (idx < 0) return null;
  store[table][idx] = { ...store[table][idx], ...patch };
  saveStore();
  return store[table][idx];
}
function tableRemove(table, id) {
  const before = store[table].length;
  store[table] = store[table].filter(r => r.id !== Number(id));
  saveStore();
  return before - store[table].length;
}
function tableFind(table, id) { return store[table].find(r => r.id === Number(id)) || null; }
function tableAll(table) { return store[table].slice(); }

function cascadeDeleteProperty(propertyId) {
  store.bookings = store.bookings.filter(b => b.property_id !== Number(propertyId));
  store.maintenance_items = store.maintenance_items.filter(m => m.property_id !== Number(propertyId));
  store.synced_events = store.synced_events.filter(s => s.property_id !== Number(propertyId));
  store.cleaner_tasks = store.cleaner_tasks.filter(c => c.property_id !== Number(propertyId));
  store.booking_requests = store.booking_requests.filter(r => r.property_id !== Number(propertyId));
  store.licensing_items = store.licensing_items.filter(l => l.property_id !== Number(propertyId));
  store.todos.forEach(t => { if (t.property_id === Number(propertyId)) t.property_id = null; });
}
function cascadeNullGuest(id) { store.bookings.forEach(b => { if (b.guest_id === Number(id)) b.guest_id = null; }); }
function cascadeNullBookingType(id) { store.bookings.forEach(b => { if (b.booking_type_id === Number(id)) b.booking_type_id = null; }); }
function cascadeNullCleaner(id) {
  store.cleaner_tasks = store.cleaner_tasks.filter(t => t.cleaner_id !== Number(id));
  store.properties.forEach(p => { if (p.default_cleaner_id === Number(id)) p.default_cleaner_id = null; });
}

(function seedDefaults() {
  for (const name of ['Airbnb', 'VRBO', 'Cottages Canada', 'Private']) {
    if (!store.booking_types.find(t => t.name === name)) tableInsert('booking_types', { name });
  }
})();

const DEFAULT_MAINTENANCE_ITEMS = [
  { item_name: 'Bed sheets (sets)', category: 'Linens' },
  { item_name: 'Pillow cases', category: 'Linens' },
  { item_name: 'Bath towels', category: 'Linens' },
  { item_name: 'Hand towels', category: 'Linens' },
  { item_name: 'Dish towels', category: 'Linens' },
  { item_name: 'Dust pan', category: 'Cleaning' },
  { item_name: 'Broom', category: 'Cleaning' },
  { item_name: 'Vacuum', category: 'Cleaning' },
  { item_name: 'Mop', category: 'Cleaning' },
  { item_name: 'Garbage bags', category: 'Cleaning' },
  { item_name: 'All-purpose cleaner', category: 'Cleaning' },
  { item_name: 'Glass cleaner', category: 'Cleaning' },
  { item_name: 'Toilet bowl cleaner', category: 'Cleaning' },
  { item_name: 'Paper towels', category: 'Cleaning' },
  { item_name: 'Toilet paper', category: 'Cleaning' },
  { item_name: 'Dishwasher pods', category: 'Kitchen' },
  { item_name: 'Dish soap', category: 'Kitchen' },
  { item_name: 'Sponges', category: 'Kitchen' },
  { item_name: 'Coffee', category: 'Kitchen' },
  { item_name: 'Coffee filters', category: 'Kitchen' },
  { item_name: 'Salt & pepper', category: 'Kitchen' },
  { item_name: 'Cooking oil', category: 'Kitchen' },
  { item_name: 'Laundry detergent', category: 'Laundry' },
  { item_name: 'Dryer sheets', category: 'Laundry' },
  { item_name: 'Hand soap', category: 'Bathroom' },
  { item_name: 'Shampoo', category: 'Bathroom' },
  { item_name: 'Conditioner', category: 'Bathroom' },
  { item_name: 'Body wash', category: 'Bathroom' },
  { item_name: 'Smoke detector batteries', category: 'Safety' },
  { item_name: 'First aid kit', category: 'Safety' },
  { item_name: 'Fire extinguisher', category: 'Safety' },
  { item_name: 'Lightbulbs (spare)', category: 'Supplies' },
  { item_name: 'Welcome book / house manual', category: 'Supplies' },
];

const DEFAULT_LICENSING_ITEMS = [
  { step_name: 'Payment of Application Fee', description: 'Pay the application fee where applicable.', bylaw_ref: '', sort_order: 1, uploads_allowed: 0 },
  { step_name: 'Registered Owner Info', description: 'The name and contact information for the registered owner of the property.', bylaw_ref: '', sort_order: 2, uploads_allowed: 0 },
  { step_name: 'Exterior Photographs', description: 'Photographs showing the front, back, and sides of the property.', bylaw_ref: '', sort_order: 3, uploads_allowed: 1 },
  { step_name: 'Responsible Person ID & Contact', description: 'Identification and contact information for the Responsible Person.', bylaw_ref: 'Section 4.4 (e)', sort_order: 4, uploads_allowed: 0 },
  { step_name: 'Site Plan & Floor Plan', description: 'A Site Plan and Floor Plan of the STR unit — showing waste container(s).', bylaw_ref: 'Section 4.4 (f) and (k)', sort_order: 5, uploads_allowed: 1 },
  { step_name: 'Parking Management Plan', description: 'A Parking Management Plan for the property.', bylaw_ref: 'Section 4.4 (g)', sort_order: 6, uploads_allowed: 1 },
  { step_name: 'Fire Inspection Proof', description: 'Proof of fire inspection via Central Elgin Fire Rescue Services.', bylaw_ref: 'Section 4.4 (h)', sort_order: 7, uploads_allowed: 0 },
  { step_name: 'Building Code Attestation', description: 'A Building Code compliance attestation.', bylaw_ref: 'Section 4.4 (i)', sort_order: 8, uploads_allowed: 0 },
  { step_name: 'Certificate of Insurance ($2M)', description: 'A Certificate of Insurance in the amount of Two Million Dollars.', bylaw_ref: 'Section 4.4 (j)', sort_order: 9, uploads_allowed: 0 },
  { step_name: 'Submit Application', description: 'Submit the completed application with all supporting documents to the municipality.', bylaw_ref: '', sort_order: 10, uploads_allowed: 0 },
];

const ok = (res, data) => res.json(data);
const err = (res, code, msg) => res.status(code).json({ error: msg });

function joinBooking(b) {
  const p = b.property_id ? tableFind('properties', b.property_id) : null;
  const t = b.booking_type_id ? tableFind('booking_types', b.booking_type_id) : null;
  const g = b.guest_id ? tableFind('guests', b.guest_id) : null;
  return { ...b,
    property_name: p?.nickname || null,
    booking_type_name: t?.name || null,
    guest_name: g?.name || null,
    guest_email: g?.email || null,
  };
}

function syncCleanerTaskForBooking(booking) {
  const property = tableFind('properties', booking.property_id);
  if (!property || !property.default_cleaner_id) return null;
  const dueDate = booking.check_out || booking.check_in;
  const existing = store.cleaner_tasks.find(t => t.booking_id === booking.id);
  if (existing) {
    return tableUpdate('cleaner_tasks', existing.id, {
      cleaner_id: property.default_cleaner_id,
      property_id: booking.property_id,
      due_date: dueDate,
    });
  }
  return tableInsert('cleaner_tasks', {
    cleaner_id: property.default_cleaner_id,
    property_id: booking.property_id,
    booking_id: booking.id,
    due_date: dueDate,
    status: 'pending',
    notes: 'Turnover clean after guest check-out',
  });
}
function removeCleanerTaskForBooking(bookingId) {
  store.cleaner_tasks = store.cleaner_tasks.filter(t => t.booking_id !== Number(bookingId));
  saveStore();
}

// ---------- PROPERTIES ----------
app.get('/api/properties', (req, res) => {
  ok(res, tableAll('properties').sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '')));
});
app.post('/api/properties', (req, res) => {
  const { nickname, address, airbnb_ical_url, vrbo_ical_url, notes, welcome_message, check_in_instructions, nearby_attractions, contact_info, default_cleaner_id, public_bookable, license_status, license_renewal_date } = req.body || {};
  if (!nickname) return err(res, 400, 'nickname required');
  const row = tableInsert('properties', {
    nickname,
    address: address || '',
    airbnb_ical_url: airbnb_ical_url || '',
    vrbo_ical_url: vrbo_ical_url || '',
    notes: notes || '',
    welcome_message: welcome_message || '',
    check_in_instructions: check_in_instructions || '',
    nearby_attractions: nearby_attractions || '',
    contact_info: contact_info || '',
    default_cleaner_id: default_cleaner_id ? Number(default_cleaner_id) : null,
    public_bookable: public_bookable ? 1 : 0,
    license_status: license_status || 'unlicensed',
    license_renewal_date: license_renewal_date || null,
  });
  for (const i of DEFAULT_MAINTENANCE_ITEMS) {
    tableInsert('maintenance_items', { property_id: row.id, item_name: i.item_name, category: i.category, in_stock: 1, notes: '' });
  }
  // Seed default licensing checklist items
  for (const i of DEFAULT_LICENSING_ITEMS) {
    tableInsert('licensing_items', { property_id: row.id, step_name: i.step_name, description: i.description, bylaw_ref: i.bylaw_ref, sort_order: i.sort_order, status: 'not_started', notes: '', completed_date: null, uploads_allowed: i.uploads_allowed || 0, attachments: [] });
  }
  ok(res, row);
});
app.put('/api/properties/:id', (req, res) => {
  const { nickname, address, airbnb_ical_url, vrbo_ical_url, notes, welcome_message, check_in_instructions, nearby_attractions, contact_info, default_cleaner_id, public_bookable, license_status, license_renewal_date } = req.body || {};
  const row = tableUpdate('properties', req.params.id, {
    nickname,
    address: address || '',
    airbnb_ical_url: airbnb_ical_url || '',
    vrbo_ical_url: vrbo_ical_url || '',
    notes: notes || '',
    welcome_message: welcome_message || '',
    check_in_instructions: check_in_instructions || '',
    nearby_attractions: nearby_attractions || '',
    contact_info: contact_info || '',
    default_cleaner_id: default_cleaner_id ? Number(default_cleaner_id) : null,
    public_bookable: public_bookable ? 1 : 0,
    license_status: license_status || 'unlicensed',
    license_renewal_date: license_renewal_date || null,
  });
  if (!row) return err(res, 404, 'not found');
  store.bookings.filter(b => b.property_id === row.id).forEach(syncCleanerTaskForBooking);
  ok(res, row);
});
app.delete('/api/properties/:id', (req, res) => {
  cascadeDeleteProperty(req.params.id);
  tableRemove('properties', req.params.id);
  ok(res, { ok: true });
});

// ---------- BOOKING TYPES ----------
app.get('/api/booking-types', (req, res) => ok(res, tableAll('booking_types').sort((a, b) => a.name.localeCompare(b.name))));
app.post('/api/booking-types', (req, res) => {
  const { name } = req.body || {};
  if (!name) return err(res, 400, 'name required');
  if (store.booking_types.find(t => t.name.toLowerCase() === name.toLowerCase())) return err(res, 400, 'already exists');
  ok(res, tableInsert('booking_types', { name }));
});
app.delete('/api/booking-types/:id', (req, res) => {
  cascadeNullBookingType(req.params.id);
  tableRemove('booking_types', req.params.id);
  ok(res, { ok: true });
});

// ---------- GUESTS ----------
app.get('/api/guests', (req, res) => ok(res, tableAll('guests').sort((a, b) => (a.name || '').localeCompare(b.name || ''))));
app.post('/api/guests', (req, res) => {
  const { name, email, phone, address, notes } = req.body || {};
  if (!name) return err(res, 400, 'name required');
  ok(res, tableInsert('guests', { name, email: email || '', phone: phone || '', address: address || '', notes: notes || '' }));
});
app.put('/api/guests/:id', (req, res) => {
  const { name, email, phone, address, notes } = req.body || {};
  const row = tableUpdate('guests', req.params.id, { name, email: email || '', phone: phone || '', address: address || '', notes: notes || '' });
  if (!row) return err(res, 404, 'not found'); ok(res, row);
});
app.delete('/api/guests/:id', (req, res) => {
  cascadeNullGuest(req.params.id);
  tableRemove('guests', req.params.id);
  ok(res, { ok: true });
});

// ---------- BOOKINGS ----------
app.get('/api/bookings', (req, res) => {
  ok(res, tableAll('bookings').map(joinBooking).sort((a, b) => (b.check_in || '').localeCompare(a.check_in || '')));
});

function createBookingFromPayload(payload) {
  const { property_id, booking_type_id, guest_id, check_in, check_out, amount, contact_name, notes, new_guest } = payload;
  let resolvedGuestId = guest_id ? Number(guest_id) : null;
  if (!resolvedGuestId && new_guest && new_guest.name) {
    const existing = store.guests.find(g => new_guest.email && g.email && g.email.toLowerCase() === new_guest.email.toLowerCase());
    if (existing) resolvedGuestId = existing.id;
    else {
      const g = tableInsert('guests', { name: new_guest.name, email: new_guest.email || '', phone: new_guest.phone || '', address: '', notes: '' });
      resolvedGuestId = g.id;
    }
  }
  const row = tableInsert('bookings', {
    property_id: Number(property_id),
    booking_type_id: booking_type_id ? Number(booking_type_id) : null,
    guest_id: resolvedGuestId,
    check_in,
    check_out: check_out || null,
    amount: Number(amount) || 0,
    contact_name: contact_name || '',
    notes: notes || '',
    invite_sent: 0,
  });
  syncCleanerTaskForBooking(row);
  return row;
}

app.post('/api/bookings', (req, res) => {
  const b = req.body || {};
  if (!b.property_id) return err(res, 400, 'property_id required');
  if (!b.check_in) return err(res, 400, 'check_in required');
  ok(res, joinBooking(createBookingFromPayload(b)));
});

app.post('/api/bookings/bulk', (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : (req.body && req.body.rows);
  if (!Array.isArray(rows)) return err(res, 400, 'expected an array of bookings (or {rows: []})');
  const out = { inserted: 0, errors: [] };
  rows.forEach((r, idx) => {
    try {
      let propId = r.property_id ? Number(r.property_id) : null;
      if (!propId && r.property_name) {
        const p = store.properties.find(x => x.nickname.toLowerCase() === String(r.property_name).toLowerCase());
        if (p) propId = p.id;
      }
      if (!propId) throw new Error('unknown property');
      let typeId = r.booking_type_id ? Number(r.booking_type_id) : null;
      if (!typeId && r.booking_type_name) {
        let t = store.booking_types.find(x => x.name.toLowerCase() === String(r.booking_type_name).toLowerCase());
        if (!t) t = tableInsert('booking_types', { name: r.booking_type_name });
        typeId = t.id;
      }
      if (!r.check_in) throw new Error('check_in required');
      const payload = {
        property_id: propId, booking_type_id: typeId,
        check_in: r.check_in, check_out: r.check_out || null,
        amount: r.amount, contact_name: r.contact_name || '', notes: r.notes || '',
      };
      if (r.guest_email || r.guest_name) {
        payload.new_guest = { name: r.guest_name || r.contact_name || 'Guest', email: r.guest_email || '', phone: r.guest_phone || '' };
      }
      createBookingFromPayload(payload);
      out.inserted++;
    } catch (e) {
      out.errors.push({ row: idx + 1, error: e.message });
    }
  });
  ok(res, out);
});

app.put('/api/bookings/:id', (req, res) => {
  const existing = tableFind('bookings', req.params.id);
  if (!existing) return err(res, 404, 'not found');
  const { property_id, booking_type_id, guest_id, check_in, check_out, amount, contact_name, notes, invite_sent } = req.body || {};
  const row = tableUpdate('bookings', req.params.id, {
    property_id: property_id != null ? Number(property_id) : existing.property_id,
    booking_type_id: booking_type_id ? Number(booking_type_id) : (booking_type_id === null ? null : existing.booking_type_id),
    guest_id: guest_id ? Number(guest_id) : (guest_id === null ? null : existing.guest_id),
    check_in: check_in || existing.check_in,
    check_out: check_out || null,
    amount: amount != null ? Number(amount) : existing.amount,
    contact_name: contact_name != null ? contact_name : existing.contact_name,
    notes: notes != null ? notes : existing.notes,
    invite_sent: typeof invite_sent === 'number' ? invite_sent : existing.invite_sent,
  });
  syncCleanerTaskForBooking(row);
  ok(res, joinBooking(row));
});
app.delete('/api/bookings/:id', (req, res) => {
  removeCleanerTaskForBooking(req.params.id);
  tableRemove('bookings', req.params.id);
  ok(res, { ok: true });
});

// ---------- CLEANERS ----------
app.get('/api/cleaners', (req, res) => ok(res, tableAll('cleaners').sort((a, b) => (a.name || '').localeCompare(b.name || ''))));
app.post('/api/cleaners', (req, res) => {
  const { name, phone, email, rate, notes } = req.body || {};
  if (!name) return err(res, 400, 'name required');
  ok(res, tableInsert('cleaners', { name, phone: phone || '', email: email || '', rate: Number(rate) || 0, notes: notes || '' }));
});
app.put('/api/cleaners/:id', (req, res) => {
  const { name, phone, email, rate, notes } = req.body || {};
  const row = tableUpdate('cleaners', req.params.id, { name, phone: phone || '', email: email || '', rate: Number(rate) || 0, notes: notes || '' });
  if (!row) return err(res, 404, 'not found'); ok(res, row);
});
app.delete('/api/cleaners/:id', (req, res) => {
  cascadeNullCleaner(req.params.id);
  tableRemove('cleaners', req.params.id);
  ok(res, { ok: true });
});

// ---------- CLEANER TASKS ----------
function joinCleanerTask(t) {
  const c = t.cleaner_id ? tableFind('cleaners', t.cleaner_id) : null;
  const p = t.property_id ? tableFind('properties', t.property_id) : null;
  const b = t.booking_id ? tableFind('bookings', t.booking_id) : null;
  const g = b && b.guest_id ? tableFind('guests', b.guest_id) : null;
  return { ...t,
    cleaner_name: c?.name || null,
    property_name: p?.nickname || null,
    property_address: p?.address || '',
    booking_check_in: b?.check_in || null,
    booking_check_out: b?.check_out || null,
    guest_name: g?.name || (b?.contact_name || null),
  };
}
app.get('/api/cleaner-tasks', (req, res) => {
  ok(res, tableAll('cleaner_tasks').map(joinCleanerTask).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')));
});
app.post('/api/cleaner-tasks', (req, res) => {
  const { cleaner_id, property_id, due_date, notes, booking_id, status } = req.body || {};
  if (!cleaner_id || !property_id || !due_date) return err(res, 400, 'cleaner_id, property_id, due_date required');
  ok(res, joinCleanerTask(tableInsert('cleaner_tasks', {
    cleaner_id: Number(cleaner_id), property_id: Number(property_id),
    due_date, status: status || 'pending', notes: notes || '',
    booking_id: booking_id ? Number(booking_id) : null,
  })));
});
app.put('/api/cleaner-tasks/:id', (req, res) => {
  const existing = tableFind('cleaner_tasks', req.params.id);
  if (!existing) return err(res, 404, 'not found');
  const { cleaner_id, property_id, due_date, notes, status } = req.body || {};
  ok(res, joinCleanerTask(tableUpdate('cleaner_tasks', req.params.id, {
    cleaner_id: cleaner_id != null ? Number(cleaner_id) : existing.cleaner_id,
    property_id: property_id != null ? Number(property_id) : existing.property_id,
    due_date: due_date || existing.due_date,
    notes: notes != null ? notes : existing.notes,
    status: status || existing.status,
  })));
});
app.delete('/api/cleaner-tasks/:id', (req, res) => {
  tableRemove('cleaner_tasks', req.params.id);
  ok(res, { ok: true });
});

// ---------- SMS NOTIFY CLEANER ----------
app.post('/api/cleaner-tasks/:id/notify', async (req, res) => {
  try {
    if (!twilioClient) return err(res, 503, 'SMS disabled - Twilio not configured (.env missing TWILIO_* vars)');
    const task = tableFind('cleaner_tasks', req.params.id);
    if (!task) return err(res, 404, 'task not found');
    const cleaner = task.cleaner_id ? tableFind('cleaners', task.cleaner_id) : null;
    if (!cleaner) return err(res, 400, 'no cleaner assigned to this task');
    if (!cleaner.phone) return err(res, 400, 'cleaner has no phone number on file');

    // Format the phone number — ensure it starts with +1 for North America
    let phone = cleaner.phone.replace(/[\s\-().]/g, '');
    if (!phone.startsWith('+')) phone = phone.startsWith('1') ? '+' + phone : '+1' + phone;

    const property = task.property_id ? tableFind('properties', task.property_id) : null;
    const propName = property ? property.nickname : 'a property';
    const dueDate = task.due_date || 'TBD';
    const taskNotes = task.notes ? `\nNotes: ${task.notes}` : '';

    const body = `Hi ${cleaner.name}, you have a cleaning scheduled at ${propName} on ${dueDate}.${taskNotes}\n\nPlease confirm when you're available. Thanks!`;

    const message = await twilioClient.messages.create({
      body,
      from: TWILIO_FROM,
      to: phone,
      statusCallback: 'https://demo.twilio.com/welcome/sms/reply/',
    });

    // Track that we notified
    tableUpdate('cleaner_tasks', task.id, { notified_at: nowIso(), notify_sid: message.sid });
    ok(res, { ok: true, sid: message.sid, to: phone });
  } catch (e) {
    console.error('SMS error:', e.message);
    err(res, 500, 'Failed to send SMS: ' + e.message);
  }
});

// ---------- GUEST SMS ----------
app.post('/api/bookings/:id/notify-guest', async (req, res) => {
  try {
    if (!twilioClient) return err(res, 503, 'SMS disabled - Twilio not configured (.env missing TWILIO_* vars)');
    const booking = tableFind('bookings', req.params.id);
    if (!booking) return err(res, 404, 'booking not found');
    const guest = booking.guest_id ? tableFind('guests', booking.guest_id) : null;
    if (!guest) return err(res, 400, 'no guest linked to this booking');
    if (!guest.phone) return err(res, 400, 'guest has no phone number on file');

    const property = booking.property_id ? tableFind('properties', booking.property_id) : null;
    if (!property) return err(res, 400, 'no property linked to this booking');

    let phone = guest.phone.replace(/[\s\-().]/g, '');
    if (!phone.startsWith('+')) phone = phone.startsWith('1') ? '+' + phone : '+1' + phone;

    const { message_type, custom_message } = req.body || {};
    const greeting = `Hi ${guest.name || 'there'}! `;
    let body = '';

    switch (message_type) {
      case 'welcome':
        body = greeting + (property.welcome_message || 'Welcome to ' + property.nickname + '!');
        break;
      case 'check_in':
        body = greeting + 'CHECK-IN INSTRUCTIONS for ' + property.nickname + ':\n' + (property.check_in_instructions || '(not configured yet)');
        break;
      case 'attractions':
        body = greeting + 'NEARBY ATTRACTIONS around ' + property.nickname + ':\n' + (property.nearby_attractions || '(not configured yet)');
        break;
      case 'contact':
        body = greeting + 'CONTACT INFO for your stay at ' + property.nickname + ':\n' + (property.contact_info || '(not configured yet)');
        break;
      case 'custom':
        if (!custom_message) return err(res, 400, 'custom_message is required for custom type');
        body = greeting + custom_message;
        break;
      case 'all':
      default: {
        const parts = [];
        if (property.welcome_message) parts.push(property.welcome_message);
        if (property.check_in_instructions) parts.push('CHECK-IN INSTRUCTIONS:\n' + property.check_in_instructions);
        if (property.nearby_attractions) parts.push('NEARBY ATTRACTIONS:\n' + property.nearby_attractions);
        if (property.contact_info) parts.push('CONTACT US:\n' + property.contact_info);
        if (!parts.length) return err(res, 400, 'no guest messages configured for this property — add them in the property settings');
        body = greeting + 'Welcome to ' + property.nickname + '. Your stay: ' + (booking.check_in || '?') + ' → ' + (booking.check_out || '?') + '.\n\n' + parts.join('\n\n');
        break;
      }
    }

    const message = await twilioClient.messages.create({
      body,
      from: TWILIO_FROM,
      to: phone,
    });

    tableInsert('sms_messages', {
      direction: 'outbound',
      from_number: TWILIO_FROM,
      to_number: phone,
      body,
      twilio_sid: message.sid,
      guest_id: guest.id,
      booking_id: booking.id,
      property_id: property.id,
      sent_at: nowIso(),
    });

    tableUpdate('bookings', booking.id, { guest_notified_at: nowIso() });
    ok(res, { ok: true, sid: message.sid, to: phone });
  } catch (e) {
    console.error('Guest SMS error:', e.message);
    err(res, 500, 'Failed to send SMS: ' + e.message);
  }
});

// ---------- INCOMING SMS WEBHOOK ----------
// Twilio will POST here when someone replies. Must be publicly accessible (use ngrok/cloudflare tunnel).
app.post('/api/twilio/incoming', express.urlencoded({ extended: false }), (req, res) => {
  const { From, To, Body, MessageSid } = req.body || {};
  console.log(`Incoming SMS from ${From}: ${Body}`);

  // Try to match sender to a guest or cleaner by phone number
  const normalizedFrom = (From || '').replace(/[\s\-().]/g, '');
  const guest = store.guests.find(g => {
    if (!g.phone) return false;
    let p = g.phone.replace(/[\s\-().]/g, '');
    if (!p.startsWith('+')) p = p.startsWith('1') ? '+' + p : '+1' + p;
    return p === normalizedFrom;
  });
  const cleaner = store.cleaners.find(c => {
    if (!c.phone) return false;
    let p = c.phone.replace(/[\s\-().]/g, '');
    if (!p.startsWith('+')) p = p.startsWith('1') ? '+' + p : '+1' + p;
    return p === normalizedFrom;
  });

  tableInsert('sms_messages', {
    direction: 'inbound',
    from_number: From || '',
    to_number: To || '',
    body: Body || '',
    twilio_sid: MessageSid || '',
    guest_id: guest ? guest.id : null,
    cleaner_id: cleaner ? cleaner.id : null,
    received_at: nowIso(),
    read: false,
  });

  // Respond with empty TwiML (acknowledge receipt, no auto-reply)
  res.type('text/xml');
  res.send('<Response></Response>');
});

// ---------- SMS MESSAGES API ----------
app.get('/api/sms-messages', (req, res) => {
  const { guest_id, cleaner_id } = req.query;
  let rows = tableAll('sms_messages');
  if (guest_id) rows = rows.filter(r => r.guest_id === Number(guest_id));
  if (cleaner_id) rows = rows.filter(r => r.cleaner_id === Number(cleaner_id));
  // Attach names
  rows = rows.map(m => {
    const g = m.guest_id ? tableFind('guests', m.guest_id) : null;
    const c = m.cleaner_id ? tableFind('cleaners', m.cleaner_id) : null;
    return { ...m, guest_name: g?.name || null, cleaner_name: c?.name || null };
  }).sort((a, b) => ((b.sent_at || b.received_at || '')).localeCompare(a.sent_at || a.received_at || ''));
  ok(res, rows);
});
app.put('/api/sms-messages/:id/read', (req, res) => {
  ok(res, tableUpdate('sms_messages', req.params.id, { read: true }));
});

// ---------- MAINTENANCE ----------
app.get('/api/maintenance', (req, res) => {
  const { property_id } = req.query;
  let rows = tableAll('maintenance_items');
  if (property_id) rows = rows.filter(r => r.property_id === Number(property_id));
  rows = rows
    .map(r => ({ ...r, property_name: tableFind('properties', r.property_id)?.nickname || null }))
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.item_name || '').localeCompare(b.item_name || ''));
  ok(res, rows);
});
app.post('/api/maintenance', (req, res) => {
  const { property_id, item_name, category, in_stock, notes } = req.body || {};
  if (!property_id || !item_name) return err(res, 400, 'property_id and item_name required');
  ok(res, tableInsert('maintenance_items', {
    property_id: Number(property_id), item_name, category: category || '',
    in_stock: in_stock ? 1 : 0, notes: notes || '',
  }));
});
app.put('/api/maintenance/:id', (req, res) => {
  const { item_name, category, in_stock, notes } = req.body || {};
  const row = tableUpdate('maintenance_items', req.params.id, {
    item_name, category: category || '', in_stock: in_stock ? 1 : 0, notes: notes || '',
  });
  if (!row) return err(res, 404, 'not found'); ok(res, row);
});
app.delete('/api/maintenance/:id', (req, res) => {
  tableRemove('maintenance_items', req.params.id);
  ok(res, { ok: true });
});

// ---------- SYNC (Airbnb / VRBO iCal) ----------
async function fetchAndStoreIcal(property, source, url) {
  if (!url) return { source, count: 0, skipped: true };
  const events = await ical.async.fromURL(url);
  store.synced_events = store.synced_events.filter(e => !(e.property_id === property.id && e.source === source));
  let count = 0;
  for (const k of Object.keys(events)) {
    const e = events[k];
    if (!e || e.type !== 'VEVENT') continue;
    const start = e.start ? new Date(e.start).toISOString().slice(0, 10) : null;
    const end = e.end ? new Date(e.end).toISOString().slice(0, 10) : null;
    if (!start) continue;
    tableInsert('synced_events', {
      property_id: property.id, source, uid: e.uid || k, summary: e.summary || '',
      start_date: start, end_date: end, last_synced: nowIso(),
    });
    count++;
  }
  saveStore();
  return { source, count };
}
app.post('/api/sync/:propertyId', async (req, res) => {
  const property = tableFind('properties', req.params.propertyId);
  if (!property) return err(res, 404, 'property not found');
  try {
    const results = [];
    if (property.airbnb_ical_url) results.push(await fetchAndStoreIcal(property, 'airbnb', property.airbnb_ical_url));
    if (property.vrbo_ical_url) results.push(await fetchAndStoreIcal(property, 'vrbo', property.vrbo_ical_url));
    ok(res, { property_id: property.id, results });
  } catch (e) { err(res, 500, 'Sync failed: ' + e.message); }
});
app.post('/api/sync-all', async (req, res) => {
  const out = [];
  for (const p of tableAll('properties')) {
    try {
      const r = [];
      if (p.airbnb_ical_url) r.push(await fetchAndStoreIcal(p, 'airbnb', p.airbnb_ical_url));
      if (p.vrbo_ical_url) r.push(await fetchAndStoreIcal(p, 'vrbo', p.vrbo_ical_url));
      out.push({ property_id: p.id, nickname: p.nickname, results: r });
    } catch (e) { out.push({ property_id: p.id, nickname: p.nickname, error: e.message }); }
  }
  ok(res, out);
});

// ---------- CALENDAR ----------
app.get('/api/calendar', (req, res) => {
  const events = [];
  for (const b of tableAll('bookings').map(joinBooking)) {
    events.push({
      kind: 'booking', id: 'b' + b.id,
      property_id: b.property_id, property_name: b.property_name,
      title: `${b.property_name || 'Property'} — ${b.guest_name || b.contact_name || 'Booking'}`,
      start: b.check_in, end: b.check_out || b.check_in,
      source: b.booking_type_name || 'Manual', amount: b.amount,
    });
  }
  for (const s of tableAll('synced_events')) {
    const p = tableFind('properties', s.property_id);
    events.push({
      kind: 'synced', id: 's' + s.id,
      property_id: s.property_id, property_name: p?.nickname || null,
      title: `${p?.nickname || 'Property'} — ${s.summary || s.source}`,
      start: s.start_date, end: s.end_date, source: s.source,
    });
  }
  events.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  ok(res, events);
});

// ---------- DASHBOARD ----------
function daysBetween(a, b) {
  const ms = new Date(b) - new Date(a);
  return Math.max(1, Math.round(ms / 86400000));
}
function bookingNightsInMonth(booking, year, monthIdx) {
  const start = booking.check_in ? new Date(booking.check_in) : null;
  const end = booking.check_out ? new Date(booking.check_out) : start;
  if (!start) return 0;
  const monthStart = new Date(year, monthIdx, 1);
  const monthEnd = new Date(year, monthIdx + 1, 1);
  const a = start < monthStart ? monthStart : start;
  const b = end > monthEnd ? monthEnd : end;
  if (b <= a) return 0;
  return Math.round((b - a) / 86400000);
}

app.get('/api/dashboard', (req, res) => {
  const now = new Date();
  const year = now.getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const todayIso = now.toISOString().slice(0, 10);

  const allBookings = tableAll('bookings').map(joinBooking);
  const ytdBookings = allBookings.filter(b => b.check_in >= yearStart && b.check_in <= yearEnd);
  const ytdEarnings = ytdBookings.reduce((a, b) => a + (b.amount || 0), 0);
  const allTimeEarnings = allBookings.reduce((a, b) => a + (b.amount || 0), 0);

  const types = tableAll('booking_types');
  const byType = types.map(t => {
    const list = ytdBookings.filter(b => b.booking_type_id === t.id);
    return { type: t.name, bookings: list.length, earnings: list.reduce((a, b) => a + (b.amount || 0), 0) };
  }).sort((a, b) => b.earnings - a.earnings);

  const elapsedDays = daysBetween(yearStart, todayIso);
  const byProperty = tableAll('properties').map(p => {
    const list = ytdBookings.filter(b => b.property_id === p.id);
    const earnings = list.reduce((a, b) => a + (b.amount || 0), 0);
    let nights = 0;
    list.forEach(b => { if (b.check_in) nights += daysBetween(b.check_in, b.check_out || b.check_in); });
    const occupancy = elapsedDays > 0 ? +(nights / elapsedDays).toFixed(3) : 0;
    const revpar = elapsedDays > 0 ? +(earnings / elapsedDays).toFixed(2) : 0;
    const adr = nights > 0 ? +(earnings / nights).toFixed(2) : 0;
    return { id: p.id, nickname: p.nickname, bookings: list.length, earnings, nights, occupancy, revpar, adr };
  }).sort((a, b) => b.earnings - a.earnings);

  const upcoming = allBookings
    .filter(b => b.check_in >= todayIso)
    .sort((a, b) => (a.check_in || '').localeCompare(b.check_in || ''))
    .slice(0, 10);

  let totalNightsYtd = 0;
  ytdBookings.forEach(b => { if (b.check_in) totalNightsYtd += daysBetween(b.check_in, b.check_out || b.check_in); });

  const propertyCount = Math.max(1, store.properties.length);
  const vacancyByMonth = [];
  for (let m = 0; m < 12; m++) {
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    let occupied = 0;
    ytdBookings.forEach(b => { occupied += bookingNightsInMonth(b, year, m); });
    const available = daysInMonth * propertyCount;
    const occupancy = available > 0 ? +(occupied / available).toFixed(3) : 0;
    vacancyByMonth.push({
      month: m + 1,
      label: new Date(year, m, 1).toLocaleString('en-US', { month: 'short' }),
      occupied_nights: occupied,
      available_nights: available,
      occupancy_rate: occupancy,
      vacancy_rate: +(1 - occupancy).toFixed(3),
    });
  }

  const lowStockCount = tableAll('maintenance_items').filter(i => !i.in_stock).length;
  const pendingRequests = tableAll('booking_requests').filter(r => r.status === 'pending').length;

  // Licensing summary
  const allLicItems = tableAll('licensing_items');
  const licensedProps = store.properties.filter(p => p.license_status === 'licensed').length;
  const totalProps = store.properties.length;
  const pendingLicSteps = allLicItems.filter(l => l.status !== 'complete').length;
  const upcomingRenewals = store.properties.filter(p => {
    if (!p.license_renewal_date) return false;
    const diff = new Date(p.license_renewal_date) - now;
    return diff >= 0 && diff <= 90 * 86400000; // within 90 days
  }).length;

  // Upcoming + high-priority-no-date todos
  const inAWeek = new Date(now); inAWeek.setDate(inAWeek.getDate() + 7);
  const inAWeekIso = inAWeek.toISOString().slice(0, 10);
  const openTodos = tableAll('todos').filter(t => t.status === 'open').map(joinTodo);
  const upcomingTodos = openTodos
    .filter(t => (t.due_date && t.due_date <= inAWeekIso) || (t.priority === 'high' && !t.due_date))
    .sort((a, b) => {
      // overdue first (due_date < today), then by date ascending, then high-priority no-date last
      const aOver = a.due_date && a.due_date < todayIso ? 0 : 1;
      const bOver = b.due_date && b.due_date < todayIso ? 0 : 1;
      if (aOver !== bOver) return aOver - bOver;
      const ad = a.due_date || '9999-12-31';
      const bd = b.due_date || '9999-12-31';
      if (ad !== bd) return ad.localeCompare(bd);
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.priority] || 1) - (order[b.priority] || 1);
    })
    .slice(0, 8);

  const overdueTodoCount = openTodos.filter(t => t.due_date && t.due_date < todayIso).length;

  ok(res, {
    year,
    ytd_earnings: ytdEarnings,
    ytd_bookings: ytdBookings.length,
    ytd_nights: totalNightsYtd,
    avg_per_booking_ytd: ytdBookings.length ? +(ytdEarnings / ytdBookings.length).toFixed(2) : 0,
    all_time_earnings: allTimeEarnings,
    all_time_bookings: allBookings.length,
    by_type: byType,
    by_property: byProperty,
    upcoming,
    low_stock_count: lowStockCount,
    pending_requests: pendingRequests,
    vacancy_by_month: vacancyByMonth,
    elapsed_days_ytd: elapsedDays,
    upcoming_todos: upcomingTodos,
    overdue_todo_count: overdueTodoCount,
    open_todo_count: openTodos.length,
    licensed_properties: licensedProps,
    total_properties: totalProps,
    pending_licensing_steps: pendingLicSteps,
    upcoming_renewals: upcomingRenewals,
  });
});

// ---------- MAILING LIST ----------
app.get('/api/mailing-list', (req, res) => {
  const allBookings = tableAll('bookings').map(joinBooking);
  const now = new Date();
  const out = tableAll('guests').map(g => {
    const stays = allBookings.filter(b => b.guest_id === g.id).sort((a, b) => (b.check_in || '').localeCompare(a.check_in || ''));
    const last = stays[0];
    const monthsSince = last && last.check_in
      ? Math.floor((now - new Date(last.check_in)) / (1000 * 60 * 60 * 24 * 30.4375))
      : null;
    return {
      guest_id: g.id,
      guest_name: g.name,
      guest_email: g.email,
      guest_phone: g.phone,
      total_stays: stays.length,
      total_spent: stays.reduce((a, s) => a + (s.amount || 0), 0),
      last_booking_id: last ? last.id : null,
      last_check_in: last ? last.check_in : null,
      last_property_id: last ? last.property_id : null,
      last_property_name: last ? last.property_name : null,
      last_booking_type: last ? last.booking_type_name : null,
      months_since_last: monthsSince,
      invite_sent: last ? (last.invite_sent || 0) : 0,
    };
  }).filter(r => r.total_stays > 0 || r.guest_email)
    .sort((a, b) => (b.last_check_in || '').localeCompare(a.last_check_in || ''));
  ok(res, out);
});

// ---------- TO-DO TASKS ----------
function joinTodo(t) {
  const p = t.property_id ? tableFind('properties', t.property_id) : null;
  return { ...t, property_name: p?.nickname || null };
}
const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);
const VALID_TODO_STATUSES = new Set(['open', 'done']);

app.get('/api/todos', (req, res) => {
  ok(res, tableAll('todos').map(joinTodo).sort((a, b) => {
    // Open tasks first, then by due date, then high priority first
    if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
    const ad = a.due_date || '9999-12-31';
    const bd = b.due_date || '9999-12-31';
    if (ad !== bd) return ad.localeCompare(bd);
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.priority] || 1) - (order[b.priority] || 1);
  }));
});

app.post('/api/todos', (req, res) => {
  const { title, description, priority, due_date, property_id, status } = req.body || {};
  if (!title) return err(res, 400, 'title required');
  const pri = VALID_PRIORITIES.has(priority) ? priority : 'medium';
  const st = VALID_TODO_STATUSES.has(status) ? status : 'open';
  ok(res, joinTodo(tableInsert('todos', {
    title,
    description: description || '',
    priority: pri,
    due_date: due_date || null,
    property_id: property_id ? Number(property_id) : null,
    status: st,
    completed_at: st === 'done' ? nowIso() : null,
  })));
});

app.put('/api/todos/:id', (req, res) => {
  const existing = tableFind('todos', req.params.id);
  if (!existing) return err(res, 404, 'not found');
  const { title, description, priority, due_date, property_id, status } = req.body || {};
  const newStatus = status && VALID_TODO_STATUSES.has(status) ? status : existing.status;
  const justCompleted = newStatus === 'done' && existing.status !== 'done';
  const justReopened = newStatus === 'open' && existing.status === 'done';
  ok(res, joinTodo(tableUpdate('todos', req.params.id, {
    title: title != null ? title : existing.title,
    description: description != null ? description : existing.description,
    priority: priority && VALID_PRIORITIES.has(priority) ? priority : existing.priority,
    due_date: due_date === '' ? null : (due_date != null ? due_date : existing.due_date),
    property_id: property_id === '' || property_id === null ? null : (property_id != null ? Number(property_id) : existing.property_id),
    status: newStatus,
    completed_at: justCompleted ? nowIso() : (justReopened ? null : existing.completed_at),
  })));
});

app.delete('/api/todos/:id', (req, res) => {
  tableRemove('todos', req.params.id);
  ok(res, { ok: true });
});

// ---------- LICENSING ----------
function joinLicensingItem(l) {
  const p = l.property_id ? tableFind('properties', l.property_id) : null;
  return { ...l, property_name: p?.nickname || null };
}
app.get('/api/licensing', (req, res) => {
  const { property_id } = req.query;
  let rows = tableAll('licensing_items');
  if (property_id) rows = rows.filter(r => r.property_id === Number(property_id));
  rows = rows.map(joinLicensingItem).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  ok(res, rows);
});
app.post('/api/licensing', (req, res) => {
  const { property_id, step_name, description, bylaw_ref, sort_order, status, notes, uploads_allowed } = req.body || {};
  if (!property_id || !step_name) return err(res, 400, 'property_id and step_name required');
  ok(res, joinLicensingItem(tableInsert('licensing_items', {
    property_id: Number(property_id), step_name, description: description || '',
    bylaw_ref: bylaw_ref || '', sort_order: sort_order || 99,
    status: status || 'not_started', notes: notes || '', completed_date: null,
    uploads_allowed: uploads_allowed ? 1 : 0, attachments: [],
  })));
});
app.put('/api/licensing/:id', (req, res) => {
  const existing = tableFind('licensing_items', req.params.id);
  if (!existing) return err(res, 404, 'not found');
  const { step_name, description, bylaw_ref, sort_order, status, notes } = req.body || {};
  const newStatus = status || existing.status;
  const justCompleted = newStatus === 'complete' && existing.status !== 'complete';
  const justUncompleted = newStatus !== 'complete' && existing.status === 'complete';
  ok(res, joinLicensingItem(tableUpdate('licensing_items', req.params.id, {
    step_name: step_name != null ? step_name : existing.step_name,
    description: description != null ? description : existing.description,
    bylaw_ref: bylaw_ref != null ? bylaw_ref : existing.bylaw_ref,
    sort_order: sort_order != null ? sort_order : existing.sort_order,
    status: newStatus,
    notes: notes != null ? notes : existing.notes,
    completed_date: justCompleted ? nowIso() : (justUncompleted ? null : existing.completed_date),
  })));
});
app.delete('/api/licensing/:id', (req, res) => {
  tableRemove('licensing_items', req.params.id);
  ok(res, { ok: true });
});
// Seed licensing items for an existing property that has none
app.post('/api/licensing/seed/:propertyId', (req, res) => {
  const property = tableFind('properties', req.params.propertyId);
  if (!property) return err(res, 404, 'property not found');
  const existing = store.licensing_items.filter(l => l.property_id === property.id);
  if (existing.length > 0) return err(res, 400, 'licensing items already exist for this property');
  for (const i of DEFAULT_LICENSING_ITEMS) {
    tableInsert('licensing_items', { property_id: property.id, step_name: i.step_name, description: i.description, bylaw_ref: i.bylaw_ref, sort_order: i.sort_order, status: 'not_started', notes: '', completed_date: null, uploads_allowed: i.uploads_allowed || 0, attachments: [] });
  }
  ok(res, { ok: true, count: DEFAULT_LICENSING_ITEMS.length });
});


// ---------- LICENSING FILE UPLOADS ----------
app.post('/api/licensing/:id/upload', upload.array('files', 10), (req, res) => {
  const item = tableFind('licensing_items', req.params.id);
  if (!item) return err(res, 404, 'licensing item not found');
  if (!item.uploads_allowed) return err(res, 400, 'this step does not support file uploads');
  if (!req.files || !req.files.length) return err(res, 400, 'no files uploaded');
  const newAttachments = req.files.map(f => ({
    filename: f.filename,
    original_name: f.originalname,
    size: f.size,
    mime_type: f.mimetype,
    uploaded_at: nowIso(),
  }));
  const attachments = [...(item.attachments || []), ...newAttachments];
  const updated = tableUpdate('licensing_items', item.id, { attachments });
  ok(res, joinLicensingItem(updated));
});

app.delete('/api/licensing/:id/upload/:filename', (req, res) => {
  const item = tableFind('licensing_items', req.params.id);
  if (!item) return err(res, 404, 'licensing item not found');
  const filename = req.params.filename;
  const attachments = (item.attachments || []).filter(a => a.filename !== filename);
  const filePath = path.join(UPLOADS_DIR, filename);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
  const updated = tableUpdate('licensing_items', item.id, { attachments });
  ok(res, joinLicensingItem(updated));
});

// ---------- BOOKING REQUESTS ----------
function joinBookingRequest(r) {
  const p = r.property_id ? tableFind('properties', r.property_id) : null;
  return { ...r, property_name: p?.nickname || null };
}
app.get('/api/booking-requests', (req, res) => {
  ok(res, tableAll('booking_requests').map(joinBookingRequest).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')));
});
app.put('/api/booking-requests/:id/approve', (req, res) => {
  const r = tableFind('booking_requests', req.params.id);
  if (!r) return err(res, 404, 'not found');
  let guest = store.guests.find(g => g.email && r.guest_email && g.email.toLowerCase() === r.guest_email.toLowerCase());
  if (!guest) guest = tableInsert('guests', { name: r.guest_name, email: r.guest_email, phone: r.guest_phone || '', address: '', notes: '' });
  const booking = createBookingFromPayload({
    property_id: r.property_id,
    guest_id: guest.id,
    check_in: r.check_in,
    check_out: r.check_out,
    amount: r.proposed_amount || 0,
    contact_name: r.guest_name,
    notes: 'From returning-guest booking page. Original message: ' + (r.message || ''),
    booking_type_id: store.booking_types.find(t => t.name === 'Private')?.id || null,
  });
  tableUpdate('booking_requests', r.id, { status: 'approved', approved_booking_id: booking.id });
  ok(res, { request: tableFind('booking_requests', r.id), booking: joinBooking(booking) });
});
app.put('/api/booking-requests/:id/reject', (req, res) => {
  const r = tableFind('booking_requests', req.params.id);
  if (!r) return err(res, 404, 'not found');
  ok(res, tableUpdate('booking_requests', r.id, { status: 'rejected' }));
});
app.delete('/api/booking-requests/:id', (req, res) => {
  tableRemove('booking_requests', req.params.id);
  ok(res, { ok: true });
});

// ---------- PUBLIC API ----------
app.get('/api/public/properties', (req, res) => {
  ok(res, tableAll('properties').filter(p => p.public_bookable).map(p => ({
    id: p.id, nickname: p.nickname, address: p.address, welcome_message: p.welcome_message,
  })));
});
app.post('/api/public/guest-lookup', (req, res) => {
  const email = (req.body && req.body.email || '').toLowerCase().trim();
  if (!email) return err(res, 400, 'email required');
  const guest = store.guests.find(g => g.email && g.email.toLowerCase() === email);
  if (!guest) return ok(res, { found: false });
  const stays = tableAll('bookings').filter(b => b.guest_id === guest.id)
    .map(joinBooking)
    .sort((a, b) => (b.check_in || '').localeCompare(a.check_in || ''))
    .map(b => ({ property_id: b.property_id, property_name: b.property_name, check_in: b.check_in, check_out: b.check_out }));
  ok(res, { fo