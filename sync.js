/* ============================================================
   CashFlow OS — sync engine
   ------------------------------------------------------------
   Design
   • Offline-first. The app never waits on the network. Every edit is
     written to localStorage immediately and the network is told about
     it afterwards, as a background nicety.
   • No library. Supabase is reached over its plain REST API with
     fetch, so the app keeps its zero-dependency, offline-capable
     shape instead of pulling in a 120KB SDK that a service worker
     would then have to cache.
   • Last-write-wins. Every record carries a client-assigned
     `updatedAt`. The newest version of a record wins, per record.
     For one person's money across two devices this is the right
     trade-off; CRDTs would be a lot of machinery for a problem
     this app does not have.
   • Deletes are tombstones. Removing a row outright would let it
     reappear from another device on the next pull, so a delete is
     pushed as `deleted = true` and the record is hidden.

   What this cannot do: if a device is offline, an edit cannot reach
   the server yet. It is queued and retried, and the UI says so.
   Nothing can make an offline write arrive immediately.
   ============================================================ */

window.CashFlowSync = (function () {
  'use strict';

  const CFG = window.CASHFLOW_CONFIG || {};
  const SYNC_KEY = 'cashflow:sync';
  const ALL_TABLES = ['transactions', 'accounts', 'debts', 'custody', 'shopping'];

  /* ---------- row <-> record mapping ----------
     Kept explicit rather than derived, so a column rename in SQL and
     a field rename in the state can never drift apart silently. */
  const MAP = {
    transactions: {
      toRow: (r) => ({
        id: r.id, type: r.type, amount: r.amount, category: r.category,
        comment: r.comment, happened_at: r.date, account_id: r.accountId,
        to_account_id: r.toAccountId, source: r.source || null
      }),
      fromRow: (row) => ({
        id: row.id, updatedAt: row.updated_at, type: row.type, amount: Number(row.amount),
        category: row.category, comment: row.comment, date: row.happened_at,
        accountId: row.account_id, toAccountId: row.to_account_id,
        source: row.source || undefined
      })
    },
    accounts: {
      toRow: (r) => ({
        id: r.id, name: r.name, kind: r.kind,
        opening_balance: r.openingBalance, archived: r.archived
      }),
      fromRow: (row) => ({
        id: row.id, updatedAt: row.updated_at, name: row.name, kind: row.kind,
        openingBalance: Number(row.opening_balance), archived: row.archived
      })
    },
    debts: {
      toRow: (r) => ({
        id: r.id, type: r.type, person: r.person, amount: r.amount, note: r.note,
        happened_at: r.date, settled: r.settled, settled_at: r.settledAt || '',
        ledger: r.ledger
      }),
      fromRow: (row) => ({
        id: row.id, updatedAt: row.updated_at, type: row.type, person: row.person,
        amount: Number(row.amount), note: row.note, date: row.happened_at,
        settled: row.settled, settledAt: row.settled_at || null, ledger: row.ledger
      })
    },
    custody: {
      toRow: (r) => ({
        id: r.id, person: r.person, direction: r.direction, amount: r.amount,
        returned: r.returned, note: r.note, happened_at: r.date,
        returned_at: r.returnedDate || ''
      }),
      fromRow: (row) => ({
        id: row.id, updatedAt: row.updated_at, person: row.person, direction: row.direction,
        amount: Number(row.amount), returned: Number(row.returned), note: row.note,
        date: row.happened_at, returnedDate: row.returned_at || null
      })
    },
    shopping: {
      toRow: (r) => ({
        id: r.id, name: r.name, qty: r.qty, note: r.note, checked: r.checked,
        created_at: r.createdAt, checked_at: r.checkedAt || '',
        bought_tx_id: r.boughtTxId, cost: r.cost
      }),
      fromRow: (row) => ({
        id: row.id, updatedAt: row.updated_at, name: row.name, qty: row.qty, note: row.note,
        checked: row.checked, createdAt: row.created_at, checkedAt: row.checked_at || null,
        boughtTxId: row.bought_tx_id || null, cost: row.cost === null ? null : Number(row.cost)
      })
    }
  };

  /* ---------- local bookkeeping ----------
     Kept in its own storage key, deliberately separate from the app
     state: cursors and tombstones are sync plumbing, not user data,
     and should not end up in a backup file. */
  function emptyBook() {
    const b = { lastPushed: {}, lastPulled: {}, tombstones: {}, prefsPushedAt: null, prefsPulledAt: null };
    ALL_TABLES.forEach((t) => { b.lastPushed[t] = null; b.lastPulled[t] = null; b.tombstones[t] = []; });
    return b;
  }
  let book = emptyBook();
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (raw) book = Object.assign(emptyBook(), JSON.parse(raw));
  } catch (err) { book = emptyBook(); }

  function saveBook() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(book)); } catch (err) { /* quota: plumbing only */ }
  }

  /* ---------- monotonic clock ----------
     A record is "dirty" when updatedAt is newer than the last thing
     we managed to push. If the device clock jumped backwards, an edit
     could land before the cursor and never sync — so every stamp is
     forced to be strictly greater than the previous one. */
  let lastStamp = 0;
  function touch() {
    const now = Date.now();
    lastStamp = now > lastStamp ? now : lastStamp + 1;
    return new Date(lastStamp).toISOString();
  }
  /** Called after the app state is loaded, so a fresh session never
   *  hands out a stamp older than a record already on disk. */
  function seedClock(state) {
    let max = 0;
    for (const t of ALL_TABLES) {
      for (const r of (state && state[t]) || []) {
        const v = Date.parse(r && r.updatedAt);
        if (Number.isFinite(v) && v > max) max = v;
      }
    }
    if (max > lastStamp) lastStamp = max;
  }

  /* ---------- change detection ----------
     Rather than trusting every call site to remember to stamp a record,
     reconcile() compares the live state against a shadow of the last
     seen state and stamps whatever moved. One place, so a new feature
     cannot forget to and silently fail to sync.

     The shadow starts EMPTY on purpose: the first reconcile therefore
     stamps everything, which is what makes a brand new account upload
     its whole history on first sign-in. */
  let shadow = { transactions: [], accounts: [], debts: [], custody: [], shopping: [] };
  const clone = (r) => Object.assign({}, r);
  const fingerprint = (r) => JSON.stringify(r);

  /* A delete queued by markDeleted() counts as a change, even though
     reconcile() then finds the tombstone already present and skips adding a
     second one. Without this, deleting a record reported "nothing changed", so
     queuePush() was never called and the delete silently never synced. */
  let markedSinceLastReconcile = 0;

  function reconcile(state) {
    let changed = false;
    for (const t of ALL_TABLES) {
      const list = state[t] || [];
      const prev = shadow[t] || [];
      const prevById = new Map();
      for (const p of prev) prevById.set(p.id, p);
      const liveIds = new Set();

      for (const r of list) {
        liveIds.add(r.id);
        const before = prevById.get(r.id);
        if (before && fingerprint(before) === fingerprint(r)) continue;
        r.updatedAt = touch();
        changed = true;
      }

      // Anything in the shadow but gone from the state was deleted, and
      // needs a tombstone so the delete reaches the other devices.
      for (const p of prev) {
        if (liveIds.has(p.id)) continue;
        if (!book.tombstones[t]) book.tombstones[t] = [];
        // One tombstone per id. markDeleted() may already have queued this one.
        if (book.tombstones[t].some((x) => x.id === p.id)) continue;
        book.tombstones[t].push({ id: p.id, updatedAt: touch() });
        changed = true;
      }

      shadow[t] = list.map(clone);
    }
    const marked = markedSinceLastReconcile > 0;
    markedSinceLastReconcile = 0;
    if (changed || marked) saveBook();
    return changed || marked;
  }

  /** Called after a pull so server rows are not re-stamped as local edits. */
  function absorbShadow(table, list) {
    shadow[table] = (list || []).map(clone);
  }

  /* ---------- session ---------- */
  const SESSION_KEY = 'cashflow:session';
  let session = null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) session = JSON.parse(raw);
  } catch (err) { session = null; }

  function saveSession() {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (err) { /* ignore */ }
  }

  /* ---------- HTTP ---------- */
  function headers(extra) {
    const h = Object.assign({
      apikey: CFG.publishableKey,
      'Content-Type': 'application/json'
    }, extra || {});
    if (session && session.accessToken) h.Authorization = 'Bearer ' + session.accessToken;
    return h;
  }

  function authPath(suffix) { return CFG.url + '/auth/v1' + suffix; }
  function restPath(table) { return CFG.url + '/rest/v1/' + table; }

  async function http(url, opts) {
    const res = await fetch(url, opts);
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch (err) { body = text; } }
    if (!res.ok) {
      const msg = (body && (body.msg || body.message || body.error_description)) ||
        (body && body.error) || ('HTTP ' + res.status);
      const e = new Error(msg);
      e.status = res.status;
      e.body = body;
      throw e;
    }
    return body;
  }

  /** Like http(), but also hands back the response headers.
   *  PostgREST reports the total row count in Content-Range, which is the only
   *  cheap way to ask "how much of this table is actually on the server". */
  async function httpWithHeaders(url, opts) {
    const res = await fetch(url, opts);
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch (err) { body = text; } }
    if (!res.ok) {
      const msg = (body && (body.msg || body.message || body.error_description)) ||
        (body && body.error) || ('HTTP ' + res.status);
      const e = new Error(msg);
      e.status = res.status;
      e.body = body;
      throw e;
    }
    let count = null;
    const range = res.headers && res.headers.get ? res.headers.get('content-range') : null;
    if (range) {
      // "0-99/1234" when there are rows, "*/0" when there are none.
      const m = range.split('/');
      const total = parseInt(m[m.length - 1], 10);
      if (!Number.isNaN(total)) count = total;
    }
    return { body, count };
  }

  /* ---------- auth: email + password ----------
     The password is sent over TLS and Supabase stores only a bcrypt hash, so
     the plain value is never written down anywhere we control.

     8 characters is enforced in the UI. That is a floor, not a suggestion:
     the publishable key is baked into the app and readable by anyone, so the
     only thing standing between an attacker and someone's ledger is the
     password itself. Rate limiting helps, but it is not a substitute for
     length. */
  const MIN_PASSWORD = 8;

  function validateCredentials(email, password) {
    const e = String(email || '').trim();
    if (!e || e.indexOf('@') === -1 || e.indexOf('.') === -1) return 'Enter a valid email address';
    const p = String(password == null ? '' : password);
    if (p.length < MIN_PASSWORD) return 'Your password must be at least ' + MIN_PASSWORD + ' characters';
    return null;
  }

  async function signUp(email, password) {
    const bad = validateCredentials(email, password);
    if (bad) return { error: bad };
    try {
      const out = await http(authPath('/signup'), {
        method: 'POST', headers: headers(), body: JSON.stringify({ email: email.trim(), password })
      });
      if (!out || !out.access_token) {
        return { needsEmailConfirm: true };
      }
      adopt(out, email);
      return { ok: true };
    } catch (err) {
      // A repeat sign-up means the account already exists: sign in instead.
      if (/already registered|already exists/i.test(err.message || '')) {
        return { error: 'That email is already registered — sign in instead' };
      }
      return { error: err.message };
    }
  }

  async function signIn(email, password) {
    const bad = validateCredentials(email, password);
    if (bad) return { error: bad };
    try {
      const out = await http(authPath('/token?grant_type=password'), {
        method: 'POST', headers: headers(), body: JSON.stringify({ email: email.trim(), password })
      });
      adopt(out, email);
      return { ok: true };
    } catch (err) {
      if (/Invalid login credentials/i.test(err.message || '')) return { error: 'Wrong email or password' };
      return { error: err.message };
    }
  }

  function adopt(out, email) {
    session = {
      accessToken: out.access_token,
      refreshToken: out.refresh_token,
      // GoTrue sends expires_at in unix seconds; older responses only send
      // expires_in. Work out which one we actually got.
      expiresAt: typeof out.expires_at === 'number' && out.expires_at > 0
        ? out.expires_at * 1000
        : Date.now() + (typeof out.expires_in === 'number' ? out.expires_in : 3600) * 1000,
      userId: out.user && out.user.id,
      email: (out.user && out.user.email) || email
    };
    if (!session.expiresAt) session.expiresAt = Date.now() + 3600000;
    saveSession();
    // `status` is a snapshot taken when this module loaded, so a fresh
    // sign-in has to refresh it or the UI keeps drawing the signed-out panel.
    if (status) { status.signedIn = true; status.email = session.email; }
  }

  /* ---------- password reset ----------
     Two ways in, both ending at the same place:

       1. TYPE the code from the email. Needs the "Magic Link" email
          template edited once in Supabase to show {{ .Token }}.
       2. CLICK the link in the email. Supabase puts a token in the URL
          fragment, and pickRecoveryFromUrl() picks it up on the next load.

     Either way we end up holding a short-lived recovery token, and only
     then can a new password be set.

     That token is deliberately kept apart from the session. A recovery token
     is good for changing the password and for nothing else, so a leaked reset
     link can never read or write your ledger. */

  const RESET_KEY = 'cashflow:reset';

  function loadReset() {
    try {
      const raw = localStorage.getItem(RESET_KEY);
      if (!raw) return null;
      const r = JSON.parse(raw);
      if (!r || !r.token) return null;
      // A token past its expiry would be rejected anyway; drop it so the UI
      // does not sit on a "set new password" form that can never succeed.
      if (r.expiresAt && Date.now() > r.expiresAt) { clearReset(); return null; }
      return r;
    } catch (err) { return null; }
  }
  function saveReset(r) {
    try { localStorage.setItem(RESET_KEY, JSON.stringify(r)); } catch (err) { /* ignore */ }
  }
  function clearReset() {
    try { localStorage.removeItem(RESET_KEY); } catch (err) { /* ignore */ }
  }

  function adoptReset(out, email) {
    const r = {
      token: out.access_token,
      userId: out.user && out.user.id,
      email: (out.user && out.user.email) || email || decodeJwtEmail(out.access_token) || null,
      // Recovery links are short-lived by design. A small grace period on top
      // so a form filled in slowly is not rejected at the last moment.
      expiresAt: Date.now() + ((typeof out.expires_in === 'number' ? out.expires_in : 3600) + 300) * 1000
    };
    saveReset(r);
    return r;
  }

  /** The address a recovery token belongs to, read out of the token itself.
   *
   *  Needed because Supabase's emailed link does not carry the address: the
   *  fragment is
   *
   *      #access_token=…&expires_in=…&refresh_token=…&token_type=bearer&type=recovery
   *
   *  with no `email`. Without this, the code path worked (the user typed the
   *  address) and the link path did not: the new password was set correctly and
   *  then the automatic sign-in failed with "Enter a valid email address",
   *  leaving the user holding a password they had just chosen and an error.
   *
   *  The payload is read without checking the signature, and that is
   *  deliberate. It is not being trusted for anything — it only pre-fills a
   *  field. Every request that matters is made with the token, and the server
   *  verifies the signature on each one, so a forged payload achieves nothing
   *  beyond showing the user a wrong address in a box they can correct. */
  function decodeJwtEmail(token) {
    try {
      const parts = String(token || '').split('.');
      if (parts.length < 2) return null;
      /* base64url -> base64, then atob -> bytes -> UTF-8. btoa/atob need
         latin1 input, and an address is ASCII, but the guard keeps a
         non-ASCII claim from throwing. */
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const claims = JSON.parse(decodeURIComponent(escape(atob(b64))));
      const found = claims.email ||
        (claims.user_metadata && claims.user_metadata.email) ||
        (claims.user && claims.user.email);
      return typeof found === 'string' && found.indexOf('@') !== -1 ? found : null;
    } catch (err) { return null; }
  }

  /** Where a reset link should send the user, worked out from the page itself.
   *
   *  Supabase falls back to the project's Site URL when the caller does not say
   *  where to send the link, and that produced
   *
   *      https://ahmad-10-2001.github.io/#access_token=…
   *
   *  while the app is served from
   *
   *      https://ahmad-10-2001.github.io/CashFlow-OS/
   *
   *  The link landed on a 404. The token was fine; there was simply no app at
   *  the end of it, and the one-time token died with the click.
   *
   *  Deriving it from the live location means the link is right wherever the
   *  app happens to be served — a GitHub Pages subpath, a custom domain, or a
   *  copy opened on a laptop — instead of needing the dashboard to be edited in
   *  step with every deployment. The value still has to be in the project's
   *  allow-list; GoTrue silently substitutes the Site URL if it is not, so the
   *  dashboard entry still has to be right, but it is now a fallback rather
   *  than the thing everything depends on. */
  function currentAppUrl() {
    try {
      if (typeof location === 'undefined' || !location.origin) return null;
      /* The fragment is dropped deliberately: it is routing state owned by
         showTab(), and carrying it into a redirect would land the user on a
         tab of the previous session's choosing. */
      return location.origin + location.pathname;
    } catch (err) { return null; }
  }

  /** Ask Supabase to email a code/link.
   *  Always reports success, whatever it finds. Answering "no such account"
   *  would turn this form into a way to test which emails are registered. */
  async function requestPasswordReset(email) {
    const e = String(email || '').trim();
    if (!e || e.indexOf('@') === -1 || e.indexOf('.') === -1) {
      return { error: 'Enter a valid email address' };
    }
    const body = { email: e, create_user: false };
    const here = currentAppUrl();
    if (here) body.redirect_to = here;
    try {
      try {
        await http(authPath('/otp'), {
          method: 'POST', headers: headers(),
          body: JSON.stringify(body)
        });
      } catch (err) {
        /* A `redirect_to` outside the project's allow-list is rejected outright
           in some configurations and ignored in others. Either way the reset
           should still go out — a wrong link is a nuisance, no email at all is
           the user locked out — so it is retried once without the address and
           only the second failure is treated as the error. */
        if (!here) throw err;
        delete body.redirect_to;
        await http(authPath('/otp'), {
          method: 'POST', headers: headers(),
          body: JSON.stringify(body)
        });
      }
    } catch (err) {
      const msg = err.message || '';
      // Only failures of the SYSTEM are reported. Anything that depends on
      // whether this particular address has an account — "User not found",
      // "email not confirmed" — is swallowed and answered with success, because
      // echoing it back turns this form into a tool for discovering who has an
      // account here. The two shown below are properties of the project, not of
      // the address, so they say nothing about who is registered.
      if (/rate|limit|too many|security purposes/i.test(msg)) {
        return { error: 'Too many attempts from this address. Wait a few minutes, then try again.' };
      }
      if (/smtp|email provider|not enabled|mailer/i.test(msg)) {
        return { error: 'This project cannot send email yet. Its owner must set up an email provider in Supabase → Authentication → Email.' };
      }
      console.warn('Password reset request did not send:', msg);
    }
    clearReset();
    return { ok: true, email: e };
  }

  /** Trade the emailed code for a recovery token.
   *  The token type differs between GoTrue versions, so both spellings are
   *  tried rather than failing on a version difference. */
  async function verifyResetCode(email, code) {
    const e = String(email || '').trim();
    const token = String(code == null ? '' : code).trim();
    if (!e) return { error: 'Enter your email' };
    if (!token) return { error: 'Enter the code from the email' };
    if (token.length < 6) return { error: 'That code looks too short' };

    let last = null;
    for (const type of ['email', 'magiclink']) {
      try {
        const out = await http(authPath('/verify'), {
          method: 'POST', headers: headers(),
          body: JSON.stringify({ email: e, token, type })
        });
        if (out && out.access_token) { adoptReset(out, e); return { ok: true }; }
        last = new Error('That code was not accepted');
      } catch (err) {
        last = err;
        // A wrong code will not become right under a different type name, and
        // a used one never will. Stop early rather than hammering the server.
        if (/expired|invalid|token/i.test(err.message || '')) return { error: friendlyResetError(err) };
      }
    }
    return { error: friendlyResetError(last) };
  }

  function friendlyResetError(err) {
    const msg = (err && err.message) || '';
    if (/expired/i.test(msg)) return 'That code has expired. Ask for a new one.';
    if (/not found|invalid/i.test(msg)) return 'That code is not right. Check it and try again.';
    if (/rate|limit|too many/i.test(msg)) return 'Too many attempts. Wait a few minutes, then try again.';
    return msg || 'That code could not be verified';
  }

  /** Set the new password. Only possible while holding a recovery token. */
  async function setNewPassword(password) {
    const r = loadReset();
    if (!r) return { error: 'This reset link has expired. Ask for a new one.' };
    const bad = validateCredentials(r.email || 'a@b.co', password);
    if (bad) return { error: bad };
    /* The address is needed afterwards to sign in without making the user type
       the new password twice. If the token did not yield one, the response to
       this call carries the user record and does. */
    let email = r.email;
    try {
      const out = await http(authPath('/user'), {
        method: 'PUT',
        // NOT the session token: a recovery token is scoped to the account
        // holder changing their own password and cannot touch data.
        headers: Object.assign({}, headers(), { Authorization: 'Bearer ' + r.token }),
        body: JSON.stringify({ password })
      });
      if (!email) {
        const u = (out && (out.user || out)) || null;
        if (u && u.email) email = u.email;
      }
    } catch (err) {
      if (/expired|invalid|jwt/i.test(err.message || '')) {
        clearReset();
        return { error: 'This reset link has expired. Ask for a new one.' };
      }
      return { error: err.message };
    }
    clearReset();
    return { ok: true, email: email || null };
  }

  /** Read a recovery link the user clicked.
   *
   *  This must run before any tab routing. The app routes tabs through the
   *  URL fragment, and showTab() overwrites the fragment on the very first
   *  render — which would destroy the recovery token before it was read. */
  function pickRecoveryFromUrl() {
    let hash = '';
    try { hash = String(location.hash || ''); } catch (err) { return null; }
    if (hash.indexOf('access_token') === -1 && hash.indexOf('error') === -1) return null;

    const p = {};
    for (const part of hash.replace(/^#/, '').split('&')) {
      const i = part.indexOf('=');
      if (i === -1) continue;
      try {
        p[decodeURIComponent(part.slice(0, i))] =
          decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
      } catch (err) { /* skip a malformed pair rather than lose the rest */ }
    }

    // Scrub the fragment either way, so a reload cannot replay a spent token
    // and so the token is not left sitting in the address bar or history.
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (err) { /* not fatal; the token is short-lived either way */ }

    if (p.error || p.error_code) {
      return { error: p.error_description || p.error || p.error_code };
    }
    if (p.access_token) {
      adoptReset({ access_token: p.access_token, expires_in: p.expires_in, user: { email: p.email } }, p.email);
      return { ok: true, fromLink: true };
    }
    return null;
  }

  async function refresh() {
    if (!session || !session.refreshToken) return false;
    try {
      const out = await http(authPath('/token?grant_type=refresh_token'), {
        method: 'POST', headers: headers(), body: JSON.stringify({ refresh_token: session.refreshToken })
      });
      adopt(out, session.email);
      return true;
    } catch (err) {
      // A rejected refresh means the password was changed or the account is gone.
      session = null;
      saveSession();
      return false;
    }
  }

  function ensureFreshToken() {
    if (!session || !session.accessToken) return Promise.reject(new Error('Not signed in'));
    if (session.expiresAt && Date.now() < session.expiresAt - (CFG.refreshMarginMs || 120000)) {
      return Promise.resolve(session.accessToken);
    }
    return refresh().then((ok) => {
      if (!ok) throw new Error('Session expired — sign in again');
      return session.accessToken;
    });
  }

  async function signOut() {
    try {
      await http(authPath('/logout'), { method: 'POST', headers: headers(), body: '{}' });
    } catch (err) { /* signing out locally matters more than telling the server */ }
    session = null;
    saveSession();
    book = emptyBook();
    saveBook();
    stop();
    setStatus({ signedIn: false, email: null, lastSyncAt: null, pending: 0, error: null });
  }

  /* ---------- status ---------- */
  let status = {
    signedIn: !!session,
    email: session ? session.email : null,
    online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
    syncing: false,
    lastSyncAt: null,
    pending: 0,
    error: null
  };
  const listeners = [];
  function onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); }; }
  function notify() { listeners.forEach((fn) => { try { fn(status); } catch (err) { /* a listener must not break sync */ } }); }
  function setStatus(patch) { Object.assign(status, patch); notify(); }

  /** How many changes are still queued. Used only for the status line, so it
   *  counts records and tombstones that are newer than the last push. */
  function countPending(state) {
    let n = 0;
    for (const t of ALL_TABLES) {
      const cursor = book.lastPushed[t];
      const stamp = (s) => (!cursor || Date.parse(s) > Date.parse(cursor));
      n += (state[t] || []).filter((r) => r && r.updatedAt && stamp(r.updatedAt)).length;
      n += (book.tombstones[t] || []).filter((x) => stamp(x.updatedAt)).length;
    }
    return n;
  }

  /* ---------- push ---------- */
  let pushTimer = null;
  let stateProvider = function () { return null; };

  /** Remember how to reach the live state, so the debounced push can use it
   *  later without every caller having to thread it through. */
  function setStateProvider(fn) { stateProvider = typeof fn === 'function' ? fn : function () { return null; }; }

  /* A device that only RECEIVES data still has to write it down. Without this,
     a fresh phone that synced once would show the right numbers, then lose them
     on reload, because nothing in the app had called save(). */
  let persist = function () {};
  function setPersist(fn) { persist = typeof fn === 'function' ? fn : function () {}; }

  /** Push every table. Takes the state explicitly when a caller already has
   *  it, and otherwise asks the provider. Without the parameter this silently
   *  pushed nothing whenever no provider had been registered. */
  async function pushAll(stateArg) {
    const state = stateArg || stateProvider();
    if (!session || !state) return [];
    // Each table is isolated. Previously a failure on `transactions` threw out
    // of the loop, so accounts/debts/custody/shopping/prefs were never pushed
    // again — one bad row wedged the whole pipeline permanently.
    const failures = [];
    for (const t of ALL_TABLES) {
      try {
        await pushOneTable(state, t);
      } catch (err) {
        failures.push(t + ': ' + (err && err.message ? err.message : 'failed'));
      }
    }
    try {
      await pushPrefs(state);
    } catch (err) {
      failures.push('prefs: ' + (err && err.message ? err.message : 'failed'));
    }
    if (failures.length) setStatus({ error: 'Sync problem — ' + failures[0] + (failures.length > 1 ? ' (+' + (failures.length - 1) + ' more)' : '') });
    return failures;
  }

  function queuePush() {
    if (!session) return;
    if (pushTimer) clearTimeout(pushTimer);
    // Without this catch, a rejected push became an unhandled rejection and
    // the error never reached the UI — the debounced path failed in silence.
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushAll().catch((err) => setStatus({ error: (err && err.message) || 'Sync failed' }));
    }, CFG.pushDebounceMs || 1500);
  }

  /* ---------- repairing a lost cloud copy ----------

     The push cursor lives in this browser, not on the server, and it records
     "everything up to T is already uploaded". That claim survives anything
     happening to the server: dropping the tables, restoring a backup, a bad
     migration, someone deleting rows in the dashboard. The records on this
     device are all older than T, so dirtyRecords() finds nothing to send and
     the app reports a cheerful "synced" while uploading nothing at all.

     Nothing about that is detectable from the app's side, so it is made into a
     button: count what the server actually holds, compare it with what is
     here, and where the server is short, forget the cursor and re-upload. The
     device holding the data wins, because it is the only copy that is
     demonstrably complete. */
  async function repairCloudCopy(state) {
    if (!session || !state) return { error: 'Sign in first' };
    const report = [];
    let reset = 0;
    let totalRows = 0;

    for (const table of ALL_TABLES) {
      const localCount = (state[table] || []).length;
      let remoteCount = null;
      try {
        await ensureFreshToken();
        const r = await httpWithHeaders(
          restPath(table) + '?select=id&limit=1',
          { headers: Object.assign({}, headers(), { Prefer: 'count=exact' }) });
        remoteCount = r.count;
      } catch (err) {
        report.push(table + ': could not be checked (' + (err.message || 'failed') + ')');
        continue;
      }
      if (remoteCount === null) { report.push(table + ': server did not report a count'); continue; }
      if (localCount > remoteCount) {
        // The server is missing rows this device has. Forget the claim and let
        // the next push send everything.
        book.lastPushed[table] = null;
        book.lastPulled[table] = null;
        reset++;
        report.push(table + ': ' + localCount + ' here, ' + remoteCount + ' there — re-uploading');
        totalRows += localCount;
      } else {
        report.push(table + ': ' + localCount + ' here, ' + remoteCount + ' there — in step');
      }
    }

    if (reset) {
      // A stale pull cursor is as dangerous as a stale push one: it would hide
      // rows the server does have. Clearing both, then pushing, is the only
      // state that cannot silently lose anything.
      saveBook();
      shadow = { transactions: [], accounts: [], debts: [], custody: [], shopping: [] };
      try { await pushAll(state); } catch (err) { /* reported by pushAll's own status */ }
    }

    return { ok: true, reset, report, totalRows };
  }

  function dirtyRecords(state, table) {
    const cursor = book.lastPushed[table];
    const list = state[table] || [];
    if (!cursor) return list.slice();
    const c = Date.parse(cursor);
    return list.filter((r) => r && r.updatedAt && Date.parse(r.updatedAt) > c);
  }

  /** Deduplicate rows by id, keeping the newest updatedAt. Prevents
   *  "ON CONFLICT DO UPDATE cannot affect row a second time" errors. */
  function dedupeById(rows) {
    const map = new Map();
    for (const r of rows) {
      const existing = map.get(r.id);
      if (!existing || Date.parse(r.updated_at) > Date.parse(existing.updated_at)) {
        map.set(r.id, r);
      }
    }
    return Array.from(map.values());
  }

  async function pushOneTable(state, table) {
    const dirty = dirtyRecords(state, table);
    const tombs = (book.tombstones[table] || []).filter((t) => {
      if (!book.lastPushed[table]) return true;
      return Date.parse(t.updatedAt) > Date.parse(book.lastPushed[table]);
    });

    if (!dirty.length && !tombs.length) return;

    const userId = session.userId;

    // Send regular rows and tombstones SEPARATELY — Supabase REST API
    // rejects mixed-shape rows with "All object keys must match".
    
    // First: push regular dirty rows (deduplicated)
    if (dirty.length) {
      const rows = dedupeById(dirty.map((r) => Object.assign({ user_id: userId, updated_at: r.updatedAt }, MAP[table].toRow(r))));
      
      await ensureFreshToken();
      await http(restPath(table), {
        method: 'POST',
        headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows)
      });

      let newest = book.lastPushed[table];
      for (const r of rows) {
        if (!newest || Date.parse(r.updated_at) > Date.parse(newest)) newest = r.updated_at;
      }
      book.lastPushed[table] = newest;
    }

    // Then: push tombstones separately (deduplicated)
    if (tombs.length) {
      // Get the full record data for each tombstone so we can send all required fields
      const tombRows = dedupeById(tombs.map((t) => {
        const record = (state[table] || []).find((r) => r.id === t.id);
        // Build row based on table schema — only include columns that exist
        const baseRow = {
          user_id: userId,
          updated_at: t.updatedAt,
          deleted: true,
          id: t.id
        };
        
        // Add table-specific fields based on actual schema
        if (table === 'transactions') {
          baseRow.type = record ? record.type : (t.type || 'expense');
          baseRow.amount = record ? record.amount : (t.amount || 0.01);
          baseRow.category = record ? record.category : '';
          baseRow.comment = record ? record.comment : '';
          baseRow.happened_at = record ? record.date : '';
          baseRow.account_id = record ? record.accountId : '';
          baseRow.to_account_id = record ? (record.toAccountId || '') : '';
        } else if (table === 'accounts') {
          baseRow.name = record ? record.name : '';
          baseRow.kind = record ? record.kind : 'ewallet';
          baseRow.opening_balance = record ? record.openingBalance : 0;
          baseRow.archived = record ? record.archived : false;
        } else if (table === 'debts') {
          baseRow.type = record ? record.type : 'receive';
          baseRow.person = record ? record.person : '';
          baseRow.amount = record ? record.amount : 0.01;
          baseRow.note = record ? record.note : '';
          baseRow.happened_at = record ? record.date : '';
          baseRow.settled = record ? record.settled : false;
          baseRow.settled_at = record ? (record.settledAt || '') : '';
          baseRow.ledger = record ? record.ledger : true;
        } else if (table === 'custody') {
          baseRow.person = record ? record.person : '';
          baseRow.direction = record ? record.direction : 'given';
          baseRow.amount = record ? record.amount : 0.01;
          baseRow.returned = record ? record.returned : 0;
          baseRow.note = record ? record.note : '';
          baseRow.happened_at = record ? record.date : '';
          baseRow.returned_at = record ? (record.returnedDate || '') : '';
        } else if (table === 'shopping') {
          baseRow.name = record ? record.name : '';
          baseRow.qty = record ? record.qty : '';
          baseRow.note = record ? record.note : '';
          baseRow.checked = record ? record.checked : false;
          baseRow.created_at = record ? record.createdAt : '';
          baseRow.checked_at = record ? (record.checkedAt || '') : '';
          baseRow.bought_tx_id = record ? (record.boughtTxId || '') : '';
          baseRow.cost = record ? record.cost : null;
        }
        
        return baseRow;
      }));

      await ensureFreshToken();
      await http(restPath(table), {
        method: 'POST',
        headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(tombRows)
      });

      let newest = book.lastPushed[table];
      for (const t of tombs) {
        if (!newest || Date.parse(t.updatedAt) > Date.parse(newest)) newest = t.updatedAt;
      }
      book.lastPushed[table] = newest;
      const keep = (book.tombstones[table] || []).filter((t) => Date.parse(t.updatedAt) > Date.parse(newest));
      book.tombstones[table] = keep;
    }

    saveBook();
  }

  async function pushPrefs(state) {
    if (!prefsChanged(state)) return;
    const userId = session.userId;
    await ensureFreshToken();
    const body = {
      user_id: userId,
      updated_at: touch(),
      budgets: state.budgets,
      categories: state.categories,
      settings: state.settings,
      closed_periods: state.closedPeriods
    };
    await http(restPath('prefs'), {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([body])
    });
    book.prefsPushedAt = body.updated_at;
    saveBook();
  }

  // The prefs row is one document, so "did it change" is answered by
  // comparing its serialised form with whatever we last sent. The first
  // call after a sign-in has nothing to compare against and always sends,
  // which is what makes a second device pick up the server's copy.
  let lastPrefsSent = null;
  function prefsSignature(state) {
    return JSON.stringify([state.budgets, state.categories, state.settings, state.closedPeriods]);
  }
  function prefsChanged(state) {
    if (lastPrefsSent === null) { lastPrefsSent = prefsSignature(state); return true; }
    const sig = prefsSignature(state);
    if (sig === lastPrefsSent) return false;
    lastPrefsSent = sig;
    return true;
  }

  /* ---------- pull ---------- */
  const PAGE = 500;
  /** Guard against a pathological loop; 40 pages is 20,000 rows. */
  const MAX_PAGES = 40;

  /* Pages until the server returns fewer rows than asked for. The previous
     version fetched one page of 1000 and then set the cursor to the last row it
     saw — so on a device with more than 1000 changes, everything past that
     point was skipped *forever*, silently. */
  async function pullOneTable(state, table) {
    const list = state[table] || (state[table] = []);
    let applied = 0;
    let cursor = book.lastPulled[table];

    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ select: '*', order: 'updated_at.asc' });
      if (cursor) q.set('updated_at', 'gt.' + cursor);
      q.set('limit', String(PAGE));

      await ensureFreshToken();
      const rows = await http(restPath(table) + '?' + q.toString(), { headers: headers() });
      if (!Array.isArray(rows) || !rows.length) break;

      let newest = cursor;
      let consumed = 0;

      for (const row of rows) {
        if (!row.updated_at) continue;
        if (!newest || Date.parse(row.updated_at) > Date.parse(newest)) newest = row.updated_at;
        consumed++;

        const idx = list.findIndex((r) => r.id === row.id);
        const localStamp = idx === -1 ? 0 : Date.parse(list[idx].updatedAt || 0) || 0;

        // Last-write-wins: only accept a strictly newer server version.
        if (idx !== -1 && localStamp >= Date.parse(row.updated_at)) continue;

        if (row.deleted) {
          // A tombstone older than the local copy must not wipe it: that means
          // the local edit came after the delete, so local is newer.
          if (idx !== -1 && localStamp < Date.parse(row.updated_at)) {
            list.splice(idx, 1);
            applied++;
          }
          continue;
        }
        const rec = MAP[table].fromRow(row);
        if (idx === -1) list.push(rec);
        else list[idx] = Object.assign({}, list[idx], rec);
        applied++;
      }

      if (!consumed) break;
      cursor = newest;
      book.lastPulled[table] = newest;
      absorbShadow(table, list);
      saveBook();

      // A short page means we have caught up.
      if (rows.length < PAGE) break;
    }

    state[table] = list;
    return applied;
  }

  async function pullPrefs(state) {
    await ensureFreshToken();
    const row = await http(restPath('prefs') + '?select=*&limit=1', { headers: headers() });
    if (!Array.isArray(row) || !row.length) return false;
    const p = row[0];
    if (!p.updated_at) return false;
    if (book.prefsPulledAt && Date.parse(p.updated_at) <= Date.parse(book.prefsPulledAt)) return false;
    // Whole-document last-write-wins, same rule as the record tables.
    if (book.prefsPushedAt && Date.parse(p.updated_at) <= Date.parse(book.prefsPushedAt)) {
      book.prefsPulledAt = p.updated_at;
      saveBook();
      return false;
    }
    state.budgets = p.budgets;
    state.categories = p.categories;
    state.settings = p.settings;
    state.closedPeriods = p.closed_periods;
    book.prefsPulledAt = p.updated_at;
    book.prefsPushedAt = p.updated_at;
    lastPrefsSent = prefsSignature(state);
    saveBook();
    return true;
  }

  /* ---------- the loop ---------- */
  let timer = null;
  let running = false;

  async function cycle(stateArg, opts) {
    if (!session || running) return;
    // Default to the live state the app registered. Passing a copy in would
    // pull into an object nobody reads, and the result would be thrown away.
    const state = stateArg || stateProvider();
    if (!state) return;
    running = true;
    setStatus({ syncing: true, error: null });
    try {
      // Stamp anything edited since the last look before touching the
      // network, so a local change is never missed by this cycle.
      reconcile(state);

      // Pull first, so a local edit made against a stale view is not
      // overwritten by a version it never saw. Each table isolated for the
      // same reason as the push side.
      let changed = 0;
      const pullFailures = [];
      for (const t of ALL_TABLES) {
        try {
          changed += await pullOneTable(state, t);
        } catch (err) {
          // Keep the real reason, not just the table name: "network down" and
          // "permission denied for table X" call for completely different
          // responses from the user.
          pullFailures.push(t + ': ' + ((err && err.message) || 'failed'));
        }
      }
      try {
        if (await pullPrefs(state)) changed++;
      } catch (err) { pullFailures.push('prefs: ' + ((err && err.message) || 'failed')); }

      // Write the incoming rows down before pushing anything, so a reload
      // cannot lose what was just received.
      if (changed) persist();

      const pushFailures = await pushAll(state);

      setStatus({
        lastSyncAt: Date.now(),
        pending: countPending(state),
        error: pushFailures.length
          ? 'Sync problem on ' + pushFailures.length + ' table(s) — ' + pushFailures[0]
          : (pullFailures.length ? 'Could not fetch updates — ' + pullFailures[0] : null)
      });
      if (changed && !(opts && opts.silent)) if (window.CashFlowSyncNotify) window.CashFlowSyncNotify(changed);
    } catch (err) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      setStatus({
        error: offline ? 'Offline — changes are saved here and will sync when you reconnect'
          : (err && err.message) || 'Sync failed'
      });
    } finally {
      running = false;
      setStatus({ syncing: false });
    }
  }

  function start(provider) {
    stop();
    if (!session) return;
    setStateProvider(provider);
    timer = setInterval(() => cycle(provider()), CFG.pollIntervalMs || 60000);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) cycle(stateProvider());
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { setStatus({ online: true, error: null }); cycle(stateProvider()); });
      window.addEventListener('offline', () => setStatus({ online: false }));
    }
    cycle(stateProvider());
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    // auth
    signUp, signIn, signOut, MIN_PASSWORD, validateCredentials,
    requestPasswordReset, verifyResetCode, setNewPassword, pickRecoveryFromUrl,
    /* Exported so the tests can exercise it directly. It is a pure function
       that reads a claim out of a token, and the property that matters — that
       a forged claim changes nothing except a prefilled field — is worth
       asserting against the real implementation rather than a stand-in. */
    decodeJwtEmail,
    get isSignedIn() { return !!session; },
    get email() { return session ? session.email : null; },
    get resetEmail() { const r = loadReset(); return r ? r.email : null; },
    get hasResetToken() { return !!loadReset(); },
    // sync
    start, stop, cycle, queuePush, setStateProvider, setPersist, pushAll, touch, seedClock, reconcile, absorbShadow, repairCloudCopy,
    // bookkeeping used by the app
    markDeleted: function (table, id) {
      if (!book.tombstones[table]) book.tombstones[table] = [];
      const list = book.tombstones[table];
      // reconcile() also sees the record vanish and would queue the same id.
      // One entry per id: duplicates are waste, and an unbounded list can hit
      // the storage quota and be dropped silently.
      if (list.some((t) => t.id === id)) { markedSinceLastReconcile++; return; }
      list.push({ id, updatedAt: touch() });
      markedSinceLastReconcile++;
      saveBook();
    },
    // prefs bookkeeping
    notePrefsSent: function (state) { lastPrefsSent = prefsSignature(state); },
    // ui
    status, onChange,
    setError: function (m) { setStatus({ error: m }); }
  };
})();
