# Deploying to Vercel

The app is structured to run as a single Vercel serverless function (the Express app is exported
from `server.js`; `module.exports = app`). Data lives in Supabase, so the function is stateless and
safe to run across multiple serverless instances.

## One-time setup

1. **Install the Vercel CLI** and log in:
   ```bash
   npm i -g vercel
   vercel login
   ```

2. **Link the project** (run in the project root):
   ```bash
   vercel link
   ```

3. **Set the environment variables** in the Vercel dashboard (Project → Settings → Environment
   Variables) — copy the values from your local `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`  *(secret)*
   - `RENTAL_ALLOWED_EMAILS`
   - `PRICELABS_API_KEY`
   - `CRON_SECRET`  *(Vercel sends this as `Authorization: Bearer <CRON_SECRET>` to the cron path)*
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`  *(for guest SMS)*

## Deploy

```bash
vercel --prod
```

`vercel.json` already routes all traffic to `server.js`, bundles `public/**`, and registers the
hourly cron that drives the guest-message scheduler (`/api/cron/scheduler`).

## After deploy

- Open the Vercel URL → log in with an allow-listed email.
- On your phones: open the URL → browser menu → **Add to Home Screen**. It stays logged in.
- The message scheduler only sends when you enable **auto-send** in Settings (off by default).

## Known limitation — file uploads

Licensing **file attachments** currently use the local filesystem, which is ephemeral on Vercel
(uploads won't persist across requests). Everything else is fully serverless-ready. To make
attachments durable, migrate them to **Supabase Storage** (a follow-up task): swap multer to
`memoryStorage`, upload buffers to a `rental-uploads` bucket, and store the returned URLs in
`rental_licensing_items.attachments`.

## Always-on alternative (no refactor needed)

If you'd rather not use serverless, this same codebase runs as-is on Render/Railway/Fly — set the
same env vars, use `npm start`, and the in-process hourly scheduler runs automatically (no Vercel
Cron needed). Either host works; the app detects whether it's running standalone vs. as a function.
