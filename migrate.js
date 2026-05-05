/**
 * Migration Script: rental.db.json -> Supabase
 *
 * Run: node migrate.js
 *
 * This reads the local rental.db.json file and inserts all data
 * into the corresponding Supabase tables.
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL || 'https://symgxmokposzjcgikgnz.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bWd4bW9rcG9zempjZ2lrZ256Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5MDQ3MDQsImV4cCI6MjA5MjQ4MDcwNH0.IdMsqmuvtxbX084-fw28Li4kO_E1WUCAwZtg2mMsLmw';
const supabase = createClient(supabaseUrl, supabaseKey);

async function migrate() {
  const dbPath = path.join(__dirname, 'rental.db.json');

  if (!fs.existsSync(dbPath)) {
    console.error('ERROR: rental.db.json not found in project root.');
    console.error('Place your rental.db.json file in the same directory as migrate.js');
    process.exit(1);
  }

  const rawData = fs.readFileSync(dbPath, 'utf-8');
  const db = JSON.parse(rawData);

  console.log('Starting migration to Supabase...\n');

  // Migrate properties
  if (db.properties && db.properties.length > 0) {
    console.log(`Migrating ${db.properties.length} properties...`);
    for (const prop of db.properties) {
      const row = {
        nickname: prop.nickname || prop.name || null,
        address: prop.address || null,
        airbnb_ical_url: prop.airbnb_ical_url || prop.airbnbIcalUrl || null,
        vrbo_ical_url: prop.vrbo_ical_url || prop.vrboIcalUrl || null,
        notes: prop.notes || null,
        welcome_message: prop.welcome_message || prop.welcomeMessage || null,
        public_bookable: prop.public_bookable || prop.publicBookable || false,
        license_status: prop.license_status || prop.licenseStatus || null,
        license_renewal_date: prop.license_renewal_date || prop.licenseRenewalDate || null,
        check_in_instructions: prop.check_in_instructions || prop.checkInInstructions || null,
        nearby_attractions: prop.nearby_attractions || prop.nearbyAttractions || null,
        contact_info: prop.contact_info || prop.contactInfo || null
      };
      const { error } = await supabase.from('rental_properties').insert([row]);
      if (error) console.error('  Error inserting property:', prop.nickname, error.message);
    }
    console.log('  Done.\n');
  }

  // Migrate booking types
  if (db.bookingTypes && db.bookingTypes.length > 0) {
    console.log(`Migrating ${db.bookingTypes.length} booking types...`);
    for (const bt of db.bookingTypes) {
      const { error } = await supabase.from('rental_booking_types').insert([{ name: bt.name || bt }]);
      if (error) console.error('  Error:', error.message);
    }
    console.log('  Done.\n');
  }

  // Migrate guests
  if (db.guests && db.guests.length > 0) {
    console.log(`Migrating ${db.guests.length} guests...`);
    for (const guest of db.guests) {
      const row = {
        name: guest.name || null,
        email: guest.email || null,
        phone: guest.phone || null,
        address: guest.address || null,
        notes: guest.notes || null
      };
      const { error } = await supabase.from('rental_guests').insert([row]);
      if (error) console.error('  Error inserting guest:', guest.name, error.message);
    }
    console.log('  Done.\n');
  }

  // Migrate cleaners
  if (db.cleaners && db.cleaners.length > 0) {
    console.log(`Migrating ${db.cleaners.length} cleaners...`);
    for (const cleaner of db.cleaners) {
      const row = {
        name: cleaner.name || null,
        phone: cleaner.phone || null,
        email: cleaner.email || null,
        rate: cleaner.rate || null,
        notes: cleaner.notes || null
      };
      const { error } = await supabase.from('rental_cleaners').insert([row]);
      if (error) console.error('  Error inserting cleaner:', cleaner.name, error.message);
    }
    console.log('  Done.\n');
  }

  // Migrate bookings
  if (db.bookings && db.bookings.length > 0) {
    console.log(`Migrating ${db.bookings.length} bookings...`);

    // We need to map old property IDs to new ones
    const { data: newProperties } = await supabase.from('rental_properties').select('id, nickname');
    const { data: newGuests } = await supabase.from('rental_guests').select('id, name');

    for (const booking of db.bookings) {
      // Try to match property by nickname
      let propertyId = null;
      if (booking.property_id || booking.propertyId) {
        const oldProp = db.properties?.find(p => (p.id || p._id) === (booking.property_id || booking.propertyId));
        if (oldProp && newProperties) {
          const match = newProperties.find(np => np.nickname === (oldProp.nickname || oldProp.name));
          if (match) propertyId = match.id;
        }
      }

      // Try to match guest
      let guestId = null;
      if (booking.guest_id || booking.guestId) {
        const oldGuest = db.guests?.find(g => (g.id || g._id) === (booking.guest_id || booking.guestId));
        if (oldGuest && newGuests) {
          const match = newGuests.find(ng => ng.name === oldGuest.name);
          if (match) guestId = match.id;
        }
      }

      const row = {
        property_id: propertyId,
        guest_id: guestId,
        check_in: booking.check_in || booking.checkIn || null,
        check_out: booking.check_out || booking.checkOut || null,
        amount: booking.amount || null,
        contact_name: booking.contact_name || booking.contactName || booking.guestName || null,
        notes: booking.notes || null,
        invite_sent: booking.invite_sent || booking.inviteSent || false
      };
      const { error } = await supabase.from('rental_bookings').insert([row]);
      if (error) console.error('  Error inserting booking:', error.message);
    }
    console.log('  Done.\n');
  }

  // Migrate maintenance items
  if (db.maintenance && db.maintenance.length > 0) {
    console.log(`Migrating ${db.maintenance.length} maintenance items...`);
    const { data: newProperties } = await supabase.from('rental_properties').select('id, nickname');

    for (const item of db.maintenance) {
      let propertyId = null;
      if (item.property_id || item.propertyId) {
        const oldProp = db.properties?.find(p => (p.id || p._id) === (item.property_id || item.propertyId));
        if (oldProp && newProperties) {
          const match = newProperties.find(np => np.nickname === (oldProp.nickname || oldProp.name));
          if (match) propertyId = match.id;
        }
      }

      const row = {
        property_id: propertyId,
        item_name: item.item_name || item.itemName || item.name || null,
        category: item.category || null,
        in_stock: item.in_stock !== undefined ? item.in_stock : (item.inStock !== undefined ? item.inStock : true),
        notes: item.notes || null
      };
      const { error } = await supabase.from('rental_maintenance_items').insert([row]);
      if (error) console.error('  Error:', error.message);
    }
    console.log('  Done.\n');
  }

  // Migrate todos
  if (db.todos && db.todos.length > 0) {
    console.log(`Migrating ${db.todos.length} todos...`);
    const { data: newProperties } = await supabase.from('rental_properties').select('id, nickname');

    for (const todo of db.todos) {
      let propertyId = null;
      if (todo.property_id || todo.propertyId) {
        const oldProp = db.properties?.find(p => (p.id || p._id) === (todo.property_id || todo.propertyId));
        if (oldProp && newProperties) {
          const match = newProperties.find(np => np.nickname === (oldProp.nickname || oldProp.name));
          if (match) propertyId = match.id;
        }
      }

      const row = {
        title: todo.title || null,
        description: todo.description || null,
        priority: todo.priority || 'medium',
        due_date: todo.due_date || todo.dueDate || null,
        property_id: propertyId,
        status: todo.status || (todo.completed ? 'completed' : 'pending'),
        completed_at: todo.completed_at || todo.completedAt || null
      };
      const { error } = await supabase.from('rental_todos').insert([row]);
      if (error) console.error('  Error:', error.message);
    }
    console.log('  Done.\n');
  }

  // Migrate licensing items
  if (db.licensing && db.licensing.length > 0) {
    console.log(`Migrating ${db.licensing.length} licensing items...`);
    const { data: newProperties } = await supabase.from('rental_properties').select('id, nickname');

    for (const item of db.licensing) {
      let propertyId = null;
      if (item.property_id || item.propertyId) {
        const oldProp = db.properties?.find(p => (p.id || p._id) === (item.property_id || item.propertyId));
        if (oldProp && newProperties) {
          const match = newProperties.find(np => np.nickname === (oldProp.nickname || oldProp.name));
          if (match) propertyId = match.id;
        }
      }

      const row = {
        property_id: propertyId,
        step_name: item.step_name || item.stepName || item.name || null,
        description: item.description || null,
        bylaw_ref: item.bylaw_ref || item.bylawRef || null,
        sort_order: item.sort_order || item.sortOrder || 0,
        status: item.status || 'not-started',
        notes: item.notes || null,
        completed_date: item.completed_date || item.completedDate || null
      };
      const { error } = await supabase.from('rental_licensing_items').insert([row]);
      if (error) console.error('  Error:', error.message);
    }
    console.log('  Done.\n');
  }

  console.log('========================================');
  console.log('Migration complete!');
  console.log('========================================');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
