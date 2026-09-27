/* ============================================================
   CashFlow OS — connection settings
   ------------------------------------------------------------
   The publishable key below is DESIGNED to be public. Supabase
   calls it "publishable" precisely because it ships in web apps;
   what keeps your money private is Row Level Security in the
   database, not this key's secrecy. Never put the service_role /
   secret key in a file that goes to a browser.
   ============================================================ */

window.CASHFLOW_CONFIG = {
  url: 'https://dmvwbgvbgvxwkezmuzdc.supabase.co',
  publishableKey: 'sb_publishable_IkwgH4XzD8a_4vmk-4HoXA_fHN35plB',

  // App identity. Used to recognise our own backup files.
  appId: 'cashflow-os',

  // Must match the app-build meta tag in index.html. Compared on every boot:
  // if the HTML being served is newer than the script that is running, the
  // service worker is handing out a stale file and the page only half-updates
  // itself (a missing tab, an empty dropdown). Instead of leaving a
  // half-working app on screen, the caches are cleared and the page reloads
  // once. Bump this on every deploy, along with the service worker's
  // CACHE_VERSION.
  appBuild: 'v20',

  // The Edge Function that receives forwarded bank emails. Public: it is just an
  // address, and the shared secret that goes with it is typed in by the user at
  // runtime and never written to a file. Having the app supply the address
  // removes the step where someone is asked to assemble a URL out of a dashboard
  // and a function name, and mistypes it — which then looks like the provider is
  // at fault rather than the address.
  emailWebhookBase: 'https://dmvwbgvbgvxwkezmuzdc.supabase.co/functions/v1/poll-emails',

  // How often the background loop wakes up, in milliseconds.
  // Only ever runs while the page is open AND signed in.
  pollIntervalMs: 60000,

  // A push is batched for this long after an edit, so typing ten
  // transactions quickly costs one request instead of ten.
  pushDebounceMs: 1500,

  // An access token is refreshed this long before it expires,
  // leaving room for a slow network without forcing a logout.
  refreshMarginMs: 120000
};
