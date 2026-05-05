(function () {
  'use strict';
  const cfg = window.SITE_CONFIG || {};
  const API = cfg.API_BASE_URL || 'http://localhost:3004';

  // Apply branding
  document.getElementById('brandName').textContent = cfg.brandName || 'Welcome Back';
  document.getElementById('brandMark').textContent = cfg.brandInitial || 'M';
  document.getElementById('tagline').textContent = cfg.tagline || '';

  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');
  const showOnly = (id) => {
    ['step-lookup', 'step-book', 'step-success', 'step-notfound'].forEach(s => s === id ? show(s) : hide(s));
  };

  let knownGuest = null;
  let availableProperties = [];

  async function call(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
  }

  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // ---------- Lookup ----------
  $('lookupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('emailInput').value.trim();
    if (!email) return;
    hide('lookupError');
    try {
      const [lookup, properties] = await Promise.all([
        call('POST', '/api/public/guest-lookup', { email }),
        call('GET', '/api/public/properties'),
      ]);
      if (!lookup.found) {
        showOnly('step-notfound');
        return;
      }
      if (!properties.length) {
        $('lookupError').innerHTML =
          "Welcome back, <strong>" + (lookup.name || 'friend') + "</strong>! " +
          "I'm recognized you, but I haven't published any properties for direct booking yet. " +
          "Please book through Airbnb or VRBO for now &mdash; or, if you're the host: open the admin, edit a property, tick &ldquo;Public booking&rdquo;, and save.";
        show('lookupError');
        return;
      }
      knownGuest = { email, name: lookup.name, stays: lookup.stays || [] };
      availableProperties = properties;
      renderBookingStep();
    } catch (err) {
      $('lookupError').textContent = "Couldn't reach the booking system. Please try again later, or book through Airbnb / VRBO.";
      show('lookupError');
    }
  });

  function renderBookingStep() {
    $('guestName').textContent = knownGuest.name || 'friend';

    // Past stays
    const ps = $('pastStays');
    ps.innerHTML = '';
    if (knownGuest.stays.length) {
      const heading = document.createElement('p');
      heading.className = 'muted small';
      heading.textContent = `You've stayed with us ${knownGuest.stays.length} time${knownGuest.stays.length === 1 ? '' : 's'}:`;
      ps.appendChild(heading);
      const ul = document.createElement('ul');
      ul.className = 'past-stays-list';
      knownGuest.stays.forEach(s => {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${s.property_name || 'Stay'}</strong> &middot; ${fmtDate(s.check_in)}${s.check_out ? ' → ' + fmtDate(s.check_out) : ''}`;
        ul.appendChild(li);
      });
      ps.appendChild(ul);
    }

    // Property select — pre-select last property they stayed at if it's still bookable
    const sel = $('propertySelect');
    sel.innerHTML = '';
    availableProperties.forEach(p => {
      const o = document.createElement('option');
      o.value = String(p.id);
      o.textContent = p.nickname;
      o.dataset.welcome = p.welcome_message || '';
      sel.appendChild(o);
    });
    const lastStay = knownGuest.stays[0];
    if (lastStay && availableProperties.find(p => p.id === lastStay.property_id)) {
      sel.value = String(lastStay.property_id);
    }
    updateWelcome();
    sel.addEventListener('change', updateWelcome);

    showOnly('step-book');
  }

  function updateWelcome() {
    const sel = $('propertySelect');
    const opt = sel.options[sel.selectedIndex];
    const msg = opt ? opt.dataset.welcome : '';
    if (msg) {
      $('welcomeBox').textContent = msg;
      show('welcomeBox');
    } else {
      hide('welcomeBox');
    }
  }

  // ---------- Submit booking request ----------
  $('bookForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hide('bookError');
    const payload = {
      guest_name: knownGuest.name || '',
      guest_email: knownGuest.email,
      property_id: Number($('propertySelect').value),
      check_in: $('checkIn').value,
      check_out: $('checkOut').value || null,
      proposed_amount: Number($('amount').value) || 0,
      message: $('message').value,
    };
    if (!payload.check_in || !payload.property_id) {
      $('bookError').textContent = 'Please pick a property and a check-in date.';
      show('bookError');
      return;
    }
    try {
      await call('POST', '/api/public/booking-requests', payload);
      showOnly('step-success');
    } catch (err) {
      $('bookError').textContent = "Couldn't submit your request: " + err.message;
      show('bookError');
    }
  });

  $('restartBtn').addEventListener('click', () => {
    $('emailInput').value = '';
    $('checkIn').value = '';
    $('checkOut').value = '';
    $('amount').value = '';
    $('message').value = '';
    knownGuest = null;
    showOnly('step-lookup');
  });
  $('tryAgainBtn').addEventListener('click', () => {
    $('emailInput').value = '';
    showOnly('step-lookup');
  });
})();
