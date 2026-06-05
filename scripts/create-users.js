// One-off: make sure every email in RENTAL_ALLOWED_EMAILS has a Supabase Auth account.
// Usage:  node scripts/create-users.js
// Existing accounts are left alone. New ones are created (email pre-confirmed) with a
// password from RENTAL_SEED_PASSWORD (or a random one that gets printed). Change it later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY || KEY.startsWith('PASTE_')) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }

const emails = (process.env.RENTAL_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!emails.length) { console.error('RENTAL_ALLOWED_EMAILS is empty in .env — add the login emails first.'); process.exit(1); }

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

(async () => {
  // Page through existing users to avoid duplicates.
  const existing = new Set();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { console.error('listUsers failed:', error.message); process.exit(1); }
    (data.users || []).forEach(u => u.email && existing.add(u.email.toLowerCase()));
    if (!data.users || data.users.length < 200) break;
  }

  for (const email of emails) {
    if (existing.has(email.toLowerCase())) { console.log(`= ${email} already exists — left as-is`); continue; }
    const password = process.env.RENTAL_SEED_PASSWORD || ('Rental-' + crypto.randomBytes(4).toString('hex'));
    const { error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) { console.error(`x ${email}: ${error.message}`); continue; }
    console.log(`+ ${email} created  —  password: ${password}`);
  }
  console.log('\nDone. Use these credentials on the login screen (change the password anytime).');
})();
