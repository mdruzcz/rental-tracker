// One-off: copy everything from rental.db.json into the Supabase rental_* tables.
// Usage:  node scripts/migrate-to-supabase.js
// Re-runnable: it deletes existing rows in each table first, then re-inserts preserving ids.
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (service role bypasses RLS).
//
// Sequence values (so new inserts don't collide with imported ids) are reset by the
// caller afterward via a single SQL statement — this script prints the max id per table.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// --- tiny .env loader (same approach as server.js) ---
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY || KEY.startsWith('PASTE_')) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1);
}
const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

const DB = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rental.db.json'), 'utf8'));

// jsonKey -> { table, cols } . Only whitelisted columns are sent (extra keys stripped).
const MAP = [
  ['properties', 'rental_properties', ['id','created_at','nickname','address','airbnb_ical_url','vrbo_ical_url','notes','welcome_message','default_cleaner_id','public_bookable','license_status','license_renewal_date','check_in_instructions','nearby_attractions','contact_info']],
  ['booking_types', 'rental_booking_types', ['id','created_at','name']],
  ['guests', 'rental_guests', ['id','created_at','name','email','phone','address','notes']],
  ['cleaners', 'rental_cleaners', ['id','created_at','name','phone','email','rate','notes']],
  ['bookings', 'rental_bookings', ['id','created_at','property_id','booking_type_id','guest_id','check_in','check_out','amount','contact_name','notes','invite_sent','source_uid','guest_notified_at']],
  ['maintenance_items', 'rental_maintenance_items', ['id','created_at','property_id','item_name','category','in_stock','notes']],
  ['synced_events', 'rental_synced_events', ['id','created_at','property_id','source','uid','summary','start_date','end_date','last_synced']],
  ['cleaner_tasks', 'rental_cleaner_tasks', ['id','created_at','cleaner_id','property_id','booking_id','due_date','status','notes','notified_at','notify_sid']],
  ['booking_requests', 'rental_booking_requests', ['id','created_at','property_id','guest_name','guest_email','guest_phone','check_in','check_out','guests_count','message','status','approved_booking_id']],
  ['todos', 'rental_todos', ['id','created_at','title','description','priority','due_date','property_id','status','completed_at']],
  ['licensing_items', 'rental_licensing_items', ['id','created_at','property_id','step_name','description','bylaw_ref','sort_order','status','notes','completed_date','attachments','uploads_allowed']],
  ['sms_messages', 'rental_sms_messages', ['id','created_at','direction','from_number','to_number','body','twilio_sid','guest_id','cleaner_id','property_id','received_at','sent_at','read']],
  ['manual_blocks', 'rental_manual_blocks', ['id','created_at','property_id','start_date','end_date','reason']],
];

function pick(row, cols) {
  const out = {};
  for (const c of cols) if (row[c] !== undefined) out[c] = row[c];
  return out;
}

(async () => {
  const maxIds = {};
  for (const [jsonKey, table, cols] of MAP) {
    const rows = (DB[jsonKey] || []).map(r => pick(r, cols));
    // clear existing (id >= 0 matches every row)
    const del = await supabase.from(table).delete().gte('id', 0);
    if (del.error) { console.error(`[${table}] delete failed:`, del.error.message); process.exit(1); }
    if (rows.length) {
      const ins = await supabase.from(table).insert(rows);
      if (ins.error) { console.error(`[${table}] insert failed:`, ins.error.message); process.exit(1); }
      maxIds[table] = rows.reduce((m, r) => Math.max(m, r.id || 0), 0);
    } else {
      maxIds[table] = 0;
    }
    console.log(`[${table}] ${rows.length} rows`);
  }
  console.log('\nMigration complete. Max ids:', JSON.stringify(maxIds));
})();
