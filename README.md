# Short-Term Rental Tracker

A local web app for managing your short-term rental properties — bookings, guests, cleaners, calendar sync (Airbnb / VRBO iCal), maintenance checklists, dashboard metrics, mailing list, and a separate public-facing booking page for returning guests.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npm start
```

Then open **http://localhost:3004**.

No native dependencies — installation is fast and never needs a compiler.

A JSON file `rental.db.json` is created in the project folder on first run. Back this file up — it holds everything.

## Features

- **Properties** — nickname, address, Airbnb/VRBO iCal URLs, internal notes, **welcome message** (shown to repeat guests on the public booking page), **default cleaner** (used to auto-create turnover tasks), and a **public bookable** toggle that lets the property appear on your public booking site.
- **Calendar** — month grid with manual bookings + read-only Airbnb/VRBO synced events (🔒). Filter by property.
- **Bookings** — date, property, type, amount, contact name, guest. Filter by property/type/year. Live revenue summary by booking type to compare ROI across Airbnb / VRBO / Cottages Canada / Private.
- **Bulk Import** — spreadsheet-style grid for entering many bookings row-by-row, plus a "paste from spreadsheet" textarea (TSV). Property and booking type can be referenced by name; unknown booking types are auto-created.
- **Booking Requests** — inbound requests from your public booking page. Approve to convert into a real booking (auto-creates the guest if needed); reject or delete otherwise. Pending count badge appears in the top tab.
- **Guests** — auto-created when you add a booking with a new name; or add manually.
- **Cleaners** — name, phone (clickable), email (clickable), rate, notes.
- **Cleaner Calendar** — separate calendar view of cleaning tasks. **When a booking is created for a property with an assigned default cleaner, a task is automatically created on the cleaner's calendar with the check-out date as the due date.** Color-coded per cleaner; click any task to mark it done or edit. You can also add manual tasks.
- **Mailing List** — every past guest with **months since their last booking**. Filter by eligibility (all / 6+ months / 11+ months — for the year-later invite). Adjustable discount %. Click "Email" and your default mail client opens with the invite pre-filled, including the property's welcome message if set.
- **Maintenance** — per-property checklist seeded with common items (sheets, broom, garbage bags, dishwasher pods, laundry detergent, etc.). Tick to mark in-stock; out-of-stock items show on the dashboard.
- **To Do** — task list for property work (cut grass, test smoke alarms, install smoke alarms, resupply, assemble beds, etc.). Each task has a title, priority (High/Medium/Low), optional due date, optional property, and notes. Group view: Overdue, This week, No date (sorted by priority), Later, Completed (collapsible). Inline checkbox to mark done.
- **Dashboard** — YTD earnings, YTD nights, avg per booking, upcoming bookings, pending request count, **open to-do count + overdue badge**, low-stock count. **Tasks for this week card** showing tasks due in the next 7 days + High-priority no-date tasks, with inline checkboxes. **Vacancy rate by month** bar chart across all properties. Earnings by booking type. Earnings by property with **occupancy %, ADR, and RevPAR** columns.

## Navigation

Top-level tabs: **Dashboard · Properties · Booking Calendar · Bookings · Requests · To Do · Guests · Cleaners · Tools ▾**

The **Tools** dropdown groups: Bulk Import, Mailing List, Maintenance, Cleaner Calendar.

## Calendar sync (Airbnb / VRBO)

Both platforms expose a per-listing iCal export URL (read-only):

- **Airbnb:** Listing → Calendar → Availability → "Sync calendars" → "Export Calendar"
- **VRBO:** Calendar → "Import/Export Calendars" → copy your VRBO export link

Paste each into the property edit form. Click **Sync** on a property, or **Sync all calendars** in the top bar. Synced events appear on the calendar but cannot be edited (they reflect what's on the platform).

## Public booking page (separate Vercel site)

A separate, branded booking page lives in `public-site/`. It's a static site, deployable to Vercel as-is. Returning guests look themselves up by email, see their past stays, see your property's welcome message, and submit a booking request — which lands in your **Requests** tab.

See `public-site/README.md` for setup. The short version:

```bash
cd public-site
npx serve . -l 5173    # for local dev — both apps run on your machine
```

For production: deploy `public-site/` to Vercel, then expose your local tracker via a tunnel (Cloudflare Tunnel or ngrok) and update `public-site/config.js` with the tunnel URL.

## File structure

```
package.json
server.js              Express + JSON store + iCal fetch + cleaner-task automation
public/
  index.html
  style.css
  app.js               SPA admin front-end
public-site/           Separate Vercel-deployable booking site for returning guests
  index.html
  style.css
  app.js
  config.js            Branding + API URL
  vercel.json
  README.md            Deploy / tunnel instructions
rental.db.json         (created on first run; gitignored)
```

## Backup / move to another machine

Stop the server, copy `rental.db.json` somewhere safe. To restore, drop it back in the project folder and run `npm start`.
