// Branding + API config for the public booking page.
// Edit these to match your brand. The API_BASE_URL must point to your local
// rental tracker — for production deployment from Vercel, expose it via a
// tunnel (ngrok, Cloudflare Tunnel) and put the public tunnel URL here.

window.SITE_CONFIG = {
  // ---- Branding ----
  brandName: 'Welcome Back',
  brandInitial: 'M',
  tagline: "A private booking page for past guests. Skip the Airbnb fees and book directly with me.",

  // ---- API ----
  // Local development:    http://localhost:3004
  // Production via tunnel: https://your-tunnel-id.ngrok-free.app  (or cloudflare/etc)
  API_BASE_URL: 'http://localhost:3004',
};
