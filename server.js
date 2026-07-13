// Short-Term Rental Tracker — Express + JSON-file store backend.
// No native deps; runs anywhere Node 18+ is installed.
// Run: npm install && npm start  (then open http://localhost:3004)
//
// Twilio creds are loaded from a local .env (gitignored). Copy
// .env.example to .env and fill in your real values before running.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

const PORT = process.env.PORT || 3004;

// Twilio SMS config (env-only - never commit real values)
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_FROM || '';
const twilioClient = (TWILIO_SID && TWILIO_AUTH) ? twilio(TWILIO_SID, TWILIO_AUTH) : null;
if (!twilioClient) {
  console.warn('[startup] Twilio creds not set - SMS features disabled. Copy .env.example to .env and fill in values.');
}
// Licensing attachments live in the private Supabase Storage bucket (below), so files are
// held in memory just long enough to upload — no local disk, serverless-safe.
const UPLOAD_BUCKET = 'rental-uploads';

// In-memory upload (file.buffer) — streamed straight to Supabase Storage.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20 MB max

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

// ---------- SUPABASE-BACKED STORE ----------
// Single-process design: an in-memory `store` (same shape the app always used) is the
// working copy; every mutation is also streamed to Supabase Postgres through a serialized,
// non-blocking write queue so reads stay synchronous and no endpoint code had to change.
// NOTE: this assumes ONE always-on server instance (Render/Railway/local). A multi-instance
// or serverless (Vercel) deploy would need per-request reads instead — see Phase 5.
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || SUPABASE_SERVICE_ROLE_KEY.startsWith('PASTE_')) {
  console.error('[startup] Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env — cannot start.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TABLE_KEYS = ['properties','booking_types','guests','cleaners','bookings','maintenance_items','synced_events','cleaner_tasks','booking_requests','todos','licensing_items','sms_messages','manual_blocks','expenses','upsells','booking_upsells','reviews','message_templates','settings','price_cache','ltr_applicants'];
const tbl = k => 'rental_' + k;
// Whitelisted columns per table — strips any computed/extra props before writing to Postgres.
const COLS = {
  properties: ['id','created_at','nickname','address','airbnb_ical_url','vrbo_ical_url','notes','welcome_message','default_cleaner_id','public_bookable','license_status','license_renewal_date','check_in_instructions','nearby_attractions','contact_info','pricelabs_listing_id','pricelabs_pms','ical_token','ltr_listed','ltr_status','ltr_description','ltr_rent','ltr_available_date','ltr_lease_terms','ltr_photos','ltr_secured_applicant_id'],
  booking_types: ['id','created_at','name','fee_percent','is_direct','fee_fixed'],
  guests: ['id','created_at','name','email','phone','address','notes'],
  cleaners: ['id','created_at','name','phone','email','rate','notes'],
  bookings: ['id','created_at','property_id','booking_type_id','guest_id','check_in','check_out','amount','contact_name','notes','invite_sent','source_uid','guest_notified_at','door_code','status'],
  maintenance_items: ['id','created_at','property_id','item_name','category','in_stock','notes'],
  synced_events: ['id','created_at','property_id','source','uid','summary','start_date','end_date','last_synced'],
  cleaner_tasks: ['id','created_at','cleaner_id','property_id','booking_id','due_date','status','notes','notified_at','notify_sid'],
  booking_requests: ['id','created_at','property_id','guest_name','guest_email','guest_phone','check_in','check_out','guests_count','message','status','approved_booking_id'],
  todos: ['id','created_at','title','description','priority','due_date','property_id','status','completed_at'],
  licensing_items: ['id','created_at','property_id','step_name','description','bylaw_ref','sort_order','status','notes','completed_date','attachments','uploads_allowed'],
  sms_messages: ['id','created_at','direction','from_number','to_number','body','twilio_sid','guest_id','cleaner_id','property_id','received_at','sent_at','read','booking_id','stage'],
  manual_blocks: ['id','created_at','property_id','start_date','end_date','reason'],
  expenses: ['id','created_at','property_id','date','category','amount','vendor','notes','recurring'],
  upsells: ['id','created_at','name','default_price','active'],
  booking_upsells: ['id','created_at','booking_id','name','price','qty'],
  reviews: ['id','created_at','booking_id','property_id','platform','rating','text','review_date'],
  message_templates: ['id','created_at','stage','channel','subject','body','enabled','offset_days','send_hour'],
  settings: ['id','created_at','key','value'],
  price_cache: ['id','created_at','property_id','date','recommended_price','user_price','min_stay','demand','currency','fetched_at'],
  ltr_applicants: ['id','created_at','property_id','name','email','phone','current_address','employer','job_title','annual_income','credit_score','occupants','pets','desired_move_in','references_info','notes','status'],
};
function pickCols(table, row) {
  const allow = COLS[table]; if (!allow) return row;
  const out = {}; for (const c of allow) if (row[c] !== undefined) out[c] = row[c];
  return out;
}

// Per-request store (serverless-safe). Each /api request loads a fresh snapshot of all
// rental_* tables into a request-scoped context (AsyncLocalStorage). Reads are synchronous
// against that snapshot; writes mutate the snapshot AND queue a Supabase op that is flushed
// BEFORE the response is sent. Safe on Vercel serverless (no shared cross-instance memory).
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
function ctx() { return als.getStore(); }

const NUMERIC = {
  bookings: ['amount'], cleaners: ['rate'], expenses: ['amount'], upsells: ['default_price'],
  booking_upsells: ['price', 'qty'], reviews: ['rating'], booking_types: ['fee_percent', 'fee_fixed'],
  price_cache: ['recommended_price', 'user_price'],
  properties: ['ltr_rent'], ltr_applicants: ['annual_income', 'credit_score'],
};
async function loadSnapshot() {
  const snap = { next_id: {} };
  await Promise.all(TABLE_KEYS.map(async (k) => {
    const { data, error } = await supabase.from(tbl(k)).select('*').order('id', { ascending: true });
    if (error) throw new Error(`load ${k}: ${error.message}`);
    const rows = data || [];
    (NUMERIC[k] || []).forEach(f => rows.forEach(r => { if (r[f] != null) r[f] = Number(r[f]); }));
    snap[k] = rows;
    snap.next_id[k] = rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
  }));
  return snap;
}

// `store` proxies to the active request's snapshot so all existing `store.x` code works unchanged.
const store = new Proxy({}, {
  get(_, k) { const c = ctx(); return c ? c.store[k] : undefined; },
  set(_, k, v) { const c = ctx(); if (c) c.store[k] = v; return true; },
});

// Per-request write queue, applied in order and awaited before the response is sent.
function enqueueWrite(fn, label) { const c = ctx(); if (c) c.pending.push({ fn, label }); }
async function flushCtx(c) {
  if (!c || c._flushed) return; c._flushed = true;
  for (const w of c.pending) {
    try { await w.fn(); } catch (e) { throw new Error(w.label + ': ' + (e && e.message || e)); }
  }
  c.pending = [];
}
function flushWrites() { const c = ctx(); return c ? flushCtx(c) : Promise.resolve(); }
// Run a function inside a fresh request context (used by the local scheduler / seeding).
async function withContext(fn) {
  const snap = await loadSnapshot();
  const c = { store: snap, pending: [] };
  return als.run(c, async () => { const r = await fn(); await flushCtx(c); return r; });
}

const nowIso = () => new Date().toISOString();
function nextId(table) { return ctx().store.next_id[table]++; }
function tableInsert(table, row) {
  const id = nextId(table);
  const newRow = { id, created_at: nowIso(), ...row };
  store[table].push(newRow);
  enqueueWrite(async () => {
    const { error } = await supabase.from(tbl(table)).insert(pickCols(table, newRow));
    if (error) throw error;
  }, `insert ${table} #${id}`);
  return newRow;
}
function tableUpdate(table, id, patch) {
  const idx = store[table].findIndex(r => r.id === Number(id));
  if (idx < 0) return null;
  store[table][idx] = { ...store[table][idx], ...patch };
  enqueueWrite(async () => {
    const { error } = await supabase.from(tbl(table)).update(pickCols(table, patch)).eq('id', Number(id));
    if (error) throw error;
  }, `update ${table} #${id}`);
  return store[table][idx];
}
function tableRemove(table, id) {
  const before = store[table].length;
  store[table] = store[table].filter(r => r.id !== Number(id));
  enqueueWrite(async () => {
    const { error } = await supabase.from(tbl(table)).delete().eq('id', Number(id));
    if (error) throw error;
  }, `delete ${table} #${id}`);
  return before - store[table].length;
}
function tableFind(table, id) { return store[table].find(r => r.id === Number(id)) || null; }
function tableAll(table) { return store[table].slice(); }
function saveStore() { /* no-op: each mutation streams to Supabase via enqueueWrite */ }

function cascadeDeleteProperty(propertyId) {
  const pid = Number(propertyId);
  store.bookings = store.bookings.filter(b => b.property_id !== pid);
  store.maintenance_items = store.maintenance_items.filter(m => m.property_id !== pid);
  store.synced_events = store.synced_events.filter(s => s.property_id !== pid);
  store.manual_blocks = store.manual_blocks.filter(b => b.property_id !== pid);
  store.cleaner_tasks = store.cleaner_tasks.filter(c => c.property_id !== pid);
  store.booking_requests = store.booking_requests.filter(r => r.property_id !== pid);
  store.licensing_items = store.licensing_items.filter(l => l.property_id !== pid);
  store.todos.forEach(t => { if (t.property_id === pid) t.property_id = null; });
  enqueueWrite(async () => {
    for (const k of ['bookings','maintenance_items','synced_events','manual_blocks','cleaner_tasks','booking_requests','licensing_items']) {
      const { error } = await supabase.from(tbl(k)).delete().eq('property_id', pid);
      if (error) throw error;
    }
    const { error } = await supabase.from(tbl('todos')).update({ property_id: null }).eq('property_id', pid);
    if (error) throw error;
  }, `cascade delete property ${pid}`);
}
function cascadeNullGuest(id) {
  const gid = Number(id);
  store.bookings.forEach(b => { if (b.guest_id === gid) b.guest_id = null; });
  enqueueWrite(async () => { const { error } = await supabase.from(tbl('bookings')).update({ guest_id: null }).eq('guest_id', gid); if (error) throw error; }, `null guest ${gid}`);
}
function cascadeNullBookingType(id) {
  const tid = Number(id);
  store.bookings.forEach(b => { if (b.booking_type_id === tid) b.booking_type_id = null; });
  enqueueWrite(async () => { const { error } = await supabase.from(tbl('bookings')).update({ booking_type_id: null }).eq('booking_type_id', tid); if (error) throw error; }, `null booking_type ${tid}`);
}
function cascadeNullCleaner(id) {
  const cid = Number(id);
  store.cleaner_tasks = store.cleaner_tasks.filter(t => t.cleaner_id !== cid);
  store.properties.forEach(p => { if (p.default_cleaner_id === cid) p.default_cleaner_id = null; });
  enqueueWrite(async () => {
    let r = await supabase.from(tbl('cleaner_tasks')).delete().eq('cleaner_id', cid); if (r.error) throw r.error;
    r = await supabase.from(tbl('properties')).update({ default_cleaner_id: null }).eq('default_cleaner_id', cid); if (r.error) throw r.error;
  }, `null cleaner ${cid}`);
}

// Default platform economics: fee % charged by each channel + whether it's a "direct" booking.
const CHANNEL_DEFAULTS = {
  'Airbnb': { fee_percent: 3, is_direct: 0 },
  'VRBO': { fee_percent: 5, is_direct: 0 },
  'Cottages Canada': { fee_percent: 10, is_direct: 0 },
  'Private': { fee_percent: 0, is_direct: 1 },
};
const DEFAULT_UPSELLS = [
  { name: 'Firewood (bundle)', default_price: 25 },
  { name: 'Early check-in', default_price: 50 },
  { name: 'Late checkout', default_price: 50 },
  { name: 'Pet fee', default_price: 75 },
  { name: 'Mid-stay clean', default_price: 120 },
  { name: 'Hot tub heating', default_price: 60 },
  { name: 'Boat / kayak rental', default_price: 80 },
  { name: 'Welcome basket', default_price: 40 },
];
const DEFAULT_MESSAGE_TEMPLATES = [
  { stage: 'confirmation', offset_days: 0, send_hour: 10, subject: 'Booking confirmed', body: 'Hi {guest}, your stay at {property} is confirmed for {checkin} to {checkout}. We can\'t wait to host you!' },
  { stage: 'pre_arrival', offset_days: -3, send_hour: 10, subject: 'Your stay is coming up', body: 'Hi {guest}! Your stay at {property} ({address}) starts {checkin}. Door code: {door_code}. {checkin_instructions}' },
  { stage: 'checkin_day', offset_days: 0, send_hour: 11, subject: 'Welcome!', body: 'Welcome to {property}, {guest}! Your door code is {door_code}. Let us know if you need anything during your stay.' },
  { stage: 'mid_stay', offset_days: 1, send_hour: 11, subject: 'How is everything?', body: 'Hi {guest}, just checking in — is everything good at {property}? Reply here if you need anything.' },
  { stage: 'checkout_eve', offset_days: -1, send_hour: 18, subject: 'Checkout tomorrow', body: 'Hi {guest}, checkout from {property} is tomorrow ({checkout}). {checkin_instructions} Safe travels!' },
  { stage: 'review_request', offset_days: 1, send_hour: 12, subject: 'Thanks for staying!', body: 'Thanks for staying at {property}, {guest}! If you enjoyed it, we\'d love a review — it helps us a lot. Hope to host you again!' },
];
const DEFAULT_SETTINGS = {
  tax_setaside_percent: 25, // HST/MAT/income set-aside on net profit
  pricelabs_enabled: true,
  messaging_autosend_enabled: false, // OFF by default — never auto-blast real guests until enabled
  season_start_md: '06-01', // short-term rental season (MM-DD) — occupancy is measured over this window
  season_end_md: '10-01',
  projection_end_md: '09-07', // horizon for the "potential remaining revenue" projection
};

async function seedDefaults() {
  // Apply channel fee/direct defaults ONCE (column default is 0, so we can't rely on null);
  // a settings flag makes this idempotent and lets the user edit fees freely afterward.
  const channelSeeded = !!store.settings.find(s => s.key === 'channel_defaults_applied');
  for (const name of ['Airbnb', 'VRBO', 'Cottages Canada', 'Private']) {
    let bt = store.booking_types.find(t => t.name === name);
    if (!bt) bt = tableInsert('booking_types', { name });
    const d = CHANNEL_DEFAULTS[name];
    if (d && !channelSeeded) tableUpdate('booking_types', bt.id, { fee_percent: d.fee_percent, is_direct: d.is_direct });
  }
  if (!channelSeeded) tableInsert('settings', { key: 'channel_defaults_applied', value: true });
  if (!store.upsells.length) DEFAULT_UPSELLS.forEach(u => tableInsert('upsells', { name: u.name, default_price: u.default_price, active: 1 }));
  if (!store.message_templates.length) DEFAULT_MESSAGE_TEMPLATES.forEach(t => tableInsert('message_templates', { ...t, channel: 'sms', enabled: 1 }));
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!store.settings.find(s => s.key === key)) tableInsert('settings', { key, value });
  }
  await flushWrites();
}
function getSetting(key, fallback) {
  const s = store.settings.find(x => x.key === key);
  return s ? s.value : fallback;
}

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

// ---------- AUTH (Supabase) ----------
// Login gate for the admin app. Public booking endpoints and the Twilio webhook are exempt.
const ALLOWED_EMAILS = (process.env.RENTAL_ALLOWED_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
if (!ALLOWED_EMAILS.length) {
  console.warn('[startup] RENTAL_ALLOWED_EMAILS is empty — no one will be able to log in. Set it in .env.');
}
async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return err(res, 401, 'login required');
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return err(res, 401, 'invalid or expired session');
    const email = (data.user.email || '').toLowerCase();
    if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) return err(res, 403, 'this account is not authorized for the rental tracker');
    req.user = data.user;
    next();
  } catch (e) { return err(res, 401, 'auth check failed'); }
}
// Per-request data snapshot + write-flush (serverless-safe). Runs for every /api request:
// loads a fresh snapshot, then wraps the response so queued writes flush BEFORE sending.
app.use('/api', async (req, res, next) => {
  if (req.path === '/public/auth-config') return next(); // no data needed
  let snap;
  try { snap = await loadSnapshot(); }
  catch (e) { return res.status(500).json({ error: 'data load failed: ' + e.message }); }
  const c = { store: snap, pending: [] };
  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);
  const fail = (e) => { if (!res.headersSent) res.status(500); };
  res.json = (data) => { flushCtx(c).then(() => origJson(data), (e) => { fail(e); origJson({ error: 'save failed: ' + e.message }); }); return res; };
  res.send = (body) => { flushCtx(c).then(() => origSend(body), (e) => { fail(e); origSend('save failed: ' + e.message); }); return res; };
  als.run(c, () => next());
});
// Gate everything under /api except public booking, Twilio webhook, and cron.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/public/') || req.path === '/twilio/incoming' || req.path.startsWith('/cron/')) return next();
  return requireAuth(req, res, next);
});
// Browser login screen reads this to talk to Supabase Auth (anon key is safe to expose).
app.get('/api/public/auth-config', (req, res) => ok(res, { url: SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY || '' }));

function joinBooking(b) {
  const p = b.property_id ? tableFind('properties', b.property_id) : null;
  const t = b.booking_type_id ? tableFind('booking_types', b.booking_type_id) : null;
  const g = b.guest_id ? tableFind('guests', b.guest_id) : null;
  const ups = store.booking_upsells.filter(u => u.booking_id === b.id);
  const upsell_total = ups.reduce((a, u) => a + (Number(u.price) || 0) * (Number(u.qty) || 1), 0);
  const fee_percent = t ? (Number(t.fee_percent) || 0) : 0;
  const fee_fixed = t ? (Number(t.fee_fixed) || 0) : 0;
  const platform_fee = +((((Number(b.amount) || 0) * fee_percent) / 100) + fee_fixed).toFixed(2);
  return { ...b,
    property_name: p?.nickname || null,
    booking_type_name: t?.name || null,
    booking_type_is_direct: t ? (t.is_direct ? 1 : 0) : 0,
    guest_name: g?.name || null,
    guest_email: g?.email || null,
    guest_phone: g?.phone || null,
    upsell_total,
    upsells: ups,
    platform_fee,
    net_revenue: +(((Number(b.amount) || 0) + upsell_total) - platform_fee).toFixed(2),
  };
}
function joinExpense(e) {
  const p = e.property_id ? tableFind('properties', e.property_id) : null;
  return { ...e, property_name: p?.nickname || null };
}
function joinReview(r) {
  const p = r.property_id ? tableFind('properties', r.property_id) : null;
  return { ...r, property_name: p?.nickname || null };
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
  const bid = Number(bookingId);
  store.cleaner_tasks = store.cleaner_tasks.filter(t => t.booking_id !== bid);
  enqueueWrite(async () => { const { error } = await supabase.from(tbl('cleaner_tasks')).delete().eq('booking_id', bid); if (error) throw error; }, `delete cleaner_tasks for booking ${bid}`);
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
    ical_token: crypto.randomBytes(16).toString('hex'),
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
    ...(req.body.pricelabs_listing_id !== undefined ? { pricelabs_listing_id: req.body.pricelabs_listing_id || null } : {}),
    ...(req.body.pricelabs_pms !== undefined ? { pricelabs_pms: req.body.pricelabs_pms || null } : {}),
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
    door_code: payload.door_code || '',
    status: payload.status || 'confirmed',
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
  const { property_id, booking_type_id, guest_id, check_in, check_out, amount, contact_name, notes, invite_sent, door_code, status } = req.body || {};
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
    door_code: door_code != null ? door_code : existing.door_code,
    status: status != null ? status : (existing.status || 'confirmed'),
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
function daysBetweenIso(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
// Upcoming guest stays from the reconciled calendar — excludes cancelled bookings and
// overridden platform reservations, and de-dupes cross-platform mirrors.
function upcomingStays() {
  return buildCalendarEvents()
    .filter(e => e.kind === 'booking' || e.kind === 'reserved')
    .map(e => ({ property_id: e.property_id, start: e.start }));
}
// "Clean by" = the next stay's check-in at this property after the guest checks out — the
// latest a cleaner can finish and still have the unit ready. null when nothing is booked next.
function cleanByInfo(task, stays) {
  stays = stays || upcomingStays();
  const b = task.booking_id ? tableFind('bookings', task.booking_id) : null;
  const anchor = (b && b.check_out) || task.due_date; // unit frees up at checkout
  let cleanBy = null;
  if (anchor) for (const s of stays) {
    if (s.property_id !== task.property_id || !s.start || s.start < anchor) continue;
    if (cleanBy === null || s.start < cleanBy) cleanBy = s.start;
  }
  return {
    clean_by: cleanBy,
    same_day_turnover: !!(cleanBy && anchor && cleanBy === anchor),
    clean_window_days: (cleanBy && anchor) ? daysBetweenIso(anchor, cleanBy) : null,
  };
}
app.get('/api/cleaner-tasks', (req, res) => {
  const stays = upcomingStays();
  ok(res, tableAll('cleaner_tasks')
    .map(t => ({ ...joinCleanerTask(t), ...cleanByInfo(t, stays) }))
    .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')));
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
    const { clean_by, same_day_turnover } = cleanByInfo(task);
    const deadline = clean_by
      ? (same_day_turnover
          ? `\n⚠ SAME-DAY turnaround — must be ready by check-in on ${clean_by}.`
          : `\nMust be ready by ${clean_by} (next guest checks in).`)
      : '';

    const body = `Hi ${cleaner.name}, you have a cleaning scheduled at ${propName} on ${dueDate}.${deadline}${taskNotes}\n\nPlease confirm when you're available. Thanks!`;

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
  // Replace this property+source's synced events (in memory and in Supabase).
  store.synced_events = store.synced_events.filter(e => !(e.property_id === property.id && e.source === source));
  enqueueWrite(async () => {
    const { error } = await supabase.from(tbl('synced_events')).delete().eq('property_id', property.id).eq('source', source);
    if (error) throw error;
  }, `clear synced_events property ${property.id} ${source}`);
  let count = 0;
  const uids = [];
  for (const k of Object.keys(events)) {
    const e = events[k];
    if (!e || e.type !== 'VEVENT') continue;
    const start = e.start ? new Date(e.start).toISOString().slice(0, 10) : null;
    const end = e.end ? new Date(e.end).toISOString().slice(0, 10) : null;
    if (!start) continue;
    const uid = e.uid || k;
    uids.push(uid);
    tableInsert('synced_events', {
      property_id: property.id, source, uid, summary: e.summary || '',
      start_date: start, end_date: end, last_synced: nowIso(),
    });
    count++;
  }
  return { source, count, uids };
}
// When a guest cancels on Airbnb/VRBO, the platform simply drops the reservation from its
// feed. A booking that was *claimed* from that reservation (linked by source_uid) would
// otherwise linger forever, since sync only manages synced_events. Here we reconcile: any
// confirmed, future booking whose platform reservation has vanished from the freshly-fetched
// feed is auto-cancelled (reversible — kept in the DB, just hidden from the calendar).
const claimedPlatformOf = (uid) => /airbnb/i.test(uid || '') ? 'airbnb' : 'vrbo';
function reconcileVanishedReservations(property, fetchedBySource) {
  const todayIso = nowIso().slice(0, 10);
  const cancelled = [];
  for (const b of tableAll('bookings')) {
    if (b.property_id !== property.id) continue;
    if (!b.source_uid || b.status === 'cancelled') continue;
    if ((b.check_out || b.check_in) < todayIso) continue;          // only future stays
    const fset = fetchedBySource[claimedPlatformOf(b.source_uid)]; // platform we fetched
    if (!fset) continue;                                           // that feed wasn't fetched — leave it
    if (fset.has(b.source_uid)) continue;                         // still on the platform — keep
    tableUpdate('bookings', b.id, { status: 'cancelled' });
    removeCleanerTaskForBooking(b.id);
    cancelled.push({ id: b.id, contact_name: b.contact_name, check_in: b.check_in, check_out: b.check_out });
  }
  return cancelled;
}
app.post('/api/sync/:propertyId', async (req, res) => {
  const property = tableFind('properties', req.params.propertyId);
  if (!property) return err(res, 404, 'property not found');
  try {
    const results = [];
    const fetched = {};
    if (property.airbnb_ical_url) { const r = await fetchAndStoreIcal(property, 'airbnb', property.airbnb_ical_url); results.push(r); fetched.airbnb = new Set(r.uids || []); }
    if (property.vrbo_ical_url) { const r = await fetchAndStoreIcal(property, 'vrbo', property.vrbo_ical_url); results.push(r); fetched.vrbo = new Set(r.uids || []); }
    const cancelled = reconcileVanishedReservations(property, fetched);
    ok(res, { property_id: property.id, results, cancelled });
  } catch (e) { err(res, 500, 'Sync failed: ' + e.message); }
});
app.post('/api/sync-all', async (req, res) => {
  const out = [];
  for (const p of tableAll('properties')) {
    try {
      const r = [];
      const fetched = {};
      if (p.airbnb_ical_url) { const x = await fetchAndStoreIcal(p, 'airbnb', p.airbnb_ical_url); r.push(x); fetched.airbnb = new Set(x.uids || []); }
      if (p.vrbo_ical_url) { const x = await fetchAndStoreIcal(p, 'vrbo', p.vrbo_ical_url); r.push(x); fetched.vrbo = new Set(x.uids || []); }
      const cancelled = reconcileVanishedReservations(p, fetched);
      out.push({ property_id: p.id, nickname: p.nickname, results: r, cancelled });
    } catch (e) { out.push({ property_id: p.id, nickname: p.nickname, error: e.message }); }
  }
  ok(res, out);
});

// ---------- RESERVATION RECONCILIATION ----------
// Cross-platform de-duplication: Airbnb/VRBO are synced to each other, so the same
// stay can appear as (a) a manual booking, (b) a "Reserved" synced event, and (c) a
// mirror "Blocked"/"Not available" event on the other platform. We collapse all of
// that into one entry so the calendar reflects reality and conflicts are real.
const BLOCKED_RE = /blocked|not\s*available|unavailable|closed/i;
function classifySynced(summary) {
  const s = (summary || '').trim();
  if (!s) return 'blocked';
  if (/reserv/i.test(s)) return 'reserved';
  if (BLOCKED_RE.test(s)) return 'blocked';
  // Some exports list just a guest name / "CONFIRMED" — treat as a real guest hold.
  return 'reserved';
}
function parseGuestFromSummary(summary) {
  const s = (summary || '').trim();
  const m = s.match(/^(?:reserved|reservation)\s*[-–—:]\s*(.+)$/i);
  return m ? m[1].trim() : '';
}
// Loose name comparison so "Kaileigh" matches "Kaileigh Smith" but not "Gina".
function namesMatch(a, b) {
  const norm = x => (x || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const fa = na.split(/\s+/)[0], fb = nb.split(/\s+/)[0];
  return na.startsWith(nb) || nb.startsWith(na) || (fa.length > 2 && fa === fb);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function effEnd(start, end) {
  // Checkout day is not occupied; a missing/equal end means a single night.
  if (!end || end <= start) return addDays(start, 1);
  return end;
}
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !bStart) return false;
  return aStart < effEnd(bStart, bEnd) && bStart < effEnd(aStart, aEnd);
}
function platformToTypeName(source) {
  if (source === 'airbnb') return 'Airbnb';
  if (source === 'vrbo') return 'VRBO';
  return null;
}
function mergeBlocks(blocks) {
  const byProp = {};
  for (const b of blocks) (byProp[b.property_id] = byProp[b.property_id] || []).push(b);
  const out = [];
  for (const pid of Object.keys(byProp)) {
    const list = byProp[pid].sort((a, b) => a.start.localeCompare(b.start));
    let cur = null;
    for (const b of list) {
      const bEnd = b.end || b.start;
      if (cur && b.start <= (cur.end || cur.start)) {
        if (bEnd > (cur.end || cur.start)) cur.end = bEnd;
        b.sources.forEach(s => cur.sources.add(s));
      } else {
        cur = { property_id: Number(pid), start: b.start, end: bEnd, sources: new Set(b.sources) };
        out.push(cur);
      }
    }
  }
  return out;
}

// Returns a flat, de-duplicated, flagged list of calendar entries.
function buildCalendarEvents() {
  const events = [];
  // Cancelled bookings are kept in the DB (for history/revenue records) but must not
  // occupy the calendar, claim synced reservations, or trip conflict detection.
  const bookingEvents = tableAll('bookings').filter(b => b.status !== 'cancelled').map(joinBooking).map(b => ({
    kind: 'booking', id: 'b' + b.id, booking_id: b.id,
    property_id: b.property_id, property_name: b.property_name,
    guest_name: b.guest_name || b.contact_name || null,
    contact_name: b.contact_name || null,
    title: `${b.property_name || 'Property'} — ${b.guest_name || b.contact_name || 'Booking'}`,
    start: b.check_in, end: b.check_out || b.check_in,
    source: b.booking_type_name || 'Manual', amount: b.amount,
    source_uid: b.source_uid || null,
    platform_verified: false, synced_source: null,
  }));
  events.push(...bookingEvents);

  // "Override" a platform reservation: a cancelled booking that was claimed from a synced
  // Airbnb/VRBO event (linked by source_uid) voids that event — e.g. the guest was moved to
  // another property but the stay was never cancelled on the platform. Suppress it so it
  // doesn't resurface as a "needs details" entry or a block. Keyed by UID so it survives
  // re-syncs (synced_events are wiped/re-inserted each sync, but the UID is stable).
  const voidedUids = new Set(
    tableAll('bookings').filter(b => b.status === 'cancelled' && b.source_uid).map(b => b.source_uid)
  );
  const synced = tableAll('synced_events')
    .filter(s => !voidedUids.has(s.uid))
    .map(s => ({ ...s, _class: classifySynced(s.summary) }));

  // Reserved synced events → merge into a matching booking, else surface as "needs details".
  const claimedSpans = [];
  for (const s of synced.filter(e => e._class === 'reserved')) {
    const guestName = parseGuestFromSummary(s.summary);
    const atProp = bookingEvents.filter(b => b.property_id === s.property_id);
    // Match a platform reservation to a booking only when it's plausibly the SAME
    // reservation — never absorb it into an unrelated booking that merely overlaps.
    // Priority: linked UID → exact date span → overlap with a matching guest name.
    let match = atProp.find(b => b.source_uid && s.uid && b.source_uid === s.uid);
    if (!match) match = atProp.find(b => b.start === s.start_date && (b.end || b.start) === s.end_date);
    if (!match && guestName) match = atProp.find(b =>
      rangesOverlap(b.start, b.end, s.start_date, s.end_date) &&
      namesMatch(guestName, b.guest_name || b.contact_name));
    if (match) {
      match.platform_verified = true;
      match.synced_source = s.source;
      claimedSpans.push({ property_id: s.property_id, start: s.start_date, end: s.end_date });
    } else {
      const p = tableFind('properties', s.property_id);
      const guest = guestName;
      events.push({
        kind: 'reserved', id: 's' + s.id, synced_event_id: s.id,
        property_id: s.property_id, property_name: p?.nickname || null,
        guest_name: guest || null,
        title: `${p?.nickname || 'Property'} — ${guest || s.summary || s.source}`,
        start: s.start_date, end: s.end_date, source: s.source, needs_details: true,
      });
    }
  }

  // Synced blocks → drop cross-sync mirrors of real stays, merge the remainder.
  const occupiedSpans = bookingEvents
    .map(b => ({ property_id: b.property_id, start: b.start, end: b.end || b.start }))
    .concat(claimedSpans);
  const realBlocks = [];
  for (const s of synced.filter(e => e._class === 'blocked')) {
    const isMirror = occupiedSpans.some(sp => sp.property_id === s.property_id &&
      rangesOverlap(sp.start, sp.end, s.start_date, s.end_date));
    if (isMirror) continue;
    realBlocks.push({ property_id: s.property_id, start: s.start_date, end: s.end_date || s.start_date, sources: new Set([s.source]) });
  }
  for (const blk of mergeBlocks(realBlocks)) {
    const p = tableFind('properties', blk.property_id);
    events.push({
      kind: 'block', id: 'blk' + blk.property_id + '-' + blk.start,
      property_id: blk.property_id, property_name: p?.nickname || null,
      title: `${p?.nickname || 'Property'} — Blocked`,
      start: blk.start, end: blk.end, source: [...blk.sources].join('/'),
    });
  }

  // Manual blocks (owner-created) → always shown, individually editable/deletable.
  for (const blk of tableAll('manual_blocks')) {
    const p = tableFind('properties', blk.property_id);
    events.push({
      kind: 'block', manual: true, block_id: blk.id, id: 'mblk' + blk.id,
      property_id: blk.property_id, property_name: p?.nickname || null,
      title: `${p?.nickname || 'Property'} — ${blk.reason || 'Blocked'}`,
      reason: blk.reason || 'Blocked', start: blk.start_date, end: blk.end_date || blk.start_date,
      source: 'manual',
    });
  }

  // Tasks (to-dos with a due date) so turnover work shows alongside bookings.
  for (const t of tableAll('todos').map(joinTodo)) {
    if (!t.due_date) continue;
    events.push({
      kind: 'task', id: 't' + t.id, todo_id: t.id,
      property_id: t.property_id, property_name: t.property_name,
      title: t.title, start: t.due_date, end: t.due_date,
      priority: t.priority, status: t.status,
    });
  }

  events.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  return events;
}

// A conflict = two distinct guest entries (booking/reserved) overlapping at one property.
// Only current/future overlaps count — historical ones (e.g. imported records) are moot.
function computeConflicts(events) {
  const today = new Date().toISOString().slice(0, 10);
  const guests = events.filter(e => e.kind === 'booking' || e.kind === 'reserved');
  const out = [];
  for (let i = 0; i < guests.length; i++) {
    for (let j = i + 1; j < guests.length; j++) {
      const a = guests[i], b = guests[j];
      if (a.property_id !== b.property_id) continue;
      if (!rangesOverlap(a.start, a.end, b.start, b.end)) continue;
      const overlapEnd = effEnd(a.start, a.end) < effEnd(b.start, b.end) ? effEnd(a.start, a.end) : effEnd(b.start, b.end);
      if (overlapEnd < today) continue; // already history — nothing to resolve
      out.push({
        property_id: a.property_id, property_name: a.property_name,
        overlap_start: a.start > b.start ? a.start : b.start,
        a: { id: a.id, kind: a.kind, guest_name: a.guest_name, start: a.start, end: a.end, source: a.source },
        b: { id: b.id, kind: b.kind, guest_name: b.guest_name, start: b.start, end: b.end, source: b.source },
      });
    }
  }
  return out.sort((x, y) => (x.overlap_start || '').localeCompare(y.overlap_start || ''));
}

// ---------- CALENDAR ----------
app.get('/api/calendar', (req, res) => {
  ok(res, buildCalendarEvents());
});

app.get('/api/conflicts', (req, res) => {
  ok(res, computeConflicts(buildCalendarEvents()));
});

// Claim/enrich a synced Airbnb/VRBO reservation by creating a real booking linked to it.
app.post('/api/synced-events/:id/claim', (req, res) => {
  const s = tableFind('synced_events', req.params.id);
  if (!s) return err(res, 404, 'synced event not found');
  const body = req.body || {};
  const typeName = platformToTypeName(s.source);
  const matchedType = typeName ? store.booking_types.find(t => t.name.toLowerCase() === typeName.toLowerCase()) : null;
  const booking = createBookingFromPayload({
    property_id: s.property_id,
    booking_type_id: body.booking_type_id || (matchedType ? matchedType.id : null),
    guest_id: body.guest_id || null,
    new_guest: body.new_guest || (body.guest_name ? { name: body.guest_name } : null),
    check_in: body.check_in || s.start_date,
    check_out: body.check_out || s.end_date,
    amount: body.amount,
    contact_name: body.contact_name || body.guest_name || '',
    notes: body.notes || '',
  });
  const updated = tableUpdate('bookings', booking.id, { source_uid: s.uid });
  ok(res, joinBooking(updated || booking));
});

// ---------- MANUAL BLOCKS (owner-created unavailable dates) ----------
app.get('/api/blocks', (req, res) => {
  ok(res, tableAll('manual_blocks').sort((a, b) => (a.start_date || '').localeCompare(b.start_date || '')));
});
app.post('/api/blocks', (req, res) => {
  const { property_id, start_date, end_date, reason } = req.body || {};
  if (!property_id) return err(res, 400, 'property_id required');
  if (!start_date) return err(res, 400, 'start_date required');
  ok(res, tableInsert('manual_blocks', {
    property_id: Number(property_id),
    start_date,
    end_date: end_date || start_date,
    reason: (reason || 'Blocked').trim() || 'Blocked',
  }));
});
app.put('/api/blocks/:id', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.property_id != null) patch.property_id = Number(b.property_id);
  if (b.start_date != null) patch.start_date = b.start_date;
  if (b.end_date !== undefined) patch.end_date = b.end_date || (b.start_date || undefined);
  if (b.reason != null) patch.reason = (b.reason || 'Blocked').trim() || 'Blocked';
  const row = tableUpdate('manual_blocks', req.params.id, patch);
  if (!row) return err(res, 404, 'not found'); ok(res, row);
});
app.delete('/api/blocks/:id', (req, res) => {
  tableRemove('manual_blocks', req.params.id);
  ok(res, { ok: true });
});

// ---------- iCAL EXPORT FEED (per property) ----------
// A private, token-protected .ics feed of every occupied span for one property
// (manual + platform + direct bookings + blocks). Import it into Airbnb / VRBO /
// Cottages Canada so each platform blocks dates booked anywhere — closes the loop.
function icsEscape(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsDate(iso) { return (iso || '').replace(/-/g, ''); }
function slugForFile(s) { return String(s || 'property').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'property'; }
// Which platform an occupied span ORIGINATED on (null = direct/manual/no single origin).
// Used to build per-platform feeds: the feed you give VRBO must not echo VRBO's own
// reservations back at it, or every stay shows up twice and conflicts with itself.
function eventOriginPlatform(e) {
  if (e.kind === 'reserved') return (e.source || '').toLowerCase() || null;
  if (e.kind === 'booking') {
    if (e.synced_source) return e.synced_source.toLowerCase();          // matched to a platform feed this sync
    if (e.source_uid) return claimedPlatformOf(e.source_uid);           // claimed from a platform reservation
    const s = (e.source || '').toLowerCase();
    if (s === 'airbnb' || s === 'vrbo') return s;                       // typed as that channel's booking
    return null;                                                        // Private / Cottages / manual
  }
  if (e.kind === 'block') {
    if (e.manual) return null;                                          // owner block — every platform needs it
    const srcs = (e.source || '').toLowerCase().split('/').filter(Boolean);
    return srcs.length === 1 ? srcs[0] : null;                          // single-platform block echoes; merged ones don't
  }
  return null;
}
function buildPropertyIcs(property, excludePlatform) {
  const events = buildCalendarEvents().filter(e => e.property_id === property.id && (e.kind === 'booking' || e.kind === 'reserved' || e.kind === 'block'))
    .filter(e => !excludePlatform || eventOriginPlatform(e) !== excludePlatform);
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rental Tracker//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape(property.nickname + ' availability')];
  events.forEach((e, i) => {
    if (!e.start) return;
    const end = (e.end && e.end > e.start) ? e.end : addDays(e.start, 1); // DTEND is exclusive for all-day events
    const summary = e.kind === 'block' ? (e.reason || 'Blocked') : 'Reserved';
    lines.push('BEGIN:VEVENT',
      'UID:' + (e.id || ('evt' + i)) + '-p' + property.id + '@rental-tracker',
      'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + icsDate(e.start),
      'DTEND;VALUE=DATE:' + icsDate(end),
      'SUMMARY:' + icsEscape(summary),
      'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
app.get('/api/public/ical/:pid.ics', (req, res) => {
  const property = tableFind('properties', req.params.pid);
  if (!property) return res.status(404).type('text/plain').send('not found');
  if (!property.ical_token || req.query.token !== property.ical_token) return res.status(403).type('text/plain').send('forbidden');
  // ?for=vrbo → the feed VRBO imports (excludes VRBO-origin stays so they don't echo).
  // ?for=airbnb → likewise for Airbnb. No param → full feed (Cottages Canada etc.).
  const forPlatform = String(req.query.for || req.query.exclude || '').toLowerCase();
  const exclude = (forPlatform === 'airbnb' || forPlatform === 'vrbo') ? forPlatform : null;
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="' + slugForFile(property.nickname) + '.ics"');
  res.send(buildPropertyIcs(property, exclude));
});

// ---------- LONG-TERM RENTAL (off-season tenancy: listings, photos, applicants) ----------
async function signLtrPhotos(props) {
  const paths = [];
  props.forEach(p => (p.ltr_photos || []).forEach(ph => { if (ph.path) paths.push(ph.path); }));
  if (!paths.length) return props;
  const { data } = await supabase.storage.from(UPLOAD_BUCKET).createSignedUrls(paths, 3600);
  const byPath = {}; (data || []).forEach(s => { if (s.path) byPath[s.path] = s.signedUrl; });
  props.forEach(p => { p.ltr_photos = (p.ltr_photos || []).map(ph => ({ ...ph, url: ph.path ? byPath[ph.path] || null : ph.url || null })); });
  return props;
}
function joinApplicant(a) { const p = a.property_id ? tableFind('properties', a.property_id) : null; return { ...a, property_name: p?.nickname || null }; }
function createApplicant(b, source) {
  return tableInsert('ltr_applicants', {
    property_id: b.property_id ? Number(b.property_id) : null,
    name: b.name || '', email: b.email || '', phone: b.phone || '',
    current_address: b.current_address || '', employer: b.employer || '', job_title: b.job_title || '',
    annual_income: Number(b.annual_income) || 0, credit_score: Number(b.credit_score) || 0,
    occupants: Number(b.occupants) || 0, pets: b.pets || '', desired_move_in: b.desired_move_in || '',
    references_info: b.references_info || '', notes: b.notes || '',
    status: source === 'manual' ? (b.status || 'applied') : 'applied',
  });
}

// Admin overview: each property's LTR listing + signed photos + applicant count + secured tenant.
app.get('/api/ltr', async (req, res) => {
  const props = tableAll('properties').map(p => {
    const secured = p.ltr_secured_applicant_id ? tableFind('ltr_applicants', p.ltr_secured_applicant_id) : null;
    return {
      id: p.id, nickname: p.nickname, address: p.address,
      ltr_listed: p.ltr_listed || 0, ltr_status: p.ltr_status || 'vacant',
      ltr_description: p.ltr_description || '', ltr_rent: p.ltr_rent, ltr_available_date: p.ltr_available_date || '',
      ltr_lease_terms: p.ltr_lease_terms || '', ltr_photos: (p.ltr_photos || []).slice(),
      ltr_secured_applicant_id: p.ltr_secured_applicant_id || null,
      secured_tenant_name: secured ? secured.name : null,
      applicant_count: tableAll('ltr_applicants').filter(a => a.property_id === p.id).length,
    };
  });
  await signLtrPhotos(props);
  ok(res, { properties: props, applicants: tableAll('ltr_applicants').map(joinApplicant).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')) });
});
app.put('/api/properties/:id/ltr', (req, res) => {
  const b = req.body || {}; const patch = {};
  ['ltr_status', 'ltr_description', 'ltr_available_date', 'ltr_lease_terms'].forEach(k => { if (b[k] != null) patch[k] = b[k]; });
  if (b.ltr_listed != null) patch.ltr_listed = b.ltr_listed ? 1 : 0;
  if (b.ltr_rent != null) patch.ltr_rent = Number(b.ltr_rent) || 0;
  if (b.ltr_secured_applicant_id !== undefined) patch.ltr_secured_applicant_id = b.ltr_secured_applicant_id ? Number(b.ltr_secured_applicant_id) : null;
  const row = tableUpdate('properties', req.params.id, patch);
  if (!row) return err(res, 404, 'not found'); ok(res, row);
});
app.post('/api/properties/:id/ltr-photos', upload.array('files', 12), async (req, res) => {
  const p = tableFind('properties', req.params.id);
  if (!p) return err(res, 404, 'property not found');
  if (!req.files || !req.files.length) return err(res, 400, 'no files uploaded');
  const ts = Date.now(); const added = [];
  for (let i = 0; i < req.files.length; i++) {
    const f = req.files[i];
    const ext = path.extname(f.originalname);
    const base = path.basename(f.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const objectPath = `ltr/${p.id}/${ts}-${i}-${base}${ext}`;
    const up = await supabase.storage.from(UPLOAD_BUCKET).upload(objectPath, f.buffer, { contentType: f.mimetype, upsert: false });
    if (up.error) return err(res, 500, 'upload failed: ' + up.error.message);
    added.push({ path: objectPath, original_name: f.originalname });
  }
  const updated = tableUpdate('properties', p.id, { ltr_photos: [...(p.ltr_photos || []), ...added] });
  const out = [updated]; await signLtrPhotos(out); ok(res, out[0]);
});
app.delete('/api/properties/:id/ltr-photo', async (req, res) => {
  const p = tableFind('properties', req.params.id);
  if (!p) return err(res, 404, 'property not found');
  const objectPath = req.query.path || (req.body && req.body.path);
  if (!objectPath) return err(res, 400, 'path required');
  try { await supabase.storage.from(UPLOAD_BUCKET).remove([objectPath]); } catch (e) {}
  const updated = tableUpdate('properties', p.id, { ltr_photos: (p.ltr_photos || []).filter(ph => ph.path !== objectPath) });
  const out = [updated]; await signLtrPhotos(out); ok(res, out[0]);
});
app.get('/api/ltr-applicants', (req, res) => {
  let rows = tableAll('ltr_applicants');
  if (req.query.property_id) rows = rows.filter(a => String(a.property_id) === String(req.query.property_id));
  ok(res, rows.map(joinApplicant).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')));
});
app.post('/api/ltr-applicants', (req, res) => ok(res, joinApplicant(createApplicant(req.body || {}, 'manual'))));
app.put('/api/ltr-applicants/:id', (req, res) => {
  const b = req.body || {}; const patch = {};
  ['name', 'email', 'phone', 'current_address', 'employer', 'job_title', 'pets', 'desired_move_in', 'references_info', 'notes', 'status'].forEach(k => { if (b[k] != null) patch[k] = b[k]; });
  if (b.annual_income != null) patch.annual_income = Number(b.annual_income) || 0;
  if (b.credit_score != null) patch.credit_score = Number(b.credit_score) || 0;
  if (b.occupants != null) patch.occupants = Number(b.occupants) || 0;
  if (b.property_id !== undefined) patch.property_id = b.property_id ? Number(b.property_id) : null;
  const row = tableUpdate('ltr_applicants', req.params.id, patch);
  if (!row) return err(res, 404, 'not found'); ok(res, joinApplicant(row));
});
app.delete('/api/ltr-applicants/:id', (req, res) => { tableRemove('ltr_applicants', req.params.id); ok(res, { ok: true }); });

// Public application page data + submission (no login).
app.get('/api/public/ltr-listings', async (req, res) => {
  const props = tableAll('properties').filter(p => p.ltr_listed).map(p => ({
    id: p.id, nickname: p.nickname, address: p.address, ltr_status: p.ltr_status || 'vacant',
    ltr_description: p.ltr_description || '', ltr_rent: p.ltr_rent, ltr_available_date: p.ltr_available_date || '',
    ltr_lease_terms: p.ltr_lease_terms || '', ltr_photos: (p.ltr_photos || []).slice(),
  }));
  await signLtrPhotos(props);
  ok(res, props);
});
app.post('/api/public/ltr-applications', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email) return err(res, 400, 'name and email are required');
  const row = createApplicant(b, 'public');
  ok(res, { ok: true, id: row.id });
});
// Public application page (no auth).
app.get('/apply', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apply.html')));

// ---------- DASHBOARD ----------
function daysBetween(a, b) {
  const ms = new Date(b) - new Date(a);
  return Math.max(1, Math.round(ms / 86400000));
}
// Occupied nights of a stay that fall inside [winStart, winEnd) — ISO dates, checkout-exclusive.
function nightsInWindow(checkIn, checkOut, winStart, winEnd) {
  if (!checkIn) return 0;
  const s = checkIn > winStart ? checkIn : winStart;
  const e0 = checkOut || checkIn;
  const e = e0 < winEnd ? e0 : winEnd;
  if (e <= s) return 0;
  return Math.round((new Date(e) - new Date(s)) / 86400000);
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
  // Occupancy is measured over the short-term-rental SEASON, not the whole year.
  const seasonStart = `${year}-${getSetting('season_start_md', '06-01')}`;
  const seasonEnd = `${year}-${getSetting('season_end_md', '10-01')}`;
  const seasonNights = Math.max(1, Math.round((new Date(seasonEnd) - new Date(seasonStart)) / 86400000));
  const byProperty = tableAll('properties').map(p => {
    const list = ytdBookings.filter(b => b.property_id === p.id);
    const earnings = list.reduce((a, b) => a + (b.amount || 0), 0);
    let nights = 0;
    list.forEach(b => { nights += nightsInWindow(b.check_in, b.check_out, seasonStart, seasonEnd); });
    const occupancy = +(nights / seasonNights).toFixed(3);
    const revpar = +(earnings / seasonNights).toFixed(2);
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

  // Double-booking guard + revenue completeness across platforms.
  const calEvents = buildCalendarEvents();
  const conflicts = computeConflicts(calEvents);
  const unconfirmedReservations = calEvents.filter(e => e.kind === 'reserved').length;

  // Profit + performance metrics (Phases C–H).
  const fin = computeFinancials(year);
  const metrics = computeMetrics(year);
  const orphans = computeOrphans(2);

  // Potential remaining revenue if vacant nights (3+ night runs) were filled through the
  // projection horizon. Excludes Look Out (under renovation).
  const projStart = todayIso > seasonStart ? todayIso : seasonStart;
  const projEnd = `${year}-${getSetting('projection_end_md', '09-07')}`;
  const adrByProp = {}; byProperty.forEach(p => { adrByProp[p.id] = p.adr || 0; });
  const projPropIds = tableAll('properties').filter(p => !/look\s*-?\s*out/i.test(p.nickname || '')).map(p => p.id);
  const potential_revenue = projEnd > projStart ? computePotentialRevenue(projPropIds, projStart, projEnd, adrByProp, 3) : { total: 0, fillable_nights: 0, by_property: [], start: projStart, end: projEnd, min_stay: 3 };

  ok(res, {
    year,
    conflicts,
    conflict_count: conflicts.length,
    unconfirmed_reservations: unconfirmedReservations,
    financials: fin,
    metrics,
    orphans,
    orphan_count: orphans.length,
    orphan_nights: orphans.reduce((a, o) => a + o.nights, 0),
    potential_revenue,
    ytd_earnings: ytdEarnings,
    ytd_bookings: ytdBookings.length,
    ytd_nights: totalNightsYtd,
    avg_per_booking_ytd: ytdBookings.length ? +(ytdEarnings / ytdBookings.length).toFixed(2) : 0,
    all_time_earnings: allTimeEarnings,
    all_time_bookings: allBookings.length,
    by_type: byType,
    by_property: byProperty,
    season_start: seasonStart,
    season_end: seasonEnd,
    season_nights: seasonNights,
    season_occupancy: +((byProperty.reduce((a, p) => a + p.nights, 0)) / (seasonNights * Math.max(1, byProperty.length))).toFixed(3),
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
// Sign all attachment paths in a set of licensing items (1h links for private-bucket files).
async function signAttachments(rows) {
  const paths = [];
  rows.forEach(r => (r.attachments || []).forEach(a => { if (a.path) paths.push(a.path); }));
  if (!paths.length) return rows;
  const { data } = await supabase.storage.from(UPLOAD_BUCKET).createSignedUrls(paths, 3600);
  const byPath = {}; (data || []).forEach(s => { if (s.path) byPath[s.path] = s.signedUrl; });
  rows.forEach(r => { r.attachments = (r.attachments || []).map(a => ({ ...a, url: a.path ? byPath[a.path] || null : a.url || null })); });
  return rows;
}
app.get('/api/licensing', async (req, res) => {
  const { property_id } = req.query;
  let rows = tableAll('licensing_items');
  if (property_id) rows = rows.filter(r => r.property_id === Number(property_id));
  rows = rows.map(joinLicensingItem).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  await signAttachments(rows);
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
app.post('/api/licensing/:id/upload', upload.array('files', 10), async (req, res) => {
  const item = tableFind('licensing_items', req.params.id);
  if (!item) return err(res, 404, 'licensing item not found');
  if (!item.uploads_allowed) return err(res, 400, 'this step does not support file uploads');
  if (!req.files || !req.files.length) return err(res, 400, 'no files uploaded');
  const ts = Date.now();
  const newAttachments = [];
  for (let i = 0; i < req.files.length; i++) {
    const f = req.files[i];
    const ext = path.extname(f.originalname);
    const base = path.basename(f.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const objectPath = `licensing/${item.id}/${ts}-${i}-${base}${ext}`;
    const up = await supabase.storage.from(UPLOAD_BUCKET).upload(objectPath, f.buffer, { contentType: f.mimetype, upsert: false });
    if (up.error) return err(res, 500, 'upload failed: ' + up.error.message);
    newAttachments.push({ path: objectPath, original_name: f.originalname, size: f.size, mime_type: f.mimetype, uploaded_at: nowIso() });
  }
  const attachments = [...(item.attachments || []), ...newAttachments];
  const updated = tableUpdate('licensing_items', item.id, { attachments });
  const out = [joinLicensingItem(updated)];
  await signAttachments(out);
  ok(res, out[0]);
});

app.delete('/api/licensing/:id/attachment', async (req, res) => {
  const item = tableFind('licensing_items', req.params.id);
  if (!item) return err(res, 404, 'licensing item not found');
  const objectPath = req.query.path || (req.body && req.body.path);
  if (!objectPath) return err(res, 400, 'path required');
  try { await supabase.storage.from(UPLOAD_BUCKET).remove([objectPath]); } catch (e) {}
  const attachments = (item.attachments || []).filter(a => a.path !== objectPath);
  const updated = tableUpdate('licensing_items', item.id, { attachments });
  const out = [joinLicensingItem(updated)];
  await signAttachments(out);
  ok(res, out[0]);
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
  ok(res, { found: true, name: guest.name, stays });
});
app.post('/api/public/booking-requests', (req, res) => {
  const b = req.body || {};
  const guest_name = (b.guest_name || '').trim();
  const guest_email = (b.guest_email || '').trim();
  const property_id = b.property_id ? Number(b.property_id) : null;
  const check_in = b.check_in || null;
  if (!guest_email || !property_id || !check_in) {
    return err(res, 400, 'guest_email, property_id and check_in are required');
  }
  const property = tableFind('properties', property_id);
  if (!property || !property.public_bookable) {
    return err(res, 400, 'property is not bookable');
  }
  const row = tableInsert('booking_requests', {
    property_id,
    guest_name,
    guest_email,
    guest_phone: (b.guest_phone || '').trim(),
    check_in,
    check_out: b.check_out || null,
    proposed_amount: Number(b.proposed_amount) || 0,
    message: (b.message || '').trim(),
    status: 'pending',
    approved_booking_id: null,
  });
  ok(res, joinBookingRequest(row));
});

// ====================================================================
// PROFIT & AUTOMATION FEATURES (Phases C–H)
// ====================================================================

// ---------- EXPENSES ----------
app.get('/api/expenses', (req, res) => {
  let rows = tableAll('expenses').map(joinExpense);
  if (req.query.property_id) rows = rows.filter(e => String(e.property_id) === String(req.query.property_id));
  if (req.query.year) rows = rows.filter(e => (e.date || '').slice(0, 4) === String(req.query.year));
  ok(res, rows.sort((a, b) => (b.date || '').localeCompare(a.date || '')));
});
app.post('/api/expenses', (req, res) => {
  const b = req.body || {};
  if (!b.amount) return err(res, 400, 'amount required');
  ok(res, joinExpense(tableInsert('expenses', {
    property_id: b.property_id ? Number(b.property_id) : null,
    date: b.date || nowIso().slice(0, 10),
    category: b.category || 'Other',
    amount: Number(b.amount) || 0,
    vendor: b.vendor || '',
    notes: b.notes || '',
    recurring: b.recurring ? 1 : 0,
  })));
});
app.put('/api/expenses/:id', (req, res) => {
  const b = req.body || {};
  const patch = {};
  ['date', 'category', 'vendor', 'notes'].forEach(k => { if (b[k] != null) patch[k] = b[k]; });
  if (b.amount != null) patch.amount = Number(b.amount) || 0;
  if (b.property_id !== undefined) patch.property_id = b.property_id ? Number(b.property_id) : null;
  if (b.recurring != null) patch.recurring = b.recurring ? 1 : 0;
  const row = tableUpdate('expenses', req.params.id, patch);
  if (!row) return err(res, 404, 'not found'); ok(res, joinExpense(row));
});
app.delete('/api/expenses/:id', (req, res) => { tableRemove('expenses', req.params.id); ok(res, { ok: true }); });

// ---------- UPSELLS (catalog) ----------
app.get('/api/upsells', (req, res) => ok(res, tableAll('upsells').sort((a, b) => (a.name || '').localeCompare(b.name || ''))));
app.post('/api/upsells', (req, res) => {
  const b = req.body || {};
  if (!b.name) return err(res, 400, 'name required');
  ok(res, tableInsert('upsells', { name: b.name, default_price: Number(b.default_price) || 0, active: b.active === 0 ? 0 : 1 }));
});
app.put('/api/upsells/:id', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.name != null) patch.name = b.name;
  if (b.default_price != null) patch.default_price = Number(b.default_price) || 0;
  if (b.active != null) patch.active = b.active ? 1 : 0;
  const row = tableUpdate('upsells', req.params.id, patch);
  if (!row) return err(res, 404, 'not found'); ok(res, row);
});
app.delete('/api/upsells/:id', (req, res) => { tableRemove('upsells', req.params.id); ok(res, { ok: true }); });

// ---------- BOOKING UPSELLS (per-booking add-ons) ----------
app.get('/api/booking-upsells', (req, res) => {
  let rows = tableAll('booking_upsells');
  if (req.query.booking_id) rows = rows.filter(u => String(u.booking_id) === String(req.query.booking_id));
  ok(res, rows);
});
app.post('/api/booking-upsells', (req, res) => {
  const b = req.body || {};
  if (!b.booking_id || !b.name) return err(res, 400, 'booking_id and name required');
  ok(res, tableInsert('booking_upsells', {
    booking_id: Number(b.booking_id), name: b.name,
    price: Number(b.price) || 0, qty: Number(b.qty) || 1,
  }));
});
app.delete('/api/booking-upsells/:id', (req, res) => { tableRemove('booking_upsells', req.params.id); ok(res, { ok: true }); });

// ---------- REVIEWS ----------
app.get('/api/reviews', (req, res) => ok(res, tableAll('reviews').map(joinReview).sort((a, b) => (b.review_date || '').localeCompare(a.review_date || ''))));
app.post('/api/reviews', (req, res) => {
  const b = req.body || {};
  ok(res, joinReview(tableInsert('reviews', {
    booking_id: b.booking_id ? Number(b.booking_id) : null,
    property_id: b.property_id ? Number(b.property_id) : null,
    platform: b.platform || '', rating: Number(b.rating) || 0,
    text: b.text || '', review_date: b.review_date || nowIso().slice(0, 10),
  })));
});
app.put('/api/reviews/:id', (req, res) => {
  const b = req.body || {}; const patch = {};
  ['platform', 'text', 'review_date'].forEach(k => { if (b[k] != null) patch[k] = b[k]; });
  if (b.rating != null) patch.rating = Number(b.rating) || 0;
  if (b.property_id !== undefined) patch.property_id = b.property_id ? Number(b.property_id) : null;
  const row = tableUpdate('reviews', req.params.id, patch);
  if (!row) return err(res, 404, 'not found'); ok(res, joinReview(row));
});
app.delete('/api/reviews/:id', (req, res) => { tableRemove('reviews', req.params.id); ok(res, { ok: true }); });

// ---------- SETTINGS ----------
app.get('/api/settings', (req, res) => {
  const out = {}; tableAll('settings').forEach(s => { out[s.key] = s.value; }); ok(res, out);
});
app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  for (const [key, value] of Object.entries(body)) {
    const existing = store.settings.find(s => s.key === key);
    if (existing) tableUpdate('settings', existing.id, { value });
    else tableInsert('settings', { key, value });
  }
  const out = {}; tableAll('settings').forEach(s => { out[s.key] = s.value; }); ok(res, out);
});

// ---------- CHANNEL ECONOMICS (booking type fee config) ----------
app.put('/api/booking-types/:id', (req, res) => {
  const b = req.body || {}; const patch = {};
  if (b.fee_percent != null) patch.fee_percent = Number(b.fee_percent) || 0;
  if (b.fee_fixed != null) patch.fee_fixed = Number(b.fee_fixed) || 0;
  if (b.is_direct != null) patch.is_direct = b.is_direct ? 1 : 0;
  if (b.name != null) patch.name = b.name;
  const row = tableUpdate('booking_types', req.params.id, patch);
  if (!row) return err(res, 404, 'not found'); ok(res, row);
});

// ---------- FINANCIALS / NET PROFIT ----------
function computeFinancials(year, propertyId) {
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const pid = propertyId ? Number(propertyId) : null;
  const bookings = tableAll('bookings').map(joinBooking)
    .filter(b => b.status !== 'cancelled' && b.check_in >= yStart && b.check_in <= yEnd)
    .filter(b => !pid || b.property_id === pid);
  const expenses = tableAll('expenses').filter(e => (e.date || '') >= yStart && (e.date || '') <= yEnd)
    .filter(e => !pid || e.property_id === pid);
  const gross = bookings.reduce((a, b) => a + (b.amount || 0), 0);
  const upsell = bookings.reduce((a, b) => a + (b.upsell_total || 0), 0);
  const fees = bookings.reduce((a, b) => a + (b.platform_fee || 0), 0);
  const totalExpenses = expenses.reduce((a, e) => a + (e.amount || 0), 0);
  const totalRevenue = gross + upsell;
  const netProfit = +(totalRevenue - fees - totalExpenses).toFixed(2);
  const margin = totalRevenue > 0 ? +(netProfit / totalRevenue).toFixed(3) : 0;
  const byProperty = tableAll('properties').filter(p => !pid || p.id === pid).map(p => {
    const bs = bookings.filter(b => b.property_id === p.id);
    const rev = bs.reduce((a, b) => a + (b.amount || 0) + (b.upsell_total || 0), 0);
    const fee = bs.reduce((a, b) => a + (b.platform_fee || 0), 0);
    const exp = expenses.filter(e => e.property_id === p.id).reduce((a, e) => a + (e.amount || 0), 0);
    const net = +(rev - fee - exp).toFixed(2);
    return { id: p.id, nickname: p.nickname, revenue: +rev.toFixed(2), fees: +fee.toFixed(2), expenses: +exp.toFixed(2), net_profit: net, margin: rev > 0 ? +(net / rev).toFixed(3) : 0 };
  }).sort((a, b) => b.net_profit - a.net_profit);
  const byChannel = tableAll('booking_types').map(t => {
    const bs = bookings.filter(b => b.booking_type_id === t.id);
    const rev = bs.reduce((a, b) => a + (b.amount || 0) + (b.upsell_total || 0), 0);
    const fee = bs.reduce((a, b) => a + (b.platform_fee || 0), 0);
    return { type: t.name, fee_percent: Number(t.fee_percent) || 0, fee_fixed: Number(t.fee_fixed) || 0, is_direct: t.is_direct ? 1 : 0, bookings: bs.length, revenue: +rev.toFixed(2), fees: +fee.toFixed(2), net: +(rev - fee).toFixed(2), effective_rate: rev > 0 ? +((rev - fee) / rev).toFixed(3) : 0 };
  }).filter(c => c.bookings > 0).sort((a, b) => b.net - a.net);
  const byCategory = {};
  expenses.forEach(e => { const k = e.category || 'Other'; byCategory[k] = (byCategory[k] || 0) + (e.amount || 0); });
  const expenseCategories = Object.entries(byCategory).map(([category, amount]) => ({ category, amount: +amount.toFixed(2) })).sort((a, b) => b.amount - a.amount);
  const pnl = [];
  for (let m = 0; m < 12; m++) {
    const ms = `${year}-${String(m + 1).padStart(2, '0')}`;
    const mb = bookings.filter(b => (b.check_in || '').slice(0, 7) === ms);
    const rev = mb.reduce((a, b) => a + (b.amount || 0) + (b.upsell_total || 0), 0);
    const fee = mb.reduce((a, b) => a + (b.platform_fee || 0), 0);
    const exp = expenses.filter(e => (e.date || '').slice(0, 7) === ms).reduce((a, e) => a + (e.amount || 0), 0);
    pnl.push({ month: m + 1, label: new Date(year, m, 1).toLocaleString('en-US', { month: 'short' }), revenue: +rev.toFixed(2), fees: +fee.toFixed(2), expenses: +exp.toFixed(2), net: +(rev - fee - exp).toFixed(2) });
  }
  const taxPct = Number(getSetting('tax_setaside_percent', 25)) || 0;
  return {
    year, total_revenue: +totalRevenue.toFixed(2), gross_booking_revenue: +gross.toFixed(2), ancillary_revenue: +upsell.toFixed(2),
    platform_fees: +fees.toFixed(2), total_expenses: +totalExpenses.toFixed(2), net_profit: netProfit, margin,
    tax_setaside_percent: taxPct, tax_setaside: +(netProfit * taxPct / 100).toFixed(2),
    by_property: byProperty, by_channel: byChannel, expense_categories: expenseCategories, pnl_by_month: pnl,
  };
}
function computeMetrics(year, propertyId) {
  const pid = propertyId ? Number(propertyId) : null;
  const all = tableAll('bookings').map(joinBooking).filter(b => !pid || b.property_id === pid);
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const ytd = all.filter(b => b.check_in >= yStart && b.check_in <= yEnd);
  const active = ytd.filter(b => b.status !== 'cancelled');
  const leads = active.map(b => { if (!b.created_at || !b.check_in) return null; const d = Math.round((new Date(b.check_in) - new Date(b.created_at)) / 86400000); return d >= 0 ? d : null; }).filter(x => x != null);
  const avgLead = leads.length ? Math.round(leads.reduce((a, x) => a + x, 0) / leads.length) : 0;
  const los = active.map(b => (b.check_in && b.check_out) ? Math.max(1, Math.round((new Date(b.check_out) - new Date(b.check_in)) / 86400000)) : null).filter(x => x != null);
  const avgLos = los.length ? +(los.reduce((a, x) => a + x, 0) / los.length).toFixed(1) : 0;
  const cancelled = ytd.filter(b => b.status === 'cancelled').length;
  const cancelRate = ytd.length ? +(cancelled / ytd.length).toFixed(3) : 0;
  const byGuest = {}; all.forEach(b => { if (b.guest_id) byGuest[b.guest_id] = (byGuest[b.guest_id] || 0) + 1; });
  const guestsWithBookings = Object.keys(byGuest).length;
  const repeatGuests = Object.values(byGuest).filter(c => c > 1).length;
  const repeatRate = guestsWithBookings ? +(repeatGuests / guestsWithBookings).toFixed(3) : 0;
  const directCount = active.filter(b => b.booking_type_is_direct).length;
  const directPct = active.length ? +(directCount / active.length).toFixed(3) : 0;
  const reviews = tableAll('reviews').filter(r => !pid || r.property_id === pid);
  const reviewCount = reviews.length;
  const avgRating = reviewCount ? +(reviews.reduce((a, r) => a + (Number(r.rating) || 0), 0) / reviewCount).toFixed(2) : 0;
  const cleaningExp = tableAll('expenses').filter(e => (!pid || e.property_id === pid) && (e.date || '').slice(0, 4) === String(year) && /clean/i.test(e.category || '')).reduce((a, e) => a + (e.amount || 0), 0);
  const costPerTurnover = active.length ? +(cleaningExp / active.length).toFixed(2) : 0;
  const rev = y => all.filter(b => b.status !== 'cancelled' && (b.check_in || '').slice(0, 4) === String(y)).reduce((a, b) => a + (b.amount || 0) + (b.upsell_total || 0), 0);
  const revThis = rev(year), revLast = rev(year - 1);
  const yoy = revLast > 0 ? +(((revThis - revLast) / revLast)).toFixed(3) : null;
  return { avg_lead_time_days: avgLead, avg_length_of_stay: avgLos, cancellation_rate: cancelRate, repeat_guest_rate: repeatRate, direct_booking_pct: directPct, review_count: reviewCount, avg_rating: avgRating, cost_per_turnover: costPerTurnover, yoy_revenue_change: yoy, revenue_this_year: +revThis.toFixed(2), revenue_last_year: +revLast.toFixed(2) };
}
app.get('/api/financials', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const propertyId = req.query.property_id ? Number(req.query.property_id) : null;
  ok(res, { ...computeFinancials(year, propertyId), metrics: computeMetrics(year, propertyId), property_id: propertyId });
});

// ---------- ORPHAN / GAP NIGHTS ----------
function computeOrphans(maxGap) {
  maxGap = maxGap || 2;
  const today = new Date().toISOString().slice(0, 10);
  const events = buildCalendarEvents().filter(e => ['booking', 'reserved', 'block'].includes(e.kind));
  const byProp = {};
  events.forEach(e => { if (!e.property_id || !e.start) return; (byProp[e.property_id] = byProp[e.property_id] || []).push({ start: e.start, end: effEnd(e.start, e.end) }); });
  const out = [];
  for (const pid of Object.keys(byProp)) {
    const ivs = byProp[pid].sort((a, b) => a.start.localeCompare(b.start));
    const merged = [];
    for (const iv of ivs) { const last = merged[merged.length - 1]; if (last && iv.start <= last.end) { if (iv.end > last.end) last.end = iv.end; } else merged.push({ ...iv }); }
    for (let i = 0; i < merged.length - 1; i++) {
      const gapStart = merged[i].end, gapEnd = merged[i + 1].start;
      if (gapEnd <= gapStart) continue;
      const nights = Math.round((new Date(gapEnd) - new Date(gapStart)) / 86400000);
      if (nights >= 1 && nights <= maxGap && gapEnd >= today) {
        const p = tableFind('properties', Number(pid));
        out.push({ property_id: Number(pid), property_name: p?.nickname || null, gap_start: gapStart, gap_end: gapEnd, nights });
      }
    }
  }
  return out.sort((a, b) => a.gap_start.localeCompare(b.gap_start));
}
app.get('/api/orphans', (req, res) => ok(res, computeOrphans(Number(req.query.max) || 2)));

// Potential revenue if remaining vacant nights (in fillable runs >= minStay) were booked,
// from `start` through `end`, for the given properties. Rate = PriceLabs recommended (cached)
// per night, falling back to each property's ADR.
function computePotentialRevenue(propIds, start, end, adrByProp, minStay) {
  minStay = minStay || 3;
  const events = buildCalendarEvents().filter(e => ['booking', 'reserved', 'block'].includes(e.kind));
  const occByProp = {};
  events.forEach(e => {
    if (!e.start) return;
    const eEnd = (e.end && e.end > e.start) ? e.end : addDays(e.start, 1);
    let d = e.start > start ? e.start : start;
    while (d < eEnd) { (occByProp[e.property_id] = occByProp[e.property_id] || new Set()).add(d); d = addDays(d, 1); }
  });
  const priceMap = {};
  tableAll('price_cache').forEach(c => { (priceMap[c.property_id] = priceMap[c.property_id] || {})[c.date] = Number(c.recommended_price) || 0; });
  const by_property = []; let total = 0, totalNights = 0;
  for (const pid of propIds) {
    const p = tableFind('properties', pid); if (!p) continue;
    const occ = occByProp[pid] || new Set();
    const vacant = []; let d = start;
    while (d < end) { if (!occ.has(d)) vacant.push(d); d = addDays(d, 1); }
    let revenue = 0, fillNights = 0, run = [];
    const flush = () => {
      if (run.length >= minStay) run.forEach(dt => { revenue += (priceMap[pid] && priceMap[pid][dt]) || adrByProp[pid] || 0; fillNights++; });
      run = [];
    };
    for (let i = 0; i < vacant.length; i++) { if (run.length && vacant[i] !== addDays(run[run.length - 1], 1)) flush(); run.push(vacant[i]); }
    flush();
    by_property.push({ id: pid, nickname: p.nickname, fillable_nights: fillNights, potential_revenue: +revenue.toFixed(2), rate_source: (priceMap[pid] && Object.keys(priceMap[pid]).length) ? 'PriceLabs rates' : 'avg nightly rate' });
    total += revenue; totalNights += fillNights;
  }
  return { total: +total.toFixed(2), fillable_nights: totalNights, min_stay: minStay, start, end, by_property: by_property.sort((a, b) => b.potential_revenue - a.potential_revenue) };
}

// ---------- PER-PROPERTY PERFORMANCE STATS ----------
// Occupied-night sets per property from the reconciled calendar (bookings + platform
// reservations, mirrors already collapsed) — includes past years, so YOY works.
function occupiedNightSets() {
  const occ = {};
  for (const e of buildCalendarEvents()) {
    if ((e.kind !== 'booking' && e.kind !== 'reserved') || !e.start) continue;
    let d = e.start; const end = effEnd(e.start, e.end);
    while (d < end) { (occ[e.property_id] = occ[e.property_id] || new Set()).add(d); d = addDays(d, 1); }
  }
  return occ;
}
function countOccupiedNights(occSet, start, end) {
  if (!occSet) return 0;
  let n = 0, d = start;
  while (d < end) { if (occSet.has(d)) n++; d = addDays(d, 1); }
  return n;
}
// Revenue allocated per-night from real bookings inside [start, end). Platform
// "reserved" events carry no amount, so revenue comes from bookings only.
function revenueInWindow(bookings, pid, start, end) {
  let rev = 0, nights = 0;
  for (const b of bookings) {
    if (b.property_id !== pid || !b.check_in) continue;
    const nw = nightsInWindow(b.check_in, b.check_out, start, end);
    if (!nw) continue;
    const len = daysBetween(b.check_in, b.check_out || b.check_in);
    rev += ((b.amount || 0) + (b.upsell_total || 0)) / len * nw;
    nights += nw;
  }
  return { revenue: +rev.toFixed(2), nights };
}
// Vacant Friday/Saturday nights in [start, end) — prime inventory going unsold.
function vacantWeekendNights(occSet, start, end) {
  let n = 0, d = start;
  while (d < end) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if ((dow === 5 || dow === 6) && !(occSet && occSet.has(d))) n++;
    d = addDays(d, 1);
  }
  return n;
}
function getListingMeta(pid) {
  const v = getSetting('listing_meta_' + pid, null);
  return (v && typeof v === 'object') ? v : { headline: '', description: '', amenities: '', target_guest: '' };
}
function computePropertyStats() {
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const occ = occupiedNightSets();
  const bookings = tableAll('bookings').map(joinBooking).filter(b => b.status !== 'cancelled' && b.check_in);
  const seasonStart = `${year}-${getSetting('season_start_md', '06-01')}`;
  const seasonEnd = `${year}-${getSetting('season_end_md', '10-01')}`;

  // Fallback ADR for the potential-revenue projection: season achieved rate.
  const adrByProp = {};
  for (const p of tableAll('properties')) {
    const s = revenueInWindow(bookings, p.id, seasonStart, seasonEnd);
    adrByProp[p.id] = s.nights ? +(s.revenue / s.nights).toFixed(2) : 0;
  }

  return tableAll('properties').sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '')).map(p => {
    const windows = {};
    for (const w of [14, 30, 60]) {
      const end = addDays(today, w);
      const nights = countOccupiedNights(occ[p.id], today, end);
      const rw = revenueInWindow(bookings, p.id, today, end);
      const pot = computePotentialRevenue([p.id], today, end, adrByProp, 3).by_property[0] || {};
      windows['next_' + w] = {
        days: w,
        occupied_nights: nights,
        occupancy: +(nights / w).toFixed(3),
        revenue: rw.revenue,
        adr: rw.nights ? +(rw.revenue / rw.nights).toFixed(2) : null,
        potential_revenue: pot.potential_revenue || 0,
        fillable_nights: pot.fillable_nights || 0,
        vacant_weekend_nights: vacantWeekendNights(occ[p.id], today, end),
      };
    }

    // July + August — the money window (62 days).
    const jaStart = `${year}-07-01`, jaEnd = `${year}-09-01`, jaDays = 62;
    const jaNights = countOccupiedNights(occ[p.id], jaStart, jaEnd);
    const jaRev = revenueInWindow(bookings, p.id, jaStart, jaEnd);
    const lyJaNights = countOccupiedNights(occ[p.id], `${year - 1}-07-01`, `${year - 1}-09-01`);
    const lyJaRev = revenueInWindow(bookings, p.id, `${year - 1}-07-01`, `${year - 1}-09-01`);

    // Whole season, this year vs last.
    const seasonRev = revenueInWindow(bookings, p.id, seasonStart, seasonEnd);
    const lySeasonStart = `${year - 1}${seasonStart.slice(4)}`, lySeasonEnd = `${year - 1}${seasonEnd.slice(4)}`;
    const lySeasonRev = revenueInWindow(bookings, p.id, lySeasonStart, lySeasonEnd);
    const adrAchieved = seasonRev.nights ? +(seasonRev.revenue / seasonRev.nights).toFixed(2) : null;
    const lyAdr = lySeasonRev.nights ? +(lySeasonRev.revenue / lySeasonRev.nights).toFixed(2) : null;

    // Average PriceLabs recommended rate over the next 30 days (if cached).
    const plNext30 = store.price_cache.filter(c => c.property_id === p.id && c.date >= today && c.date < addDays(today, 30));
    const plAvg30 = plNext30.length ? +(plNext30.reduce((a, c) => a + (Number(c.recommended_price) || 0), 0) / plNext30.length).toFixed(2) : null;

    return {
      id: p.id, nickname: p.nickname,
      listing: getListingMeta(p.id),
      windows,
      july_august: {
        days: jaDays,
        occupied_nights: jaNights,
        occupancy: +(jaNights / jaDays).toFixed(3),
        revenue: jaRev.revenue,
        last_year: {
          occupied_nights: lyJaNights,
          occupancy: +(lyJaNights / jaDays).toFixed(3),
          revenue: lyJaRev.revenue,
        },
      },
      season: {
        start: seasonStart, end: seasonEnd,
        revenue: seasonRev.revenue, nights: seasonRev.nights, adr_achieved: adrAchieved,
        last_year: { revenue: lySeasonRev.revenue, nights: lySeasonRev.nights, adr: lyAdr },
        yoy_revenue_pct: lySeasonRev.revenue > 0 ? +(((seasonRev.revenue - lySeasonRev.revenue) / lySeasonRev.revenue)).toFixed(3) : null,
      },
      pricelabs_avg_next_30: plAvg30,
    };
  });
}
app.get('/api/property-stats', (req, res) => ok(res, {
  generated_at: nowIso(),
  today: new Date().toISOString().slice(0, 10),
  properties: computePropertyStats(),
}));

// Listing copy (headline/description/amenities) lives in settings — used by Insights.
app.put('/api/properties/:id/listing-meta', (req, res) => {
  const p = tableFind('properties', req.params.id);
  if (!p) return err(res, 404, 'property not found');
  const b = req.body || {};
  const meta = {
    headline: String(b.headline || ''),
    description: String(b.description || ''),
    amenities: String(b.amenities || ''),
    target_guest: String(b.target_guest || ''),
  };
  const key = 'listing_meta_' + p.id;
  const existing = store.settings.find(s => s.key === key);
  if (existing) tableUpdate('settings', existing.id, { value: meta }); else tableInsert('settings', { key, value: meta });
  ok(res, meta);
});

// ---------- ANNUAL ROI / CASH-ON-CASH P&L ----------
// Buildings group properties that share one mortgage/tax bill (Retreat + Hideaway are
// both 4488 East Road). Inputs are saved in settings key `roi_<year>`; STR revenue and
// app-tracked operating costs are pulled live from bookings/expenses. No new tables.
const ROI_BUILDINGS = [
  { key: '4488-east-road', name: '4488 East Road', sub: 'Retreat + Hideaway', nicknames: ['Retreat', 'Hideaway'] },
  { key: '4490-east-road', name: '4490 East Road', sub: 'Escape', nicknames: ['Escape'] },
  { key: '479-george-street', name: '479 George Street', sub: 'Look Out', nicknames: ['Look Out'] },
];
const ROI_EXPENSE_ITEMS = [
  ['insurance', 'Insurance'],
  ['property_taxes', 'Property taxes'],
  ['maintenance', 'Maintenance & repairs'],
  ['electricity', 'Electricity'],
  ['natural_gas', 'Natural gas'],
  ['water', 'Water'],
  ['internet', 'Internet'],
  ['str_license', 'Short-term rental license'],
  ['management', 'Management & admin'],
  ['other_expense', 'Other expenses'],
];
// Seed values: 2025 actuals from Matt's "Real Estate Summary" workbook; 2026 carries the
// recurring costs forward. 479 George is new — utility/insurance/tax/license figures are
// ESTIMATES (flagged in notes) until real bills replace them.
const ROI_SEEDS = {
  2025: {
    '4488-east-road': {
      insurance: 1412.05, property_taxes: 5365.67, maintenance: 2948.36,
      electricity: 2127.67, natural_gas: 994.07, water: 1533.95, internet: 816.87,
      str_license: 0, management: 0, other_expense: 316.17,
      other_income: 49175, other_income_note: 'Long-term rent (tenant year)',
      property_value: 700000, debt_balance: 400534, mortgage_rate_pct: 5.33,
      mortgage_interest_override: 21344.72, cash_invested: 0, ownership_pct: 50,
      notes: '2025 actuals from the Real Estate Summary workbook. Interest is the actual $21,344.72 paid.',
    },
    '4490-east-road': {
      insurance: 1035, property_taxes: 1311.55, maintenance: 538.81,
      electricity: 594.14, natural_gas: 269.76, water: 725.05, internet: 395.21,
      str_license: 0, management: 0, other_expense: 0,
      other_income: 0, other_income_note: '',
      property_value: 550000, debt_balance: 247624.54, mortgage_rate_pct: 4.65,
      mortgage_interest_override: 4649.54, cash_invested: 0, ownership_pct: 100,
      notes: '2025 actuals (renovation year — interest $4,649.54 was a partial year).',
    },
    '479-george-street': {
      insurance: 0, property_taxes: 0, maintenance: 0, electricity: 0, natural_gas: 0,
      water: 0, internet: 0, str_license: 0, management: 0, other_expense: 0,
      other_income: 0, other_income_note: '', property_value: 0, debt_balance: 0,
      mortgage_rate_pct: 0, mortgage_interest_override: 0, cash_invested: 0, ownership_pct: 100,
      notes: 'Not owned/operated in 2025.',
    },
  },
  2026: {
    '4488-east-road': {
      insurance: 1450, property_taxes: 5500, maintenance: 3000,
      electricity: 2200, natural_gas: 1000, water: 1550, internet: 820,
      str_license: 0, management: 0, other_expense: 0,
      other_income: 0, other_income_note: 'Add any long-term rent collected before the June 2026 STR switch',
      property_value: 700000, debt_balance: 400534, mortgage_rate_pct: 5.33,
      mortgage_interest_override: 0, cash_invested: 0, ownership_pct: 50,
      notes: 'Recurring costs carried from 2025 actuals (rounded). Interest computed from balance × rate.',
    },
    '4490-east-road': {
      insurance: 1050, property_taxes: 1350, maintenance: 600,
      electricity: 1200, natural_gas: 550, water: 900, internet: 480,
      str_license: 0, management: 0, other_expense: 0,
      other_income: 0, other_income_note: '',
      property_value: 550000, debt_balance: 247624.54, mortgage_rate_pct: 4.65,
      mortgage_interest_override: 0, cash_invested: 0, ownership_pct: 100,
      notes: 'Utilities scaled up from the 2025 part-year actuals to a full operating year (estimates).',
    },
    '479-george-street': {
      insurance: 2400, property_taxes: 3200, maintenance: 1200,
      electricity: 1800, natural_gas: 1000, water: 900, internet: 720,
      str_license: 750, management: 0, other_expense: 0,
      other_income: 0, other_income_note: '',
      property_value: 0, debt_balance: 0, mortgage_rate_pct: 0,
      mortgage_interest_override: 0, cash_invested: 0, ownership_pct: 100,
      owned_from: '2026-05-11',
      notes: 'Closed May 11 2026 — annual costs are prorated to the ownership period. ALL EXPENSE LINES ARE ESTIMATES (new property, listed July 2026) — replace with real bills. Fill in property value, mortgage balance and rate to complete the return calc.',
    },
  },
};
function getRoiInputs(year) {
  const saved = getSetting('roi_' + year, null) || {};
  const seed = ROI_SEEDS[year] || ROI_SEEDS[2026] || {};
  const out = {};
  for (const b of ROI_BUILDINGS) {
    out[b.key] = { ...(seed[b.key] || {}), ...(saved[b.key] || {}) };
  }
  return out;
}
function computeRoi(year) {
  const inputs = getRoiInputs(year);
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const today = new Date().toISOString().slice(0, 10);
  const bookings = tableAll('bookings').map(joinBooking)
    .filter(b => b.status !== 'cancelled' && b.check_in >= yStart && b.check_in <= yEnd);
  const expenses = tableAll('expenses').filter(e => (e.date || '') >= yStart && (e.date || '') <= yEnd);
  const props = tableAll('properties');
  const num = v => Number(v) || 0;
  // Airbnb season boundaries (settings-driven; default Jun 1 – Oct 1).
  const seasonStart = `${year}-${getSetting('season_start_md', '06-01')}`;
  const seasonEnd = `${year}-${getSetting('season_end_md', '10-01')}`;
  const daysInYear = Math.round((Date.parse(`${year + 1}-01-01`) - Date.parse(`${year}-01-01`)) / 86400000);

  // Season ADR fallback for the remaining-potential projection.
  const adrByProp = {};
  for (const p of props) {
    const s = revenueInWindow(bookings, p.id, seasonStart, seasonEnd);
    adrByProp[p.id] = s.nights ? +(s.revenue / s.nights).toFixed(2) : 0;
  }

  const buildings = ROI_BUILDINGS.map(b => {
    const inp = inputs[b.key] || {};
    const propIds = props.filter(p => b.nicknames.some(n => (p.nickname || '').toLowerCase() === n.toLowerCase())).map(p => p.id);
    const bs = bookings.filter(x => propIds.includes(x.property_id));
    const str_gross = +bs.reduce((a, x) => a + (x.amount || 0) + (x.upsell_total || 0), 0).toFixed(2);
    const platform_fees = +bs.reduce((a, x) => a + (x.platform_fee || 0), 0).toFixed(2);
    const str_net = +(str_gross - platform_fees).toFixed(2);
    const tracked_costs = +expenses.filter(e => propIds.includes(e.property_id)).reduce((a, e) => a + (e.amount || 0), 0).toFixed(2);

    // Ownership period: annual cost inputs and rate-based interest are prorated to the
    // days actually owned (479 George closed May 11 2026 → ~64% of the year).
    const ownedFrom = (inp.owned_from && String(inp.owned_from) >= yStart) ? String(inp.owned_from) : yStart;
    const ownedTo = (inp.owned_to && String(inp.owned_to) <= yEnd) ? String(inp.owned_to) : yEnd;
    const ownedDays = Math.max(0, Math.round((Date.parse(ownedTo) - Date.parse(ownedFrom)) / 86400000) + 1);
    const ownedFraction = Math.min(1, ownedDays / daysInYear);

    // Seasonal income segments (net of platform fees, by check-in date).
    const netOf = x => (x.amount || 0) + (x.upsell_total || 0) - (x.platform_fee || 0);
    const seg = (from, to) => +bs.filter(x => x.check_in >= from && x.check_in < to).reduce((a, x) => a + netOf(x), 0).toFixed(2);
    const segments = {
      pre: { label: `Before season (Jan 1 – ${seasonStart.slice(5)})`, revenue: seg(yStart, seasonStart) },
      season: { label: `Airbnb season (${seasonStart.slice(5)} – ${seasonEnd.slice(5)})`, revenue: seg(seasonStart, seasonEnd) },
      post: { label: `After season (${seasonEnd.slice(5)} – Dec 31)`, revenue: seg(seasonEnd, addDays(yEnd, 1)) },
    };

    // Monthly per-property breakdown (net revenue by check-in month).
    const by_property = propIds.map(pid => {
      const p = props.find(x => x.id === pid);
      const monthly = Array.from({ length: 12 }, () => 0);
      bs.filter(x => x.property_id === pid).forEach(x => { monthly[Number(x.check_in.slice(5, 7)) - 1] += netOf(x); });
      const rounded = monthly.map(v => +v.toFixed(2));
      return { id: pid, nickname: p ? p.nickname : String(pid), monthly: rounded, total: +rounded.reduce((a, v) => a + v, 0).toFixed(2) };
    });
    const monthly_total = Array.from({ length: 12 }, (_, m) => +by_property.reduce((a, p) => a + p.monthly[m], 0).toFixed(2));

    // Remaining season potential: vacant 3+ night runs from today through season end.
    let potential_remaining_season = 0;
    if (String(year) === today.slice(0, 4) && today < seasonEnd && propIds.length) {
      const projStart = today > seasonStart ? today : seasonStart;
      potential_remaining_season = +computePotentialRevenue(propIds, projStart, seasonEnd, adrByProp, 3).total.toFixed(2);
    }

    const line_items = ROI_EXPENSE_ITEMS.map(([k, label]) => ({ key: k, label, amount: num(inp[k]), prorated: +(num(inp[k]) * ownedFraction).toFixed(2) }));
    const input_opex = +line_items.reduce((a, li) => a + li.prorated, 0).toFixed(2);
    const other_income = num(inp.other_income);
    const total_income = +(str_net + other_income).toFixed(2);
    const total_opex = +(input_opex + tracked_costs).toFixed(2);
    const noi = +(total_income - total_opex).toFixed(2);

    const debt = num(inp.debt_balance);
    const rate = num(inp.mortgage_rate_pct);
    const override = num(inp.mortgage_interest_override);
    const mortgage_interest = +(override > 0 ? override : debt * rate / 100 * ownedFraction).toFixed(2);
    const cash_flow = +(noi - mortgage_interest).toFixed(2);

    // Trending / forecast: season books out its 3+ night gaps, and each off-season MONTH
    // hits your forecast (per-month, whichever is higher — already-booked or forecast).
    // Off-season months are editable individually so long-term tenant rent (e.g. 4488's
    // Jan–May tenants) can be entered month by month. Legacy single-figure fields are
    // honoured when no monthly forecast has been saved.
    const seasonStartMonth = Number(seasonStart.slice(5, 7));
    const seasonEndMonth = Number(seasonEnd.slice(5, 7));
    const preMonthNums = []; for (let m = 1; m < seasonStartMonth; m++) preMonthNums.push(m);
    const postMonthNums = []; for (let m = seasonEndMonth; m <= 12; m++) postMonthNums.push(m);
    const fmRaw = (inp.forecast_monthly && typeof inp.forecast_monthly === 'object') ? inp.forecast_monthly : null;
    const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fcMonth = m => fmRaw ? num(fmRaw[m]) : null;
    const monthRow = m => ({ month: m, label: MONTH_LABELS[m - 1], actual: monthly_total[m - 1], forecast: fcMonth(m) ?? 0, used: Math.max(monthly_total[m - 1], fcMonth(m) ?? 0) });
    let pre_months = preMonthNums.map(monthRow);
    let post_months = postMonthNums.map(monthRow);
    // Legacy fallback: an old single pre/post figure spreads over its window for trending.
    if (!fmRaw && num(inp.forecast_preseason_income)) {
      const used = Math.max(num(inp.forecast_preseason_income), segments.pre.revenue);
      pre_months = pre_months.map(r => ({ ...r, forecast: null }));
      pre_months._legacyTotal = used;
    }
    if (!fmRaw && num(inp.forecast_offseason_income)) {
      const used = Math.max(num(inp.forecast_offseason_income), segments.post.revenue);
      post_months = post_months.map(r => ({ ...r, forecast: null }));
      post_months._legacyTotal = used;
    }
    const fcPre = pre_months._legacyTotal != null ? pre_months._legacyTotal : +pre_months.reduce((a, r) => a + r.used, 0).toFixed(2);
    const fcPost = post_months._legacyTotal != null ? post_months._legacyTotal : +post_months.reduce((a, r) => a + r.used, 0).toFixed(2);
    const trending_income = +(fcPre + segments.season.revenue + potential_remaining_season + fcPost + other_income).toFixed(2);
    const trending_noi = +(trending_income - total_opex).toFixed(2);
    const trending_cash_flow = +(trending_noi - mortgage_interest).toFixed(2);

    const value = num(inp.property_value);
    const equity = +(value - debt).toFixed(2);
    const cashBase = num(inp.cash_invested) > 0 ? num(inp.cash_invested) : equity;
    const ownership = num(inp.ownership_pct) > 0 ? num(inp.ownership_pct) / 100 : 1;
    return {
      key: b.key, name: b.name, sub: b.sub, property_ids: propIds,
      inputs: inp,
      computed: {
        str_gross, platform_fees, str_net, tracked_costs, other_income,
        segments, by_property, monthly_total,
        potential_remaining_season,
        total_income, input_opex, total_opex, noi,
        mortgage_interest, interest_source: override > 0 ? 'actual (override)' : 'balance × rate' + (ownedFraction < 1 ? ' × owned period' : ''),
        cash_flow, equity,
        ownership_period: { from: ownedFrom, to: ownedTo, days: ownedDays, fraction: +ownedFraction.toFixed(3) },
        trending: {
          income: trending_income, noi: trending_noi, cash_flow: trending_cash_flow,
          cash_on_cash: cashBase > 0 ? +(trending_cash_flow / cashBase).toFixed(4) : null,
          preseason_used: +fcPre.toFixed(2), postseason_used: +fcPost.toFixed(2),
        },
        forecast: {
          pre_months: pre_months.map(r => ({ month: r.month, label: r.label, actual: r.actual, forecast: r.forecast, used: r.used })),
          post_months: post_months.map(r => ({ month: r.month, label: r.label, actual: r.actual, forecast: r.forecast, used: r.used })),
          pre_total: +fcPre.toFixed(2), post_total: +fcPost.toFixed(2),
          legacy_mode: !fmRaw && !!(num(inp.forecast_preseason_income) || num(inp.forecast_offseason_income)),
        },
        cap_rate: value > 0 ? +(noi / value).toFixed(4) : null,
        cash_on_cash: cashBase > 0 ? +(cash_flow / cashBase).toFixed(4) : null,
        cash_basis: num(inp.cash_invested) > 0 ? 'cash invested' : 'equity (value − debt)',
        ownership_pct: ownership * 100,
        your_cash_flow: +(cash_flow * ownership).toFixed(2),
        your_trending_cash_flow: +(trending_cash_flow * ownership).toFixed(2),
      },
    };
  });
  const totals = {
    cash_flow: +buildings.reduce((a, b) => a + b.computed.cash_flow, 0).toFixed(2),
    your_cash_flow: +buildings.reduce((a, b) => a + b.computed.your_cash_flow, 0).toFixed(2),
    noi: +buildings.reduce((a, b) => a + b.computed.noi, 0).toFixed(2),
    total_income: +buildings.reduce((a, b) => a + b.computed.total_income, 0).toFixed(2),
    trending_cash_flow: +buildings.reduce((a, b) => a + b.computed.trending.cash_flow, 0).toFixed(2),
    your_trending_cash_flow: +buildings.reduce((a, b) => a + b.computed.your_trending_cash_flow, 0).toFixed(2),
  };
  return { year, season: { start: seasonStart, end: seasonEnd }, expense_items: ROI_EXPENSE_ITEMS.map(([key, label]) => ({ key, label })), buildings, totals };
}
app.get('/api/roi', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  ok(res, computeRoi(year));
});
app.put('/api/roi', (req, res) => {
  const b = req.body || {};
  const year = Number(b.year) || new Date().getFullYear();
  const incoming = b.buildings || {};
  const key = 'roi_' + year;
  const current = getSetting(key, null) || {};
  const merged = { ...current };
  for (const bld of ROI_BUILDINGS) {
    if (incoming[bld.key]) merged[bld.key] = { ...(current[bld.key] || {}), ...incoming[bld.key] };
  }
  const existing = store.settings.find(s => s.key === key);
  if (existing) tableUpdate('settings', existing.id, { value: merged }); else tableInsert('settings', { key, value: merged });
  ok(res, computeRoi(year));
});

// ---------- INSIGHTS ----------
// Rule-based, data-driven recommendations per property. severity: 'act' | 'watch' | 'good'.
function computeInsights() {
  const stats = computePropertyStats();
  const orphans = computeOrphans(2);
  const reviews = tableAll('reviews');
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const s of stats) {
    const tips = [];
    const w14 = s.windows.next_14, w30 = s.windows.next_30, w60 = s.windows.next_60;

    if (w14.occupancy < 0.4) {
      tips.push({ severity: 'act', title: `Next 14 days are ${Math.round(w14.occupancy * 100)}% booked`, detail: `Only ${w14.occupied_nights} of 14 nights are filled. This inventory expires worthless — consider a short-lead discount (10–15%), opening 2-night minimums, or a direct-booking promo to past guests. Filling the 3+ night gaps alone is worth ~${Math.round(w14.potential_revenue)}$.` });
    } else if (w14.occupancy >= 0.75) {
      tips.push({ severity: 'good', title: `Strong next 2 weeks (${Math.round(w14.occupancy * 100)}% booked)`, detail: `With ${w14.occupied_nights}/14 nights sold, you have pricing power — nudge rates up on the remaining nights rather than discounting.` });
    }

    if (w30.vacant_weekend_nights >= 3) {
      tips.push({ severity: 'act', title: `${w30.vacant_weekend_nights} weekend nights unsold in the next 30 days`, detail: `Fri/Sat nights are your premium inventory. Target these first: SMS your repeat guests (Mailing List tab), and check the rate isn't above PriceLabs' recommendation${s.pricelabs_avg_next_30 ? ` (~$${s.pricelabs_avg_next_30}/night rec. avg)` : ''}.` });
    }

    if (w30.adr != null && s.season.adr_achieved != null) {
      const diff = (w30.adr - s.season.adr_achieved) / s.season.adr_achieved;
      if (diff < -0.12) tips.push({ severity: 'watch', title: `Forward rate is ${Math.abs(Math.round(diff * 100))}% below your achieved $${s.season.adr_achieved}/night`, detail: `Bookings in the next 30 days average $${w30.adr}/night vs $${s.season.adr_achieved} achieved this season. If demand is holding, you may be underpricing the remaining nights.` });
      else if (diff > 0.15) tips.push({ severity: 'good', title: `Forward ADR $${w30.adr} runs ${Math.round(diff * 100)}% above season average`, detail: `Upcoming stays are booking at richer rates than the season average of $${s.season.adr_achieved} — hold the line on pricing.` });
    }
    if (s.pricelabs_avg_next_30 != null && w30.adr != null) {
      const gap = (w30.adr - s.pricelabs_avg_next_30) / s.pricelabs_avg_next_30;
      if (gap < -0.15) tips.push({ severity: 'watch', title: `Booked rate ~${Math.abs(Math.round(gap * 100))}% under PriceLabs market rec`, detail: `Next-30-day booked ADR is $${w30.adr} vs a $${s.pricelabs_avg_next_30} recommended average — review minimum prices so early bookers aren't scooping undervalued nights.` });
    }

    const ja = s.july_august;
    if (ja.last_year.occupied_nights > 0) {
      const paceDelta = ja.occupancy - ja.last_year.occupancy;
      if (paceDelta < -0.1) tips.push({ severity: 'act', title: `July/Aug pacing behind last year (${Math.round(ja.occupancy * 100)}% vs ${Math.round(ja.last_year.occupancy * 100)}%)`, detail: `Last year July+Aug finished with ${ja.last_year.occupied_nights}/62 nights and $${Math.round(ja.last_year.revenue)}. You're at ${ja.occupied_nights}/62 and $${Math.round(ja.revenue)} — close the gap with mid-week deals or a minimum-stay reduction.` });
      else if (paceDelta > 0.05) tips.push({ severity: 'good', title: `July/Aug ahead of last year (${Math.round(ja.occupancy * 100)}% vs ${Math.round(ja.last_year.occupancy * 100)}%)`, detail: `Revenue $${Math.round(ja.revenue)} vs $${Math.round(ja.last_year.revenue)} at last year's close — momentum is real; consider raising weekend rates.` });
    }

    const myOrphans = orphans.filter(o => o.property_id === s.id);
    if (myOrphans.length >= 2) {
      tips.push({ severity: 'watch', title: `${myOrphans.length} orphan gaps (1–2 nights) on the calendar`, detail: `Short unbookable gaps between stays: ${myOrphans.slice(0, 3).map(o => `${o.gap_start} (${o.nights}n)`).join(', ')}${myOrphans.length > 3 ? '…' : ''}. Offer late-checkout/early-check-in upsells, or open 1–2 night stays with a higher nightly rate to monetize them.` });
    }

    const myReviews = reviews.filter(r => r.property_id === s.id);
    if (myReviews.length) {
      const avg = myReviews.reduce((a, r) => a + (Number(r.rating) || 0), 0) / myReviews.length;
      if (avg < 4.5) tips.push({ severity: 'watch', title: `Average review ${avg.toFixed(1)}★`, detail: `Below the 4.7★ Airbnb "Guest favourite" bar — read recent review text for repeat complaints; small fixes (wifi, mattress, coffee) move ratings fastest.` });
    }

    if (!s.listing.headline && !s.listing.description) {
      tips.push({ severity: 'watch', title: 'No listing headline/description saved', detail: 'Add your live listing copy via the "Listing" button on the Properties tab — future insights can then critique positioning, amenities, and target guest fit.' });
    }

    if (w60.potential_revenue > 0) {
      tips.push({ severity: 'watch', title: `$${Math.round(w60.potential_revenue)} still on the table in the next 60 days`, detail: `${w60.fillable_nights} vacant nights sit in fillable 3+ night blocks. That's the upside if you fill them at ${w60.adr ? 'current booked rates' : 'season-average rates'}.` });
    }

    out.push({ id: s.id, nickname: s.nickname, stats: s, insights: tips });
  }

  // Building-level P&L insights (annual ROI / cash-on-cash view).
  const roi = computeRoi(Number(today.slice(0, 4)));
  const buildings = roi.buildings.map(b => {
    const c = b.computed, tips = [];
    const fmt$ = n => '$' + Math.round(n).toLocaleString('en-CA');
    if (!b.property_ids.length) return null;

    if (c.total_income > 0 && c.cash_flow < 0 && c.trending && c.trending.cash_flow >= 0) {
      tips.push({ severity: 'watch', title: `Behind on cash (${fmt$(c.cash_flow)} booked) but trending to ${fmt$(c.trending.cash_flow)}`, detail: `Booked income hasn't caught the full-year costs yet, but if the remaining 3+ night season gaps fill and the off-season forecast lands, this building finishes at ${fmt$(c.trending.cash_flow)}. The gap between those two numbers is what's still up for grabs — every unfilled block eats into it.` });
    } else if (c.total_income > 0 && c.cash_flow < 0) {
      tips.push({ severity: 'act', title: `Cash-flow negative: ${fmt$(c.cash_flow)} this year so far`, detail: `Income ${fmt$(c.total_income)} minus operating costs ${fmt$(c.total_opex)} and mortgage interest ${fmt$(c.mortgage_interest)} leaves a shortfall — and even the trending view (season gaps filled + off-season forecast) stays negative at ${fmt$(c.trending ? c.trending.cash_flow : 0)}. Something structural needs to change: rates, off-season income, or a cost line.` });
    } else if (c.cash_flow > 0 && c.cash_on_cash != null) {
      const pct = Math.round(c.cash_on_cash * 1000) / 10;
      const tcoc = c.trending ? c.trending.cash_on_cash : null;
      const judged = tcoc != null ? Math.max(c.cash_on_cash, tcoc) : c.cash_on_cash;
      const sev = judged >= 0.08 ? 'good' : 'watch';
      const trendTxt = (tcoc != null && Math.abs(tcoc - c.cash_on_cash) >= 0.01)
        ? ` Trending ${Math.round(tcoc * 1000) / 10}% (${fmt$(c.trending.cash_flow)}) once season gaps fill and the off-season forecast lands.` : '';
      tips.push({ severity: sev, title: `${pct}% cash-on-cash booked so far (${c.cash_basis})`, detail: `${fmt$(c.cash_flow)} cash flow booked to date on ${fmt$(Number(b.inputs.cash_invested) > 0 ? Number(b.inputs.cash_invested) : c.equity)} ${c.cash_basis}.${trendTxt} ${judged >= 0.08 ? 'Above the ~8% bar most investors want from active STRs.' : 'Below the ~8% most investors target for the work an STR takes — push occupancy or trim the biggest cost line.'}` });
    }
    // Interest share is judged against the trending year, not the season-to-date number —
    // otherwise every building looks over-leveraged in July.
    const incBase = Math.max(c.total_income, (c.trending && c.trending.income) || 0);
    if (incBase > 0 && c.mortgage_interest > 0 && c.mortgage_interest / incBase > 0.4) {
      tips.push({ severity: 'watch', title: `Mortgage interest eats ${Math.round(c.mortgage_interest / incBase * 100)}% of trending income`, detail: `${fmt$(c.mortgage_interest)} of interest against ${fmt$(incBase)} trending income (${c.interest_source}). Refinancing or paying down principal moves this number more than any nightly-rate tweak.` });
    }
    if (!Number(b.inputs.property_value) || (!Number(b.inputs.debt_balance) && !Number(b.inputs.mortgage_interest_override))) {
      tips.push({ severity: 'watch', title: 'P&L incomplete — missing value or mortgage inputs', detail: `Fill in property value, mortgage balance and rate on the ROI tab so cap rate and cash-on-cash can be computed. ${(b.inputs.notes || '').includes('ESTIMATE') ? 'Expense lines are currently estimates.' : ''}` });
    }
    if (!Number(b.inputs.str_license)) {
      tips.push({ severity: 'watch', title: 'No STR license cost entered', detail: 'Licensing is coming for Central Elgin STRs — add the expected annual license fee so the return numbers stay honest.' });
    }
    return { key: b.key, name: b.name, sub: b.sub, computed: c, insights: tips };
  }).filter(Boolean);

  return { generated_at: nowIso(), today, properties: out, buildings, roi_year: roi.year };
}
app.get('/api/insights', (req, res) => ok(res, computeInsights()));

// ---------- ANNUAL PREDICTION (per-property monthly revenue forecast) ----------
app.get('/api/annual-prediction', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const todayIso = new Date().toISOString().slice(0, 10);
  const bookings = tableAll('bookings').map(joinBooking).filter(b => b.status !== 'cancelled');
  const actuals = {}; // property_id -> { month(1-12): revenue }
  tableAll('properties').forEach(p => { actuals[p.id] = {}; });
  bookings.forEach(b => {
    if (!b.check_in || b.check_in.slice(0, 4) !== String(year)) return;
    const m = Number(b.check_in.slice(5, 7));
    if (!actuals[b.property_id]) return;
    actuals[b.property_id][m] = +(((actuals[b.property_id][m] || 0) + (b.amount || 0) + (b.upsell_total || 0))).toFixed(2);
  });
  // Season ADR per property (fallback rate for the potential estimate)
  const seasonStart = `${year}-${getSetting('season_start_md', '06-01')}`;
  const seasonEnd = `${year}-${getSetting('season_end_md', '10-01')}`;
  const adrByProp = {};
  tableAll('properties').forEach(p => {
    const list = bookings.filter(b => b.property_id === p.id && b.check_in >= seasonStart && b.check_in <= seasonEnd);
    const earnings = list.reduce((a, b) => a + (b.amount || 0) + (b.upsell_total || 0), 0);
    let nights = 0; list.forEach(b => { nights += nightsInWindow(b.check_in, b.check_out, seasonStart, seasonEnd); });
    adrByProp[p.id] = nights > 0 ? +(earnings / nights).toFixed(2) : 0;
  });
  // Remaining fillable potential (3+ night runs) for Jun/Jul/Aug, per property.
  const allPropIds = tableAll('properties').map(p => p.id);
  const potential = {};
  [6, 7, 8].forEach(mo => {
    const mStart = `${year}-${String(mo).padStart(2, '0')}-01`;
    const mEnd = `${year}-${String(mo + 1).padStart(2, '0')}-01`;
    if (mEnd <= todayIso) return; // month already over
    const start = todayIso > mStart ? todayIso : mStart;
    computePotentialRevenue(allPropIds, start, mEnd, adrByProp, 3).by_property.forEach(p => { (potential[p.id] = potential[p.id] || {})[mo] = p.potential_revenue; });
  });
  ok(res, {
    year,
    properties: tableAll('properties').sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '')).map(p => ({ id: p.id, nickname: p.nickname })),
    actuals, potential,
    manual: getSetting('annual_prediction_' + year, {}),
  });
});
app.put('/api/annual-prediction', (req, res) => {
  const year = Number((req.body || {}).year) || new Date().getFullYear();
  const values = (req.body || {}).values || {};
  const key = 'annual_prediction_' + year;
  const existing = store.settings.find(s => s.key === key);
  if (existing) tableUpdate('settings', existing.id, { value: values }); else tableInsert('settings', { key, value: values });
  ok(res, { ok: true });
});

// ---------- GUEST MESSAGING ----------
app.get('/api/message-templates', (req, res) => ok(res, tableAll('message_templates').sort((a, b) => (a.offset_days || 0) - (b.offset_days || 0))));
app.put('/api/message-templates/:id', (req, res) => {
  const b = req.body || {}; const patch = {};
  ['subject', 'body', 'channel'].forEach(k => { if (b[k] != null) patch[k] = b[k]; });
  if (b.enabled != null) patch.enabled = b.enabled ? 1 : 0;
  if (b.offset_days != null) patch.offset_days = Number(b.offset_days) || 0;
  if (b.send_hour != null) patch.send_hour = Number(b.send_hour) || 9;
  const row = tableUpdate('message_templates', req.params.id, patch);
  if (!row) return err(res, 404, 'not found'); ok(res, row);
});
function renderTemplate(body, b) {
  const p = tableFind('properties', b.property_id) || {};
  return (body || '')
    .replace(/{guest}/g, b.guest_name || b.contact_name || 'there')
    .replace(/{property}/g, b.property_name || p.nickname || 'our place')
    .replace(/{checkin}/g, b.check_in || '')
    .replace(/{checkout}/g, b.check_out || '')
    .replace(/{door_code}/g, b.door_code || '(see lockbox)')
    .replace(/{address}/g, p.address || '')
    .replace(/{checkin_instructions}/g, p.check_in_instructions || '');
}
function anchorDate(stage, b) {
  if (stage === 'confirmation') return (b.created_at || '').slice(0, 10) || b.check_in;
  if (['pre_arrival', 'checkin_day', 'mid_stay'].includes(stage)) return b.check_in;
  return b.check_out || b.check_in;
}
function computeScheduledMessages() {
  const today = new Date().toISOString().slice(0, 10);
  const templates = tableAll('message_templates').filter(t => t.enabled);
  const out = [];
  for (const b of tableAll('bookings').map(joinBooking)) {
    if (b.status === 'cancelled') continue;
    for (const t of templates) {
      const anchor = anchorDate(t.stage, b); if (!anchor) continue;
      const sendDate = addDays(anchor, Number(t.offset_days) || 0);
      const sent = store.sms_messages.some(m => m.booking_id === b.id && m.stage === t.stage && m.direction === 'outbound');
      out.push({
        booking_id: b.id, stage: t.stage, send_date: sendDate, due: sendDate <= today, sent,
        guest_name: b.guest_name || b.contact_name, property_name: b.property_name, guest_phone: b.guest_phone,
        check_in: b.check_in, check_out: b.check_out, preview: renderTemplate(t.body, b),
      });
    }
  }
  return out.sort((a, b) => (a.send_date || '').localeCompare(b.send_date || ''));
}
app.get('/api/messages/scheduled', (req, res) => ok(res, computeScheduledMessages()));
async function sendBookingStage(bookingId, stage) {
  const raw = tableFind('bookings', bookingId); if (!raw) throw new Error('booking not found');
  const b = joinBooking(raw);
  const t = tableAll('message_templates').find(x => x.stage === stage); if (!t) throw new Error('template not found');
  const body = renderTemplate(t.body, b);
  if (!b.guest_phone) throw new Error('guest has no phone number');
  if (!twilioClient) throw new Error('Twilio not configured');
  const msg = await twilioClient.messages.create({ body, from: TWILIO_FROM, to: b.guest_phone });
  tableInsert('sms_messages', { direction: 'outbound', from_number: TWILIO_FROM, to_number: b.guest_phone, body, twilio_sid: msg.sid, guest_id: b.guest_id || null, property_id: b.property_id || null, booking_id: b.id, stage, sent_at: nowIso() });
  return { sid: msg.sid, body };
}
app.post('/api/messages/send', async (req, res) => {
  const { booking_id, stage } = req.body || {};
  if (!booking_id || !stage) return err(res, 400, 'booking_id and stage required');
  try { ok(res, await sendBookingStage(Number(booking_id), stage)); }
  catch (e) { err(res, 400, e.message); }
});
let schedulerRunning = false;
async function runMessageScheduler() {
  if (schedulerRunning) return; schedulerRunning = true;
  try {
    if (!getSetting('messaging_autosend_enabled', false) || !twilioClient) return;
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = addDays(today, -1); // never fire messages whose date is more than ~1 day stale
    const due = computeScheduledMessages().filter(m => m.due && !m.sent && m.guest_phone && m.send_date >= cutoff);
    for (const m of due) { try { await sendBookingStage(m.booking_id, m.stage); } catch (e) { console.error('[scheduler] ' + m.booking_id + '/' + m.stage + ': ' + e.message); } }
  } finally { schedulerRunning = false; }
}

// ---------- PRICELABS ----------
const PRICELABS_KEY = process.env.PRICELABS_API_KEY || '';
async function pricelabsGet(path) {
  const r = await fetch('https://api.pricelabs.co/v1' + path, { headers: { 'X-API-Key': PRICELABS_KEY } });
  if (!r.ok) throw new Error('PriceLabs ' + r.status);
  return r.json();
}
async function pricelabsPrices(listingId, pms, datefrom, dateto) {
  const r = await fetch('https://api.pricelabs.co/v1/listing_prices', {
    method: 'POST', headers: { 'X-API-Key': PRICELABS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ listings: [{ id: listingId, pms, datefrom, dateto }] }),
  });
  if (!r.ok) throw new Error('PriceLabs prices ' + r.status);
  return r.json();
}
app.get('/api/pricelabs/listings', async (req, res) => {
  if (!PRICELABS_KEY) return err(res, 503, 'PriceLabs API key not set');
  try { const d = await pricelabsGet('/listings'); ok(res, d.listings || []); }
  catch (e) { err(res, 502, e.message); }
});
app.post('/api/pricelabs/refresh', async (req, res) => {
  if (!PRICELABS_KEY) return err(res, 503, 'PriceLabs API key not set');
  const today = new Date().toISOString().slice(0, 10), to = addDays(today, 60);
  const results = [];
  for (const p of tableAll('properties')) {
    if (!p.pricelabs_listing_id || !p.pricelabs_pms) continue;
    try {
      const data = await pricelabsPrices(p.pricelabs_listing_id, p.pricelabs_pms, today, to);
      const arr = Array.isArray(data) ? data : (data.listings || []);
      const days = (arr[0] && arr[0].data) || [];
      const currency = (arr[0] && arr[0].currency) || 'CAD';
      store.price_cache = store.price_cache.filter(c => c.property_id !== p.id);
      enqueueWrite(async () => { const { error } = await supabase.from(tbl('price_cache')).delete().eq('property_id', p.id); if (error) throw error; }, 'clear price_cache ' + p.id);
      for (const d of days) tableInsert('price_cache', { property_id: p.id, date: d.date, recommended_price: d.price, user_price: d.user_price, min_stay: d.min_stay, demand: d.demand_desc, currency, fetched_at: nowIso() });
      results.push({ property_id: p.id, nickname: p.nickname, days: days.length });
    } catch (e) { results.push({ property_id: p.id, nickname: p.nickname, error: e.message }); }
  }
  ok(res, results);
});
app.get('/api/pricing', async (req, res) => {
  let listings = [], listErr = null;
  if (PRICELABS_KEY) { try { const d = await pricelabsGet('/listings'); listings = d.listings || []; } catch (e) { listErr = e.message; } }
  const byId = {}; listings.forEach(l => { byId[l.id] = l; });
  const props = tableAll('properties').map(p => {
    const l = p.pricelabs_listing_id ? byId[p.pricelabs_listing_id] : null;
    const prices = store.price_cache.filter(c => c.property_id === p.id).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return {
      property_id: p.id, nickname: p.nickname, pricelabs_listing_id: p.pricelabs_listing_id || null, pricelabs_pms: p.pricelabs_pms || null,
      summary: l ? { recommended_base_price: l.recommended_base_price, min: l.min, base: l.base, max: l.max, occupancy_next_7: l.occupancy_next_7, market_occupancy_next_7: l.market_occupancy_next_7, occupancy_next_30: l.occupancy_next_30, market_occupancy_next_30: l.market_occupancy_next_30, occupancy_next_60: l.occupancy_next_60, market_occupancy_next_60: l.market_occupancy_next_60 } : null,
      prices,
    };
  });
  ok(res, { listings_error: listErr, listings: listings.map(l => ({ id: l.id, pms: l.pms, name: l.name })), properties: props });
});

// Private booking estimator — sum PriceLabs recommended nightly rates for a stay.
app.get('/api/quote', async (req, res) => {
  const property = tableFind('properties', req.query.property_id);
  if (!property) return err(res, 404, 'property not found');
  const from = req.query.from, to = req.query.to;
  if (!from || !to || to <= from) return err(res, 400, 'from and to (checkout, after from) are required');
  if (!PRICELABS_KEY) return err(res, 503, 'PriceLabs API key not set');
  if (!property.pricelabs_listing_id || !property.pricelabs_pms) return err(res, 400, 'Map this property to a PriceLabs listing in the Pricing tab first');
  try {
    const data = await pricelabsPrices(property.pricelabs_listing_id, property.pricelabs_pms, from, to);
    const arr = Array.isArray(data) ? data : (data.listings || []);
    const days = (arr[0] && arr[0].data) || [];
    const currency = (arr[0] && arr[0].currency) || 'CAD';
    const per_night = days.filter(d => d.date >= from && d.date < to).map(d => ({ date: d.date, price: Number(d.price) || 0, demand: d.demand_desc, min_stay: d.min_stay }));
    const nightly_total = per_night.reduce((a, d) => a + d.price, 0);
    let cleaning_fee = 0;
    try { const ld = await pricelabsGet('/listings'); const l = (ld.listings || []).find(x => x.id === property.pricelabs_listing_id); if (l && l.cleaning_fees) cleaning_fee = Number(l.cleaning_fees) || 0; } catch (e) {}
    ok(res, {
      property_name: property.nickname, from, to, nights: per_night.length, currency, per_night,
      nightly_total: +nightly_total.toFixed(2), avg_nightly: per_night.length ? +(nightly_total / per_night.length).toFixed(2) : 0,
      cleaning_fee: +cleaning_fee.toFixed(2), total: +(nightly_total + cleaning_fee).toFixed(2),
    });
  } catch (e) { err(res, 502, 'PriceLabs: ' + e.message); }
});

// ---------- CRON (Vercel-scheduled message sender) ----------
// On serverless there's no long-lived timer, so Vercel Cron pings this hourly.
app.get('/api/cron/scheduler', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const provided = req.query.secret || (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (secret && provided !== secret) return err(res, 403, 'forbidden');
  await runMessageScheduler(); // runs inside the request snapshot context; writes flush on response
  ok(res, { ran: true });
});

// ---------- 404 fallback for /api ----------
app.use('/api', (req, res) => err(res, 404, 'not found'));

// Export the Express app so Vercel's @vercel/node can use it as a serverless function.
module.exports = app;

// Run a standalone server only when invoked directly (local dev / always-on host).
if (require.main === module) {
  (async () => {
    try {
      await withContext(seedDefaults); // idempotent: seed defaults if missing
      console.log('[startup] Supabase connected (' + SUPABASE_URL + ')');
    } catch (e) {
      console.error('[startup] Supabase check failed:', e.message || e);
      process.exit(1);
    }
    app.listen(PORT, () => console.log(`[startup] Short-Term Rental Tracker listening on http://localhost:${PORT}`));
    // Local-only scheduler (serverless uses /api/cron/scheduler instead). Sends only when enabled.
    setInterval(() => { withContext(runMessageScheduler).catch(e => console.error('[scheduler]', e.message)); }, 60 * 60 * 1000);
  })();
}
