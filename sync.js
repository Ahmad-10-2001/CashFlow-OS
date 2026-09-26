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
        book.tombstones[t].push({ id: p.id, updatedAt: touch() });
        changed = true;
      }

      shadow[t] = list.map(clone);
    }
    if (changed) saveBook();
    return changed;
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

  /* ---------- auth: email + PIN ----------
     The PIN is used as the password. Supabase stores only a hash, and
     the traffic is TLS, so the plain PIN is never written down
     anywhere we control. 8 characters is enforced by the UI because a
     short PIN is guessable — rate limiting helps, but it is not a
     substitute for length. */
  const MIN_PIN = 8;

  function validateCredentials(email, pin) {
    const e = String(email || '').trim();
    if (!e || e.indexOf('@') === -1 || e.indexOf('.') === -1) return 'Enter a valid email address';
    if (String(pin || '').length < MIN_PIN) return 'Your PIN must be at least ' + MIN_PIN + ' characters';
    return null;
  }

  async function signUp(email, pin) {
    const bad = validateCredentials(email, pin);
    if (bad) return { error: bad };
    try {
      const out = await http(authPath('/signup'), {
        method: 'POST', headers: headers(), body: JSON.stringify({ email: email.trim(), password: pin })
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

  async function signIn(email, pin) {
    const bad = validateCredentials(email, pin);
    if (bad) return { error: bad };
    try {
      const out = await http(authPath('/token?grant_type=password'), {
        method: 'POST', headers: headers(), body: JSON.stringify({ email: email.trim(), password: pin })
      });
      adopt(out, email);
      return { ok: true };
    } catch (err) {
      if (/Invalid login credentials/i.test(err.message || '')) return { error: 'Wrong email or PIN' };
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

  async function refresh() {
    if (!session || !session.refreshToken) return false;
    try {
      const out = await http(authPath('/token?grant_type=refresh_token'), {
        method: 'POST', headers: headers(), body: JSON.stringify({ refresh_token: session.refreshToken })
      });
      adopt(out, session.email);
      return true;
    } catch (err) {
      // A rejected refresh means the PIN was changed or the account is gone.
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

  async function pushAll() {
    const state = stateProvider();
    if (!session || !state) return;
    for (const t of ALL_TABLES) await pushOneTable(state, t);
    await pushPrefs(state);
  }

  function queuePush() {
    if (!session) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; pushAll(); }, CFG.pushDebounceMs || 1500);
  }

  function dirtyRecords(state, table) {
    const cursor = book.lastPushed[table];
    const list = state[table] || [];
    if (!cursor) return list.slice();
    const c = Date.parse(cursor);
    return list.filter((r) => r && r.updatedAt && Date.parse(r.updatedAt) > c);
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
    
    // First: push regular dirty rows
    if (dirty.length) {
      const rows = dirty.map((r) => Object.assign({ user_id: userId, updated_at: r.updatedAt }, MAP[table].toRow(r)));
      
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

    // Then: push tombstones separately
    if (tombs.length) {
      // Get the full record data for each tombstone so we can send all required fields
      const tombRows = tombs.map((t) => {
        const record = (state[table] || []).find((r) => r.id === t.id);
        const baseRow = {
          user_id: userId,
          updated_at: t.updatedAt,
          deleted: true,
          id: t.id,
          // Include all NOT NULL fields from the record (or defaults)
          type: record ? record.type : (t.type || 'expense'),
          amount: record ? record.amount : (t.amount || 0.01),
          category: record ? record.category : '',
          comment: record ? record.comment : '',
          happened_at: record ? record.date : '',
          account_id: record ? record.accountId : ''
        };
        // Add to_account_id for transactions (transfer records)
        if (table === 'transactions') {
          baseRow.to_account_id = record ? (record.toAccountId || '') : '';
        }
        return baseRow;
      });

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
  async function pullOneTable(state, table) {
    const cursor = book.lastPulled[table];
    const q = new URLSearchParams({ select: '*', order: 'updated_at.asc' });
    if (cursor) q.set('updated_at', 'gt.' + cursor);
    q.set('limit', '1000');

    await ensureFreshToken();
    const rows = await http(restPath(table) + '?' + q.toString(), { headers: headers() });
    if (!Array.isArray(rows) || !rows.length) return 0;

    const list = state[table] || [];
    let applied = 0;
    let newest = cursor;

    for (const row of rows) {
      if (!row.updated_at) continue;
      if (!newest || Date.parse(row.updated_at) > Date.parse(newest)) newest = row.updated_at;
      const idx = list.findIndex((r) => r.id === row.id);
      const localStamp = idx === -1 ? 0 : Date.parse(list[idx].updatedAt || 0) || 0;

      // Last-write-wins: only accept a strictly newer server version.
      if (idx !== -1 && localStamp >= Date.parse(row.updated_at)) continue;

      if (row.deleted) {
        // CRITICAL FIX: Only apply tombstone if the local record is OLDER.
        // If local record has a newer timestamp, it means the user edited
        // it AFTER the delete — don't let the stale delete come back.
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
    state[table] = list;
    absorbShadow(table, list);
    book.lastPulled[table] = newest;
    saveBook();
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
      // overwritten by a version it never saw.
      let changed = 0;
      for (const t of ALL_TABLES) changed += await pullOneTable(state, t);
      if (await pullPrefs(state)) changed++;

      // Write the incoming rows down before pushing anything, so a reload
      // cannot lose what was just received.
      if (changed) persist();

      for (const t of ALL_TABLES) await pushOneTable(state, t);
      await pushPrefs(state);

      setStatus({
        lastSyncAt: Date.now(),
        pending: countPending(state),
        error: null
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
    signUp, signIn, signOut, MIN_PIN, validateCredentials,
    get isSignedIn() { return !!session; },
    get email() { return session ? session.email : null; },
    // sync
    start, stop, cycle, queuePush, setStateProvider, setPersist, pushAll, touch, seedClock, reconcile, absorbShadow,
    // bookkeeping used by the app
    markDeleted: function (table, id) {
      if (!book.tombstones[table]) book.tombstones[table] = [];
      book.tombstones[table].push({ id, updatedAt: touch() });
      saveBook();
    },
    // prefs bookkeeping
    notePrefsSent: function (state) { lastPrefsSent = prefsSignature(state); },
    // ui
    status, onChange,
    setError: function (m) { setStatus({ error: m }); }
  };
})();
