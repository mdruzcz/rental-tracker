const express = require('express');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const ical = require('node-ical');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL || 'https://symgxmokposzjcgikgnz.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bWd4bW9rcG9zempjZ2lrZ256Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5MDQ3MDQsImV4cCI6MjA5MjQ4MDcwNH0.IdMsqmuvtxbX084-fw28Li4kO_E1WUCAwZtg2mMsLmw';
const supabase = createClient(supabaseUrl, supabaseKey);

// Twilio config
const twilioSid = process.env.TWILIO_ACCOUNT_SID || '';
const twilioAuth = process.env.TWILIO_AUTH_TOKEN || '';
const twilioPhone = process.env.TWILIO_PHONE_NUMBER || '';

let twilioClient;
try {
  const twilio = require('twilio');
  twilioClient = twilio(twilioSid, twilioAuth);
} catch (e) {
  console.log('Twilio not available:', e.message);
}

// Serve static files (for local dev)
app.use(express.static(__dirname + '/..'));

// ============ PROPERTIES ============

app.get('/api/properties', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_properties')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_properties')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/properties', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_properties')
      .insert([req.body])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/properties/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_properties')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/properties/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('rental_properties')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ BOOKINGS ============

app.get('/api/bookings', async (req, res) => {
  try {
    let query = supabase
      .from('rental_bookings')
      .select('*, rental_properties(nickname), rental_guests(name, email, phone), rental_booking_types(name)')
      .order('check_in', { ascending: false });

    if (req.query.property_id) {
      query = query.eq('property_id', req.query.property_id);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bookings/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_bookings')
      .select('*, rental_properties(nickname), rental_guests(name, email, phone)')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_bookings')
      .insert([req.body])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/bookings/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_bookings')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bookings/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('rental_bookings')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ BOOKING TYPES ============

app.get('/api/booking-types', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_booking_types')
      .select('*')
      .order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/booking-types', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_booking_types')
      .insert([req.body])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ GUESTS ============

app.get('/api/guests', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_guests')
      .select('*')
      .order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/guests/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_guests')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/guests', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_guests')
      .insert([req.body])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/guests/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_guests')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/guests/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('rental_guests')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CLEANERS ============

app.get('/api/cleaners', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_cleaners')
      .select('*')
      .order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cleaners/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_cleaners')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cleaners', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_cleaners')
      .insert([req.body])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cleaners/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_cleaners')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cleaners/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('rental_cleaners')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CLEANER TASKS ============

app.get('/api/cleaner-tasks', async (req, res) => {
  try {
    let query = supabase
      .from('rental_cleaner_tasks')
      .select('*, rental_cleaners(name), rental_properties(nickname), rental_bookings(check_in, check_out)')
      .order('due_date', { ascending: true });

    if (req.query.cleaner_id) query = query.eq('cleaner_id', req.query.cleaner_id);
    if (req.query.property_id) query = query.eq('property_id', req.query.property_id);
    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cleaner-tasks', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_cleaner_tasks')
      .insert([req.body])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cleaner-tasks/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_cleaner_tasks')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cleaner-tasks/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('rental_cleaner_tasks')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ MAINTENANCE ITEMS ============

app.get('/api/maintenance', async (req, res) => {
  try {
    let query = supabase
      .from('rental_maintenance_items')
      .select('*, rental_properties(nickname)')
      .order('item_name');

    if (req.query.property_id) query = query.eq('property_id', req.query.property_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/maintenance', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_maintenance_items')
      .insert([req.body])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/maintenance/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_maintenance_items')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/maintenance/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('rental_maintenance_items')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ LICENSING ITEMS ============

app.get('/api/licensing', async (req, res) => {
  try {
    let query = supabase
      .from('rental_licensing_items')
      .select('*, rental_properties(nickname)')
      .order('sort_order', { ascending: true });

    if (req.query.property_id) query = query.eq('property_id', req.query.property_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/licensing', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_licensing_items')
      .insert([req.body])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/licensing/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_licensing_items')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/licensing/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('rental_licensing_items')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ TODOS ============

app.get('/api/todos', async (req, res) => {
  try {
    let query = supabase
      .from('rental_todos')
      .select('*, rental_properties(nickname)')
      .order('created_at', { ascending: false });

    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.property_id) query = query.eq('property_id', req.query.property_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/todos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_todos')
      .insert([req.body])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/todos/:id', async (req, res) => {
  try {
    const body = { ...req.body };
    if (body.status === 'completed' && !body.completed_at) {
      body.completed_at = new Date().toISOString();
    }
    if (body.status === 'pending') {
      body.completed_at = null;
    }
    const { data, error } = await supabase
      .from('rental_todos')
      .update(body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/todos/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('rental_todos')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ iCAL SYNC ============

app.post('/api/sync-ical', async (req, res) => {
  try {
    const { property_id } = req.body;

    // Get property
    const { data: property, error: propError } = await supabase
      .from('rental_properties')
      .select('*')
      .eq('id', property_id)
      .single();
    if (propError) throw propError;

    const urls = [];
    if (property.airbnb_ical_url) urls.push({ url: property.airbnb_ical_url, source: 'airbnb' });
    if (property.vrbo_ical_url) urls.push({ url: property.vrbo_ical_url, source: 'vrbo' });

    let synced = 0;
    for (const { url, source } of urls) {
      try {
        const events = await ical.async.fromURL(url);
        for (const [uid, event] of Object.entries(events)) {
          if (event.type !== 'VEVENT') continue;

          const startDate = event.start ? new Date(event.start).toISOString().split('T')[0] : null;
          const endDate = event.end ? new Date(event.end).toISOString().split('T')[0] : null;
          if (!startDate || !endDate) continue;

          const { error: upsertError } = await supabase
            .from('rental_synced_events')
            .upsert({
              property_id,
              source,
              uid: uid.substring(0, 255),
              summary: (event.summary || 'Blocked').substring(0, 255),
              start_date: startDate,
              end_date: endDate,
              last_synced: new Date().toISOString()
            }, { onConflict: 'property_id,source,uid' });

          if (!upsertError) synced++;
        }
      } catch (icalErr) {
        console.error(`Error fetching iCal from ${source}:`, icalErr.message);
      }
    }

    res.json({ success: true, synced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/synced-events', async (req, res) => {
  try {
    let query = supabase
      .from('rental_synced_events')
      .select('*, rental_properties(nickname)')
      .order('start_date', { ascending: true });

    if (req.query.property_id) query = query.eq('property_id', req.query.property_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ SMS MESSAGING ============

app.get('/api/sms', async (req, res) => {
  try {
    let query = supabase
      .from('rental_sms_messages')
      .select('*')
      .order('created_at', { ascending: false });

    if (req.query.guest_id) query = query.eq('guest_id', req.query.guest_id);
    if (req.query.cleaner_id) query = query.eq('cleaner_id', req.query.cleaner_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sms/send', async (req, res) => {
  try {
    const { to, body, guest_id, cleaner_id, property_id } = req.body;

    if (!twilioClient) {
      return res.status(500).json({ error: 'Twilio not configured' });
    }

    const message = await twilioClient.messages.create({
      body,
      from: twilioPhone,
      to
    });

    const { data, error } = await supabase
      .from('rental_sms_messages')
      .insert([{
        direction: 'outbound',
        from_number: twilioPhone,
        to_number: to,
        body,
        twilio_sid: message.sid,
        guest_id: guest_id || null,
        cleaner_id: cleaner_id || null,
        property_id: property_id || null,
        sent_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Twilio webhook for incoming SMS
app.post('/api/sms/webhook', async (req, res) => {
  try {
    const { From, Body, MessageSid } = req.body;

    await supabase
      .from('rental_sms_messages')
      .insert([{
        direction: 'inbound',
        from_number: From,
        to_number: twilioPhone,
        body: Body,
        twilio_sid: MessageSid,
        received_at: new Date().toISOString()
      }]);

    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ BOOKING REQUESTS (Public) ============

app.get('/api/booking-requests', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_booking_requests')
      .select('*, rental_properties(nickname)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/booking-requests', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_booking_requests')
      .insert([{ ...req.body, status: 'pending' }])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/booking-requests/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_booking_requests')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ DASHBOARD / STATS ============

app.get('/api/dashboard', async (req, res) => {
  try {
    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1).toISOString();

    // Get all bookings this year
    const { data: bookings, error: bErr } = await supabase
      .from('rental_bookings')
      .select('*')
      .gte('check_in', yearStart);
    if (bErr) throw bErr;

    // Get all properties
    const { data: properties, error: pErr } = await supabase
      .from('rental_properties')
      .select('*');
    if (pErr) throw pErr;

    const totalEarnings = (bookings || []).reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);
    const totalBookings = (bookings || []).length;

    // Calculate occupancy and ADR
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / (1000 * 60 * 60 * 24)) + 1;
    const totalAvailableNights = (properties || []).length * dayOfYear;

    let totalBookedNights = 0;
    (bookings || []).forEach(b => {
      if (b.check_in && b.check_out) {
        const ci = new Date(b.check_in);
        const co = new Date(b.check_out);
        const nights = Math.max(0, Math.floor((co - ci) / (1000 * 60 * 60 * 24)));
        totalBookedNights += nights;
      }
    });

    const occupancyRate = totalAvailableNights > 0 ? (totalBookedNights / totalAvailableNights) * 100 : 0;
    const avgNightlyRate = totalBookedNights > 0 ? totalEarnings / totalBookedNights : 0;
    const revPAR = totalAvailableNights > 0 ? totalEarnings / totalAvailableNights : 0;

    res.json({
      totalEarnings,
      totalBookings,
      occupancyRate: Math.round(occupancyRate * 10) / 10,
      avgNightlyRate: Math.round(avgNightlyRate * 100) / 100,
      revPAR: Math.round(revPAR * 100) / 100,
      totalProperties: (properties || []).length,
      totalBookedNights,
      totalAvailableNights
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ MAILING LIST ============

app.get('/api/mailing-list', async (req, res) => {
  try {
    // Get all guests who have bookings
    const { data: bookings, error } = await supabase
      .from('rental_bookings')
      .select('*, rental_guests(id, name, email, phone), rental_properties(nickname)')
      .not('guest_id', 'is', null)
      .order('check_out', { ascending: false });
    if (error) throw error;

    // Group by guest
    const guestMap = {};
    (bookings || []).forEach(b => {
      if (b.rental_guests && b.rental_guests.email) {
        const gId = b.rental_guests.id || b.guest_id;
        if (!guestMap[gId]) {
          guestMap[gId] = {
            ...b.rental_guests,
            lastStay: b.check_out,
            property: b.rental_properties?.nickname || 'Unknown',
            bookingCount: 0,
            invite_sent: b.invite_sent
          };
        }
        guestMap[gId].bookingCount++;
      }
    });

    res.json(Object.values(guestMap));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PUBLIC BOOKING PAGE ============

app.get('/api/public/properties', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_properties')
      .select('id, nickname, address, notes')
      .eq('public_bookable', true);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ LOCAL SERVER ============

// Only start listening if run directly (not as Vercel serverless function)
if (require.main === module) {
  const PORT = process.env.PORT || 3004;
  app.listen(PORT, () => {
    console.log(`Rental Tracker running on http://localhost:${PORT}`);
  });
}

module.exports = app;
