# Public Booking Page

A small, branded direct-booking page for **returning guests** of your short-term rentals. Hosted on Vercel as a static site. Talks to your local Rental Tracker (`localhost:3004`) over a tunnel so booking requests flow back to your private admin.

## What it does

1. Returning guest lands on the page, enters their email.
2. The site calls `/api/public/guest-lookup` on your local tracker. If their email matches a past stay, they see their name, past stays, and a booking form.
3. They pick a property (only those you've flagged "Public booking" in the admin), pick dates, write a note, and submit.
4. The submission lands in your **Requests** tab on the local app. You review it and click **Approve** to convert it into a real booking, or **Reject**.

Properties marked "Public booking" also expose their `welcome_message` here, which is shown when a guest selects that property — a nice personal touch.

## Local dev (the easy path)

The site is a plain static site — three files plus config:

```
public-site/
  index.html
  style.css
  app.js
  config.js     ← edit branding + API URL here
  vercel.json
```

To run locally:

```bash
# from inside public-site/
npx serve . -l 5173
# or any static file server you like
```

Make sure your tracker is running on `localhost:3004`. Open `http://localhost:5173`.

`config.js` already points at `http://localhost:3004`, so the public site can talk to the local tracker because both are on your machine.

## Deploying to Vercel

1. Push this `public-site/` folder to a git repo (or drag-drop it into Vercel's dashboard).
2. Vercel auto-detects it as a static site — no build step needed.
3. **Important:** once deployed, `localhost:3004` is no longer reachable from the deployed site. You need to expose your local tracker over a tunnel:
   - **Cloudflare Tunnel (free, recommended):** `cloudflared tunnel --url http://localhost:3004`
   - **ngrok:** `ngrok http 3004`
4. Copy the tunnel URL (e.g. `https://something-random.trycloudflare.com`).
5. Edit `config.js`:
   ```js
   window.SITE_CONFIG = {
     ...
     API_BASE_URL: 'https://something-random.trycloudflare.com',
   };
   ```
6. Push the change. Vercel redeploys automatically.

When you stop your local tracker (or close the tunnel), the public booking page will show a friendly error — guests can still try Airbnb/VRBO.

## Branding

Edit `config.js` for name + tagline + initial. Edit `style.css` `:root` block for colors:

```css
--brand: #2f6d5b;            /* deep cottage green */
--accent: #d4a574;           /* warm gold */
--bg: #faf8f3;               /* cream */
```

## Security note

The public endpoints (`/api/public/*`) are intentionally limited:
- They only list properties you've explicitly flagged as `public_bookable`.
- Lookup never returns booking amounts or other guests' data.
- Booking requests are saved as `pending` — nothing becomes a real booking until you approve it on the admin side.

If you want to lock this down further (e.g. require an API key), wrap the `/api/public/*` middleware in `server.js` with a header check.
