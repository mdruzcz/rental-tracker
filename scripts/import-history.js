// One-off: import historical (2024/2025) bookings parsed from "Airbnb Tracker.xlsx".
// Usage:
//   node scripts/import-history.js <rows.json>            (dry run — prints what it would do)
//   node scripts/import-history.js <rows.json> --commit   (actually inserts)
//
// Rows are de-duplicated against bookings already in Supabase: any parsed row whose
// date range overlaps an existing non-cancelled booking at the same property is skipped
// (the app copy is treated as the richer source of truth). Safe to re-run.

const fs = require('fs');
const path = require('path');

(() => {
  const envPath = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const rowsFile = process.argv[2];
const commit = process.argv.includes('--commit');
if (!rowsFile) { console.error('usage: node scripts/import-history.js <rows.json> [--commit]'); process.exit(1); }
const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8'));

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < (bEnd || bStart) && bStart < (aEnd || aStart);
}

(async () => {
  const { data: props, error: e1 } = await supabase.from('rental_properties').select('id,nickname');
  if (e1) throw e1;
  const { data: types, error: e2 } = await supabase.from('rental_booking_types').select('id,name');
  if (e2) throw e2;
  const { data: existing, error: e3 } = await supabase.from('rental_bookings').select('id,property_id,check_in,check_out,contact_name,status,notes');
  if (e3) throw e3;

  const propByName = {}; props.forEach(p => { propByName[p.nickname.toLowerCase()] = p.id; });
  const typeByName = {}; types.forEach(t => { typeByName[t.name.toLowerCase()] = t.id; });
  let nextId = existing.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;

  const toInsert = [];
  const skipped = [];
  for (const r of rows) {
    const pid = propByName[r.property_name.toLowerCase()];
    if (!pid) { skipped.push([r, 'no matching property']); continue; }
    const tid = typeByName[r.booking_type_name.toLowerCase()] || null;
    const dupe = existing.find(b => b.property_id === pid && b.status !== 'cancelled' &&
      overlaps(r.check_in, r.check_out, b.check_in, b.check_out));
    if (dupe) { skipped.push([r, `already in app: #${dupe.id} ${dupe.contact_name || ''} ${dupe.check_in}→${dupe.check_out}`]); continue; }
    toInsert.push({
      id: nextId++,
      created_at: new Date().toISOString(),
      property_id: pid,
      booking_type_id: tid,
      guest_id: null,
      check_in: r.check_in,
      check_out: r.check_out,
      amount: r.amount,
      contact_name: r.contact_name,
      notes: r.notes,
      invite_sent: 0,
      status: 'confirmed',
    });
  }

  console.log(`${toInsert.length} to insert, ${skipped.length} skipped`);
  for (const [r, why] of skipped) console.log(`  SKIP ${r.year} ${r.property_name} ${r.contact_name} ${r.check_in}→${r.check_out}: ${why}`);
  const byYear = {};
  toInsert.forEach(b => { const y = b.check_in.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; });
  console.log('insert by year:', byYear);
  const revByYear = {};
  toInsert.forEach(b => { const y = b.check_in.slice(0, 4); revByYear[y] = +((revByYear[y] || 0) + b.amount).toFixed(2); });
  console.log('revenue by year:', revByYear);

  if (!commit) { console.log('\nDRY RUN — re-run with --commit to insert.'); return; }
  for (let i = 0; i < toInsert.length; i += 50) {
    const chunk = toInsert.slice(i, i + 50);
    const { error } = await supabase.from('rental_bookings').insert(chunk);
    if (error) throw error;
    console.log(`inserted ${i + chunk.length}/${toInsert.length}`);
  }
  console.log('done.');
})().catch(e => { console.error('FAILED:', e.message || e); process.exit(1); });
