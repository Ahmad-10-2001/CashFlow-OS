/* ============================================================
   CashFlow OS — application script
   ------------------------------------------------------------
   Design notes
   • All persistent state lives in ONE namespaced, versioned
     localStorage key. A single key means a write can never be
     observed half-finished the way four separate keys can.
   • The key itself is still 'salaryManager:state' from when the app
     was called Salary Manager. Renaming it would orphan every
     existing user's records, so it is deliberately left alone —
     nothing user-facing depends on it.
   • Every value that comes from disk or from a user file goes
     through sanitizeState() before it is trusted.
   • The UI is built with real DOM nodes (h() / hs() for SVG) and
     delegated events (data-act). There is no innerHTML and no
     inline onclick, so user-supplied strings can never become
     markup or code.
   • Dates are stored as LOCAL wall-clock stamps "YYYY-MM-DDTHH:mm"
     (no Z). Older files held UTC ISO strings; sanitizeState reads
     both and rewrites them as local stamps, so a record keeps the
     exact instant it was entered at.
   ============================================================ */

   'use strict';

   /* ---------- constants ---------- */
   
   const STORAGE_KEY = 'salaryManager:state';
   const SCHEMA_VERSION = 4;
   const LEGACY_KEYS = ['transactions', 'debts', 'budgets', 'categories'];
   
   /* Display name. The app was renamed from Salary Manager to CashFlow OS;
      backups written under the old name are still accepted on import. */
   const APP_NAME = 'CashFlow OS';
   const APP_IDS = ['cashflow-os', 'salary-manager'];
   const CURRENCY = '₨';
   const MAX_AMOUNT = 1e12;
   const NAME_LIMIT = 40;
   const COMMENT_LIMIT = 300;
   const ITEM_LIMIT = 80;
   const NOTE_TITLE_LIMIT = 80;
   const NOTE_BODY_LIMIT = 1000;
   const TIMER_LABEL_LIMIT = 60;
   /* How many bank+word -> category memories are kept. Each is a few dozen
      bytes; this caps the whole map at a few KB so it can never bloat the
      synced settings document. Oldest goes first when full. */
   const CAT_MEMORY_LIMIT = 100;
   const QTY_LIMIT = 24;
   const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
   const STAMP_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
   
   const DEFAULT_CATEGORIES = ['Salary', 'Food', 'Bike/Fuel', 'Groceries', 'Bills', 'Shopping', 'Health', 'Travel', 'Family', 'Udhaar', 'Other'];
   const DEFAULT_BUDGETS = { Food: 10000, 'Bike/Fuel': 10000, Groceries: 8000, Bills: 5000 };
   
   /* Seeded accounts. These are only a starting point — every account can be
      renamed, added, archived or deleted from the Accounts tab, so nothing about
      the app is hard-wired to this list. The ids are fixed on purpose: a v3 file
      is migrated by pointing its transactions at CASH_ACCOUNT_ID, and a stable id
      means that mapping survives a re-import.
      The price of fixed ids is paid on sync: every fresh install carries the same
      three, and the push upserts on the primary key — so the second account to
      sync hits the first one's rows and Postgres refuses with an RLS violation.
      That is expected, not corrupt data: remapCollidingAccountIds() gives this
      device fresh ids and the retry uploads them as new rows. */
   const CASH_ACCOUNT_ID = 'acc-cash';
   const DEFAULT_ACCOUNTS = [
     { id: CASH_ACCOUNT_ID, name: 'Cash',     kind: 'cash',   openingBalance: 0, archived: false },
     { id: 'acc-nayapay',   name: 'NayaPay',  kind: 'ewallet', openingBalance: 0, archived: false },
     { id: 'acc-easypaisa', name: 'Easypaisa', kind: 'ewallet', openingBalance: 0, archived: false }
   ];
   const ACCOUNT_KINDS = ['cash', 'bank', 'ewallet'];
   
   /* Colour per account kind, so the balance boxes stay recognisable at a glance.
      Both tints are paired with an ink colour that clears 4.5:1 on them. */
   const ACCOUNT_TINT = {
     cash:   { bg: '#e8f1fd', ink: '#0a3d80' },
     bank:   { bg: '#eae6fd', ink: '#4a2a8f' },
     ewallet:{ bg: '#fdf0e3', ink: '#8a4a00' }
   };
   const ACCOUNT_TINT_FALLBACK = { bg: '#f0f0f0', ink: '#4a4a52' };
   
   /* Tab order is the menu order, and the app-tabs meta tag must list the same ids
      in the same order — that pair is the contract the stale-asset guard reads.
      The email setup lives inside Pending, so it has no tab of its own: a
      one-time setup screen kept its own tab read as daily routine instead of
      finished business. */
   const TABS = [
     { id: 'home',         label: 'Home',       glyph: '◈' },
     { id: 'transactions', label: 'Records',    glyph: '≡' },
     { id: 'budget',       label: 'Budget',     glyph: '◎' },
     { id: 'udhaar',       label: 'Udhaar',     glyph: '⇄' },
     { id: 'notes',        label: 'Notes',      glyph: '✎' },
     { id: 'list',         label: 'List',       glyph: '☑' },
     { id: 'reports',      label: 'Reports',    glyph: '◔' },
     { id: 'categories',   label: 'Categories', glyph: '❑' },
     { id: 'pending',      label: 'Pending',    glyph: '🔔' },
     { id: 'accounts',     label: 'Accounts',   glyph: '▣' },
     { id: 'settings',     label: 'Settings',   glyph: '⚙' }
   ];
   
   /* Categorical palette. Chosen to stay distinguishable on white and to hold
      at least 3:1 against it so a chart segment is never the only cue. */
   const CHART_COLORS = [
     '#0a58ca', '#c0271d', '#127531', '#8a5200', '#6b21a8',
     '#0e7490', '#be185d', '#4d7c0f', '#9a3412', '#4338ca'
   ];
   
   const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
   
   /* ---------- state ---------- */
   
   /** @type {{version:number, transactions:Array, debts:Array, budgets:Object,
    *           categories:string[], shopping:Array, accounts:Array,
    *           settings:Object, closedPeriods:string[]}} */
   let state = blankState();
   let storageUsable = true;
   let activeTab = 'home';
   let reportRange = { mode: 'month' };
   let budgetPeriod = null;   // null = follow the current calendar month
   /* Viewing months for the ledger tabs. Session-only like budgetPeriod, and for
      the same reason: a new month must read fresh on every load, so these are
      never persisted — null always means "this calendar month". Records and
      Accounts each keep their own, so looking back in one tab never moves the
      other. Home always shows the current month; it has no picker to go stale. */
   let viewTxPeriod = null;
   let viewAcctPeriod = null;
   /* Records account filter. Session-only like the month pickers: '' means every
      account ("All transactions"), anything else is an account id. Never
      persisted, so a new load always starts unfiltered. */
   let viewTxAccount = '';
   /* Undo: the last few edits of this session, as whole-state snapshots.
      Session-only on purpose — it backs out mistakes, it does not time-travel
      across reloads. A restore goes through sanitizeState so the snapshot
      lands back as valid app state, budget prototypes and all. */
   let undoStack = [];
   function pushUndo(label) {
     try {
       undoStack.unshift({ snapshot: JSON.stringify(state), label: typeof label === 'string' ? label : '' });
       if (undoStack.length > 10) undoStack.length = 10;
     } catch (err) { /* storage blocked — undo simply does nothing */ }
   }
   /** Plain-language lines for what restoring a snapshot would change: rows
      that vanish, come back, or are lifted back to an older copy. Pure —
      the modal reads it before anything is touched, cancelling is free. */
   function undoDetailLines(prev, cur) {
     const lines = [];
     const byId = (rows) => {
       const m = new Map();
       (rows || []).forEach((r) => { if (r && r.id) m.set(r.id, r); });
       return m;
     };
     const diffRows = (prevRows, curRows, one, many) => {
       const pm = byId(prevRows);
       const cm = byId(curRows);
       let added = 0;
       let removed = 0;
       let edited = 0;
       pm.forEach((row, id) => {
         if (!cm.has(id)) removed++;
         else if (JSON.stringify(row) !== JSON.stringify(cm.get(id))) edited++;
       });
       cm.forEach((row, id) => { if (!pm.has(id)) added++; });
       if (removed) lines.push(removed + ' ' + (removed === 1 ? one : many) + ' taken back');
       if (added) lines.push(added + ' ' + (added === 1 ? one : many) + ' removed');
       if (edited) lines.push(edited + ' ' + (edited === 1 ? one : many) + ' changed back');
     };
     diffRows(prev.transactions, cur.transactions, 'transaction', 'transactions');
     diffRows(prev.debts, cur.debts, 'udhaar entry', 'udhaar entries');
     diffRows((prev.settings || {}).notes, (cur.settings || {}).notes, 'note', 'notes');
     diffRows((prev.settings || {}).timers, (cur.settings || {}).timers, 'timer', 'timers');
     diffRows((prev.settings || {}).recurring, (cur.settings || {}).recurring, 'recurring plan', 'recurring plans');
     diffRows((prev.settings || {}).goals, (cur.settings || {}).goals, 'goal', 'goals');
     diffRows((prev.settings || {}).templates, (cur.settings || {}).templates, 'template', 'templates');
     diffRows((prev.settings || {}).challenges, (cur.settings || {}).challenges, 'challenge', 'challenges');
     diffRows(prev.shopping, cur.shopping, 'shopping item', 'shopping items');
     const pb = prev.budgets || {};
     const cb = cur.budgets || {};
     let budgets = 0;
     let first = '';
     Array.from(new Set(Object.keys(pb).concat(Object.keys(cb)))).forEach((p) => {
       const A = pb[p] || {};
       const B = cb[p] || {};
       Object.keys(Object.assign({}, A, B)).forEach((cat) => {
         if (A[cat] === B[cat]) return;
         budgets++;
         if (!first) first = cat + ' in ' + periodLabel(p) + ': ' + formatMoney(B[cat] || 0) + ' -> ' + formatMoney(A[cat] || 0);
       });
     });
     if (budgets) lines.push(budgets + ' budget limit' + (budgets === 1 ? '' : 's') + ' set back' + (first ? ' — ' + first : ''));
     if ((prev.categories || []).join('|') !== (cur.categories || []).join('|')) lines.push('the category list set back');
     if (lines.length > 6) lines.splice(5, lines.length, '(+' + (lines.length - 5) + ' more changes)');
     return lines;
   }

   /* Undo asks first: a modal shows what is being backed out and exactly what
      changes that takes back, so Undo is never a silent risk. */
   async function undoLast() {
     if (!undoStack.length) { toast('Nothing to undo'); return; }
     const entry = undoStack[0];
     let snap = null;
     try { snap = JSON.parse(entry.snapshot); } catch (err) { snap = null; }
     if (!snap) { undoStack.shift(); toast('Could not undo'); return; }
     const lines = undoDetailLines(snap, state);
     const what = (entry.label ? 'Last change: ' + entry.label + '.\n' : '') +
       (lines.length
         ? 'Undoing it would:\n' + lines.map((l) => '- ' + l).join('\n')
         : 'This takes the whole app state back to how it was just before that change.');
     const answer = await askChoice('Undo', what, [
       { value: 'undo', kind: 'primary', label: 'Undo it' },
       { value: 'keep', kind: 'cancel', label: 'Keep it' }
     ]);
     if (answer !== 'undo') return;
     const done = undoStack.shift();
     if (!done || done.snapshot !== entry.snapshot) {
       // The queue moved while the modal was open — refuse rather than undo
       // the wrong step, and put the entry back so a retry still works.
       if (done) undoStack.unshift(done);
       toast('The undo queue moved — try again');
       return;
     }
     try {
       state = sanitizeState(snap).state;
     } catch (err) {
       undoStack.unshift(done);
       toast('Could not undo');
       return;
     }
     save();
     renderAll();
     toast('Undone');
   }
   /* Records category filter. Same contract: '' means every category ("All
      categories"). Transfers carry no category, so an active filter hides them —
      they belong to no bucket, which is exactly what the filter asks for. */
   let viewTxCategory = '';
   /** True when a wall-clock stamp falls inside a YYYY-MM month. */
   function inPeriod(dateStr, period) {
     const d = new Date(dateStr);
     if (Number.isNaN(d.getTime())) return false;
     const b = periodBoundsOf(period);
     return d >= b.start && d <= b.end;
   }
   function changeTxPeriod(period) {
     viewTxPeriod = PERIOD_RE.test(String(period)) ? period : null;
     renderAll();
   }
   function changeAcctPeriod(period) {
     viewAcctPeriod = PERIOD_RE.test(String(period)) ? period : null;
     renderAll();
   }
   /** The account the Records list is filtered to: '' (all), or the id when it
    *  still exists — a deleted account falls back to all instead of a blank
    *  list under a stale selection. */
   function activeTxAccount() {
     return (typeof viewTxAccount === 'string' && viewTxAccount && findAccount(viewTxAccount)) ? viewTxAccount : '';
   }
   function changeTxAccount(id) {
     viewTxAccount = (typeof id === 'string' && id && findAccount(id)) ? id : '';
     renderAll();
   }
   /** The category the Records list is filtered to: '' (all), or the name while
    *  it still exists — a deleted category falls back to all instead of a blank
    *  list under a stale selection. */
   function activeTxCategory() {
     return (typeof viewTxCategory === 'string' && viewTxCategory && findCategory(viewTxCategory)) ? findCategory(viewTxCategory) : '';
   }
   function changeTxCategory(name) {
     viewTxCategory = (typeof name === 'string' && name && findCategory(name)) ? findCategory(name) : '';
     renderAll();
   }
   /** Empty the search field by tap, so nobody has to backspace it out. Focus
    *  returns to the field because clearing is always followed by typing anew —
    *  this focus is invited by the tap, never a surprise after saving. */
   function clearTxSearch() {
     const input = $('txSearch');
     if (!input) return;
     input.value = '';
     renderTransactions();
     try { input.focus(); } catch (err) { /* headless: nothing to focus */ }
   }
   /** The month a ledger view actually shows: the chosen one, unless it no longer
    *  exists (everything in it was deleted), in which case this month. Without
    *  this the picker and the list can disagree — the select falls back to the
    *  newest option while the list filters by a month with nothing in it. */
   function validViewPeriod(v) {
     const p = PERIOD_RE.test(String(v)) ? v : currentPeriod();
     return knownPeriods().indexOf(p) !== -1 ? p : currentPeriod();
   }
   // The last result of "check and re-upload", kept so it survives a re-render of
   // the sync panel (which happens on every save()).
   let repairReport = null;
   
   /* ============================================================
      Small utilities
      ============================================================ */
   
   const $ = (id) => document.getElementById(id);
   
   function isObject(v) {
     return typeof v === 'object' && v !== null && !Array.isArray(v);
   }
   
   function round2(n) {
     return Math.round(n * 100) / 100;
   }
   
   function newId() {
     // crypto.randomUUID needs a secure context; fall back for http:// testing.
     if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
     return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
   }
   
   /** Format an amount. Keeps the sign — a negative balance must never read as positive. */
   function formatMoney(n, opts) {
     const o = opts || {};
     const v = round2(Number(n) || 0);
     const body = Math.abs(v).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
     const sign = v < 0 ? '-' : (o.signed && v > 0 ? '+' : '');
     return sign + CURRENCY + ' ' + body;
   }
   
   function formatDayOnly(d) {
     const p = (x) => String(x).padStart(2, '0');
     return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
   }
   
   function formatDate(iso) {
     const d = iso ? new Date(iso) : null;
     if (!d || Number.isNaN(d.getTime())) return 'Unknown date';
     const p = (x) => String(x).padStart(2, '0');
     return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ', ' + p(d.getHours()) + ':' + p(d.getMinutes());
   }
   
   function parseDate(v) {
     if (typeof v !== 'string' && typeof v !== 'number') return null;
     const d = new Date(v);
     return Number.isNaN(d.getTime()) ? null : d;
   }
   
   /** Amount fields take plain numbers — and, as a convenience, simple sums
    *  like "120+80", which are worked out here. Deliberately narrow: a safe
    *  expression is digits, spaces, dots, round brackets and the four
    *  operators — nothing else ever reaches the evaluator, so crafted input
    *  has nothing to execute. A plain number, the usual case, skips the
    *  evaluator entirely and keeps the old exact behaviour. */
   function evalAmountExpr(v) {
     const s = String(v == null ? '' : v).trim().replace(/,/g, '');
     if (s === '') return NaN;
     if (!/^[0-9.+\-*/ ()]+$/.test(s)) return NaN;
     if (!/[+\-*/]/.test(s)) return Number(s);
     try {
       const result = Function('"use strict"; return (' + s + ')')();
       return typeof result === 'number' && Number.isFinite(result) ? result : NaN;
     } catch (err) {
       return NaN;
     }
   }

   /** Coerce anything into a usable positive amount, or null. Rejects NaN/Infinity/0/negatives. */
   function toPositiveNumber(v) {
     let n;
     if (typeof v === 'number') n = v;
     else if (typeof v === 'string' && v.trim() !== '') n = evalAmountExpr(v);
     else return null;
     if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
     return round2(n);
   }
   
   function cleanText(v, limit, keepBreaks) {
     if (typeof v !== 'string') return '';
     // Strip control characters that would corrupt display — but keep line
     // breaks when asked (multi-line fields like note bodies), so a note typed
     // on three lines is still three lines after saving.
     const cleaned = keepBreaks
       ? v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
       : v.replace(/[\u0000-\u001f\u007f]/g, ' ');
     return cleaned.trim().slice(0, limit);
   }
   
   /** Coerce anything into a finite number inside a range. Used where 0 and
    *  negatives are legitimate (an account's opening balance), unlike
    *  toPositiveNumber which deliberately rejects them. */
   function clampNumber(v, lo, hi) {
     let n;
     if (typeof v === 'number') n = v;
     else if (typeof v === 'string' && v.trim() !== '') n = Number(v.replace(/,/g, '').trim());
     else return 0;
     if (!Number.isFinite(n)) return 0;
     if (n < lo) return lo;
     if (n > hi) return hi;
     return n;
   }
   
   /* ============================================================
      Dates and months
      ============================================================ */
   
   function pad2(n) { return String(n).padStart(2, '0'); }
   
   /** Local wall-clock stamp, e.g. "2026-09-26T14:35". Deliberately has no timezone
    *  suffix: these strings are read back with `new Date()` which treats a bare
    *  "YYYY-MM-DDTHH:mm" as local, so a record filed at 23:50 stays on that day. */
   function toLocalStamp(d) {
     return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
       'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
   }
   
   function nowStamp() { return toLocalStamp(new Date()); }
   
   function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
   
   function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
   
   /** Whole days between two dates, DST-safe (rounding absorbs the 23/25-hour days). */
   function dayDiff(from, to) { return Math.round((startOfDay(to) - startOfDay(from)) / 86400000); }
   
   function currentPeriod() {
     const n = new Date();
     return n.getFullYear() + '-' + pad2(n.getMonth() + 1);
   }
   
   function periodLabel(period) {
     const parts = String(period).split('-');
     const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
     if (Number.isNaN(d.getTime())) return period;
     return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
   }
   
   function periodBoundsOf(period) {
     const parts = String(period).split('-');
     const y = Number(parts[0]);
     const m = Number(parts[1]);
     return {
       start: new Date(y, m - 1, 1, 0, 0, 0, 0),
       end: new Date(y, m, 0, 23, 59, 59, 999)
     };
   }
   
   function previousPeriod(period) {
     const parts = String(period).split('-');
     const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
     d.setMonth(d.getMonth() - 1);
     return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
   }
   
   /** Value for an <input type="datetime-local">. */
   function stampToInput(stamp) {
     const d = parseDate(stamp);
     return toLocalStamp(d || new Date());
   }
   
   /** Read a datetime-local value back into a local stamp. Anything unusable
    *  falls back to "now" rather than silently discarding the entry. */
   function inputToStamp(value) {
     if (typeof value !== 'string') return nowStamp();
     const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value.trim());
     if (!m) return nowStamp();
     const d = new Date(Number(m[1].slice(0, 4)), Number(m[1].slice(5, 7)) - 1, Number(m[1].slice(8, 10)), Number(m[2].slice(0, 2)), Number(m[2].slice(3, 5)), 0, 0);
     if (Number.isNaN(d.getTime())) return nowStamp();
     return toLocalStamp(d);
   }
   
   function localDateStamp() {
     return currentPeriod() + '-' + pad2(new Date().getDate());
   }
   
   function endOfToday() {
     const n = new Date();
     return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59, 999);
   }
   
   /* ============================================================
      DOM construction — no innerHTML anywhere in this app
      ============================================================ */
   
   function h(tag, props, ...children) {
     const node = document.createElement(tag);
     const p = props || {};
     for (const key of Object.keys(p)) {
       const val = p[key];
       if (val === null || val === undefined || val === false) continue;
       if (key === 'class') node.className = val;
       else if (key === 'text') node.textContent = val;
       else if (key === 'dataset') {
         // Skipped rather than coerced: the dataset IDL setter turns `undefined`
         // into the STRING "undefined", so a button built without an `arg` would
         // hand a handler the literal text "undefined" — which is a valid-looking
         // argument and fails much later than the mistake.
         for (const dk of Object.keys(val)) {
           const dv = val[dk];
           if (dv === null || dv === undefined || dv === false) continue;
           node.dataset[dk] = dv;
         }
       }
       else if (key === 'style') node.style.cssText = val;
       else if (key.slice(0, 2) === 'on' && typeof val === 'function') node.addEventListener(key.slice(2), val);
       else if (val === true) node.setAttribute(key, '');
       else node.setAttribute(key, val);
     }
     appendAll(node, children);
     return node;
   }
   
   /** Same builder, but in the SVG namespace. */
   function hs(tag, props, ...children) {
     const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
     const p = props || {};
     for (const key of Object.keys(p)) {
       const val = p[key];
       if (val === null || val === undefined || val === false) continue;
       if (key === 'text') node.textContent = val;
       else if (key.slice(0, 2) === 'on' && typeof val === 'function') node.addEventListener(key.slice(2), val);
       else node.setAttribute(key, val === true ? '' : String(val));
     }
     appendAll(node, children);
     return node;
   }
   
   function appendAll(node, children) {
     for (const kid of children.flat(4)) {
       if (kid === null || kid === undefined || kid === false || kid === '') continue;
       if (Array.isArray(kid)) { appendAll(node, kid); continue; }
       node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
     }
   }
   
   function mount(node, ...children) {
     if (!node) return;
     node.replaceChildren();
     appendAll(node, children);
   }
   
   function button(label, act, opts) {
     const o = opts || {};
     return h('button', {
       type: 'button',
       class: o.class || 'btn-mini',
       dataset: { act, id: o.id, arg: o.arg }
     }, label);
   }
   
   function iconButton(glyph, act, opts) {
     const o = opts || {};
     return h('button', {
       type: 'button',
       class: o.class || 'btn-icon',
       title: o.title || '',
       'aria-label': o.title || glyph,
       dataset: { act, id: o.id, arg: o.arg }
     }, glyph);
   }
   
   /* ============================================================
      Validation / repair
      ============================================================ */
   
   function defaultPeriodBudgets() {
     const o = Object.create(null);
     for (const k of Object.keys(DEFAULT_BUDGETS)) o[k] = DEFAULT_BUDGETS[k];
     return o;
   }
   
   function blankAccounts() {
     return DEFAULT_ACCOUNTS.map((a) => ({ ...a }));
   }
   
   function blankState() {
     const budgets = Object.create(null);
     budgets[currentPeriod()] = defaultPeriodBudgets();
     return {
       version: SCHEMA_VERSION,
       transactions: [],
       debts: [],
       budgets,
       categories: [...DEFAULT_CATEGORIES],
       shopping: [],
       // Money the user holds for someone else. Deliberately NOT part of the
       // balance: it is tracked apart so it can never inflate the total.
       // The Amanat UI was removed (no longer needed), but the data stays right
       // here so old backups and the other device lose nothing.
       custody: [],
       accounts: blankAccounts(),
       // notes live inside settings — not in their own table — so they ride the
       // already-synced prefs document to the other device with no new server
       // table, no migration and no RLS to configure. Whole-document
       // last-write-wins applies, same as budgets: fine at family scale.
       // shoppingPeriod remembers which month the list was last prepared for.
       // The feature lists below (recurring plans, goals, quick-add templates,
       // challenges) ride the same synced prefs document the notes and timers
       // already use — no new server table, no migration. budgetRollover +
       // budgetRolloverPeriod make the rollover fire once per new month.
       settings: { budgetOffset: Object.create(null), lastAccountId: CASH_ACCOUNT_ID, shoppingPeriod: null, budgetRollover: false, budgetRolloverPeriod: null, notes: [], timers: [], catMemory: Object.create(null), budgetMoves: [], recurring: [], goals: [], templates: [], challenges: [] },
       closedPeriods: []
     };
   }
   
   function isClosed(period) { return state.closedPeriods.indexOf(period) !== -1; }
   
   /** Preserve a record's sync timestamp when it is read back from disk.
    *  Dropping it here is not cosmetic: reconcile() stamps anything it cannot
    *  match against its shadow, so an unstamped record looks freshly edited on
    *  every single page load and silently overwrites other devices' versions.
    *  Returns null for an unreadable stamp so reconcile() treats it as new. */
   function keepStamp(v) {
     if (typeof v !== 'string' || !v) return null;
     const t = Date.parse(v);
     return Number.isFinite(t) ? new Date(t).toISOString() : null;
   }
   
   /**
    * Turn an arbitrary parsed object into valid app state.
    * Collects human-readable notes about everything it had to repair.
    */
   function sanitizeState(raw) {
     const problems = [];
     const note = (m) => { if (problems.length < 12) problems.push(m); };
   
     if (!isObject(raw)) {
       return { state: blankState(), problems: ['the file did not contain a valid data object'] };
     }
   
     const fileVersion = Number(raw.version);
     if (Number.isFinite(fileVersion) && fileVersion > SCHEMA_VERSION) {
       note('it was created by a newer version (v' + fileVersion + '); unknown fields were dropped');
     }
   
     // ── categories ──────────────────────────────────────────────
     const categories = [];
     const catKeys = new Set();
     const rawCats = Array.isArray(raw.categories) ? raw.categories : (raw.categories ? [] : null);
     if (rawCats === null) note('no category list was present, so the defaults were restored');
   
     for (const c of rawCats || []) {
       if (typeof c !== 'string') { note('skipped a category that was not text'); continue; }
       const name = cleanText(c, NAME_LIMIT);
       if (!name) continue;
       const key = name.toLowerCase();
       if (catKeys.has(key)) { note('merged the duplicate category "' + name + '"'); continue; }
       catKeys.add(key);
       categories.push(name);
     }
     if (categories.length === 0) {
       categories.push(...DEFAULT_CATEGORIES);
       if (rawCats && rawCats.length) note('every category was invalid, so the defaults were restored');
     }
     const hasCategory = (n) => catKeys.has(String(n).toLowerCase());
     const fallbackCategory = hasCategory('Other') ? 'Other' : categories[0];
   
     // ── budgets, now keyed by month ─────────────────────────────
     // A v2 file held a flat { category: limit } map with no month. Those limits
     // are attached to the current month, which is what the user was looking at
     // when they set them.
     const budgets = Object.create(null);
     const legacyFlat = Object.create(null);
     let hadLegacyFlat = false;
     const rawBudgets = isObject(raw.budgets) ? raw.budgets : {};
   
     for (const key of Object.keys(rawBudgets)) {
       const val = rawBudgets[key];
       if (isObject(val)) {
         if (!PERIOD_RE.test(key)) { note('ignored a budget group for an unreadable month "' + key + '"'); continue; }
         const inner = Object.create(null);
         for (const cat of Object.keys(val)) {
           const amount = toPositiveNumber(val[cat]);
           if (amount === null) { note('dropped an invalid budget for "' + cat + '" in ' + key); continue; }
           inner[cat] = amount;
         }
         budgets[key] = inner;
       } else {
         hadLegacyFlat = true;
         const amount = toPositiveNumber(val);
         if (amount === null) { note('dropped an invalid budget for "' + key + '"'); continue; }
         legacyFlat[key] = amount;
       }
     }
   
     const thisPeriod = currentPeriod();
     if (hadLegacyFlat) {
       if (!budgets[thisPeriod]) budgets[thisPeriod] = Object.create(null);
       for (const cat of Object.keys(legacyFlat)) {
         if (Object.prototype.hasOwnProperty.call(budgets[thisPeriod], cat)) continue;
         budgets[thisPeriod][cat] = legacyFlat[cat];
       }
       note('moved your budgets into the current month (' + periodLabel(thisPeriod) + ')');
     }
     if (!Object.prototype.hasOwnProperty.call(budgets, thisPeriod)) {
       // Seed the default limits only when the file carried no budget data at all,
       // which means a new or damaged file. A month the user deliberately emptied
       // is stored as an explicit empty object and must be left alone — silently
       // restoring limits they removed would be just as wrong as losing them.
       const hadAnyBudgets = Object.keys(budgets).length > 0;
       budgets[thisPeriod] = hadAnyBudgets ? Object.create(null) : defaultPeriodBudgets();
       if (!hadAnyBudgets) note('restored the default budgets for ' + periodLabel(thisPeriod));
     }
   
     // ── accounts ────────────────────────────────────────────────
     // Sanitised first, because transactions reference accounts and a dangling
     // accountId must be repaired before it can be resolved.
     const accounts = [];
     const accountIds = new Set();
     const accountNames = new Set();
     const rawAccounts = Array.isArray(raw.accounts) ? raw.accounts : null;
   
     // A duplicate-named account's id must not dangle: records pointing at it are
     // re-filed onto the survivor (see transactions and udhaar below), and its
     // opening balance is folded into the survivor so the money is not dropped.
     const accountAlias = new Map();
   
     const addAccount = (id, name, kind, opening, archived, a) => {
       const clean = cleanText(name, NAME_LIMIT);
       if (!clean) return null;
       const key = clean.toLowerCase();
       if (accountNames.has(key)) {
         const survivor = accounts.find((x) => x.name.toLowerCase() === key);
         const dupOpening = round2(clampNumber(opening, -MAX_AMOUNT, MAX_AMOUNT));
         if (survivor && dupOpening) {
           // The duplicate's opening balance is real money in the user's mental
           // book; dropping it would silently understate the account forever.
           survivor.openingBalance = round2(survivor.openingBalance + dupOpening);
           note('folded the opening balance of the duplicate "' + clean + '" into the kept account');
         }
         if (survivor && typeof id === 'string' && id.trim()) accountAlias.set(id.trim(), survivor.id);
         note('merged a duplicate account named "' + clean + '"');
         return null;
       }
       accountNames.add(key);
       let aid = (typeof id === 'string' && id.trim()) ? id.trim() : newId();
       if (accountIds.has(aid)) aid = newId();
       accountIds.add(aid);
       accounts.push({
         id: aid,
         name: clean,
         kind: ACCOUNT_KINDS.indexOf(kind) !== -1 ? kind : 'ewallet',
         // An opening balance may legitimately be zero, so it is read directly
         // rather than through toPositiveNumber, which rejects 0 and negatives.
         openingBalance: round2(clampNumber(opening, -MAX_AMOUNT, MAX_AMOUNT)),
         archived: archived === true,
         updatedAt: keepStamp(a && a.updatedAt)
       });
       return aid;
     };
   
     for (const a of rawAccounts || []) {
       if (!isObject(a)) { note('skipped a malformed account'); continue; }
       addAccount(a.id, a.name, a.kind, a.openingBalance, a.archived, a);
     }
   
     let assignedToCash = 0;
     if (!accounts.length) {
       if (rawAccounts !== null) note('no usable account was in the file, so Cash, NayaPay and Easypaisa were created');
       for (const a of DEFAULT_ACCOUNTS) addAccount(a.id, a.name, a.kind, a.openingBalance, a.archived, a);
     }
   
     const cashId = accounts.some((a) => a.kind === 'cash') ? accounts.find((a) => a.kind === 'cash').id : accounts[0].id;
     const accountIdSet = new Set(accounts.map((a) => a.id));
     const accountNameOf = (id) => {
       const a = accounts.find((x) => x.id === id);
       return a ? a.name : '';
     };
   
     // ── settings ────────────────────────────────────────────────
     const budgetOffset = Object.create(null);
     const rawSettings = isObject(raw.settings) ? raw.settings : {};
     const rawOffset = isObject(rawSettings.budgetOffset) ? rawSettings.budgetOffset : {};
     for (const key of Object.keys(rawOffset)) {
       if (rawOffset[key] === true) budgetOffset[key.toLowerCase()] = true;
     }
     // Remembered so the next entry defaults to the account last used, but only
     // if it still exists.
     const lastAccountId = typeof rawSettings.lastAccountId === 'string' && accountIdSet.has(rawSettings.lastAccountId)
       ? rawSettings.lastAccountId
       : cashId;
   
     // Which month the shopping list was last prepared for. Missing on files from
     // before this existed — treated as "this month, no reset" on the way in, so
     // upgrading never wipes the current ticks (see maybeResetShopping).
     const shoppingPeriod = typeof rawSettings.shoppingPeriod === 'string' && PERIOD_RE.test(rawSettings.shoppingPeriod)
       ? rawSettings.shoppingPeriod
       : null;
   
     // Counted-spending moves between budgets (the Fix button). Validated field
     // by field; a bad move is skipped, and moves pointing at vanished budgets
     // stay stored but inert (see liveBudgetMoves) rather than dropped.
     const budgetMoves = [];
     const moveIds = new Set();
     const rawMoves = Array.isArray(rawSettings.budgetMoves) ? rawSettings.budgetMoves : [];
     for (const m of rawMoves) {
       if (budgetMoves.length >= 200) { note('kept the first 200 budget moves'); break; }
       if (!isObject(m)) { note('skipped a malformed budget move'); continue; }
       if (typeof m.period !== 'string' || !PERIOD_RE.test(m.period)) { note('skipped a budget move with no month'); continue; }
       if (typeof m.from !== 'string' || !m.from.trim() || typeof m.to !== 'string' || !m.to.trim()) { note('skipped a budget move with no budgets'); continue; }
       const amount = toPositiveNumber(m.amount);
       if (amount === null) { note('skipped a budget move with an unusable amount'); continue; }
       let id = typeof m.id === 'string' && m.id.trim() ? m.id.trim() : newId();
       if (moveIds.has(id)) id = newId();
       moveIds.add(id);
       budgetMoves.push({
         id,
         period: m.period,
         from: m.from.trim().slice(0, NAME_LIMIT),
         to: m.to.trim().slice(0, NAME_LIMIT),
         amount
       });
     }
   
     // ── feature settings ────────────────────────────────────
     // Recurring plans, savings goals, quick-add templates and monthly
     // challenges. Validated field by field, capped in size, and deduped by
     // id — the same rules every other list in state follows.

     const withId = (pool, candidate) => {
       let id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : newId();
       if (pool.has(id)) id = newId();
       pool.add(id);
       return id;
     };
     const catOr = (name) => {
       const match = typeof name === 'string' && categories.find((c) => c.toLowerCase() === name.toLowerCase());
       return match || fallbackCategory;
     };

     // A standing instruction that files itself each month (salary, rent,
     // subscriptions). Never files twice in one month — that is lastFiled's job.
     const recurring = [];
     const recSeen = new Set();
     const rawRecurring = Array.isArray(rawSettings.recurring) ? rawSettings.recurring : [];
     for (const r of rawRecurring) {
       if (!isObject(r)) { note('skipped a malformed recurring plan'); continue; }
       if (recurring.length >= 24) { note('kept the first 24 recurring plans'); break; }
       const amount = toPositiveNumber(r.amount);
       if (amount === null) { note('skipped a recurring plan with an unusable amount'); continue; }
       const label = cleanText(r.label, ITEM_LIMIT);
       recurring.push({
         id: withId(recSeen, r),
         type: r.type === 'income' ? 'income' : 'expense',
         amount,
         category: catOr(r.category),
         accountId: accountIdSet.has(r.accountId) ? r.accountId : null,
         label,
         dayOfMonth: clampNumber(r.dayOfMonth, 1, 28),
         active: r.active !== false,
         lastFiled: typeof r.lastFiled === 'string' && PERIOD_RE.test(r.lastFiled) ? r.lastFiled : null
       });
     }

     // Savings goals: a target plus what is already set aside. Set-aside is a
     // progress note, not money — it never touches accounts or budgets.
     const goals = [];
     const goalSeen = new Set();
     const rawGoals = Array.isArray(rawSettings.goals) ? rawSettings.goals : [];
     for (const g of rawGoals) {
       if (!isObject(g)) { note('skipped a malformed goal'); continue; }
       if (goals.length >= 12) { note('kept the first 12 savings goals'); break; }
       const name = cleanText(g.name, NAME_LIMIT);
       const target = toPositiveNumber(g.target);
       if (!name) { note('skipped a goal with no name'); continue; }
       if (target === null) { note('skipped a goal with an unusable target'); continue; }
       goals.push({
         id: withId(goalSeen, g),
         name,
         target,
         saved: round2(clampNumber(g.saved, 0, target))
       });
     }

     // Quick-add templates: one tap files a whole income or expense.
     const templates = [];
     const tplSeen = new Set();
     const rawTemplates = Array.isArray(rawSettings.templates) ? rawSettings.templates : [];
     for (const t of rawTemplates) {
       if (!isObject(t)) { note('skipped a malformed template'); continue; }
       if (templates.length >= 12) { note('kept the first 12 templates'); break; }
       const amount = toPositiveNumber(t.amount);
       if (amount === null) { note('skipped a template with an unusable amount'); continue; }
       const label = cleanText(t.label, ITEM_LIMIT);
       if (!label) { note('skipped a template with no name'); continue; }
       templates.push({
         id: withId(tplSeen, t),
         label,
         type: t.type === 'income' ? 'income' : 'expense',
         amount,
         category: catOr(t.category)
       });
     }

     // Monthly challenges: keep one category under a cap for one month.
     const challenges = [];
     const chalSeen = new Set();
     const rawChallenges = Array.isArray(rawSettings.challenges) ? rawSettings.challenges : [];
     for (const c of rawChallenges) {
       if (!isObject(c)) { note('skipped a malformed challenge'); continue; }
       if (challenges.length >= 12) { note('kept the first 12 challenges'); break; }
       if (typeof c.period !== 'string' || !PERIOD_RE.test(c.period)) { note('skipped a challenge with no month'); continue; }
       const cap = toPositiveNumber(c.cap);
       if (cap === null) { note('skipped a challenge with an unusable cap'); continue; }
       const catMatch = typeof c.category === 'string' && categories.find((x) => x.toLowerCase() === c.category.toLowerCase());
       if (!catMatch) { note('skipped a challenge for a missing category'); continue; }
       challenges.push({ id: withId(chalSeen, c), period: c.period, category: catMatch, cap });
     }

     // Budget rollover: whether unused limits carry into the next month, and
     // which month was last processed so it fires exactly once per month.
     const budgetRollover = rawSettings.budgetRollover === true;
     const budgetRolloverPeriod = typeof rawSettings.budgetRolloverPeriod === 'string' && PERIOD_RE.test(rawSettings.budgetRolloverPeriod)
       ? rawSettings.budgetRolloverPeriod
       : null;

     // Personal notes: sticky-note cards with a color, an icon, a pin and an
     // updated stamp. Timer fields on a note are from before Timers became their
     // own section — they are lifted into a timer below instead of dropped, so
     // the upgrade loses nothing.
     const migratedTimers = [];
     const notes = [];
     const noteIds = new Set();
     const rawNotes = Array.isArray(rawSettings.notes) ? rawSettings.notes : [];
     for (const n of rawNotes) {
       if (!isObject(n)) { note('skipped a malformed note'); continue; }
       const title = cleanText(n.title, NOTE_TITLE_LIMIT);
       if (!title) { note('dropped a note with no title'); continue; }
       let id = typeof n.id === 'string' && n.id.trim() ? n.id.trim() : newId();
       if (noteIds.has(id)) id = newId();
       noteIds.add(id);
       const oldStart = typeof n.startedAt === 'number' && Number.isFinite(n.startedAt) && n.startedAt > 0 ? n.startedAt : null;
       const oldBase = typeof n.elapsedBase === 'number' && Number.isFinite(n.elapsedBase) && n.elapsedBase > 0
         ? Math.min(n.elapsedBase, 100 * 365 * 86400000)
         : 0;
       if (oldStart !== null || oldBase > 0 || n.running === true) {
         migratedTimers.push({
           id: newId(),
           label: title.slice(0, TIMER_LABEL_LIMIT),
           startedAt: (n.running === true && oldStart !== null) ? oldStart
             : (oldStart !== null ? oldStart : Date.now() - oldBase)
         });
         note('moved the timer on "' + title + '" into Timers');
       }
       const created = toLocalStamp(parseDate(n.createdAt) || new Date());
       notes.push({
         id,
         title,
         body: cleanText(n.body, NOTE_BODY_LIMIT, true),
         color: NOTE_COLORS.indexOf(n.color) !== -1 ? n.color : 'yellow',
         icon: NOTE_ICONS.indexOf(n.icon) !== -1 ? n.icon : '📝',
         pinned: n.pinned === true,
         createdAt: created,
         // Device-local, like every other date in the app.
         updatedAt: toLocalStamp(parseDate(n.updatedAt) || parseDate(n.createdAt) || new Date())
       });
     }
   
     // Count-up timers: a short label plus the moment they count from. The future
     // is clamped on the way in — a timer starting tomorrow is a typo, and it
     // would otherwise read as a negative that formatElapsed hides as zero.
     const timers = [];
     const timerIds = new Set();
     const rawTimers = Array.isArray(rawSettings.timers) ? rawSettings.timers : [];
     for (const t of rawTimers.concat(migratedTimers)) {
       if (!isObject(t)) { note('skipped a malformed timer'); continue; }
       const label = cleanText(t.label, TIMER_LABEL_LIMIT);
       if (!label) { note('dropped a timer with no label'); continue; }
       let id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : newId();
       if (timerIds.has(id)) id = newId();
       timerIds.add(id);
       const startedAt = typeof t.startedAt === 'number' && Number.isFinite(t.startedAt) && t.startedAt > 0
         ? Math.min(t.startedAt, Date.now())
         : Date.now();
       timers.push({ id, label, startedAt });
     }
   
     // Category memory for Pending approvals: bank + first telling word -> the
     // category last picked for it ("nayapay|coffee" -> Groceries). Bounded and
     // validated like everything else: keys are short lowercase strings, values
     // must name a category that still exists.
     const catMemory = Object.create(null);
     const rawMem = isObject(rawSettings.catMemory) ? rawSettings.catMemory : {};
     for (const k of Object.keys(rawMem)) {
       if (Object.keys(catMemory).length >= CAT_MEMORY_LIMIT) break;
       if (typeof rawMem[k] !== 'string') continue;
       const key = String(k).toLowerCase().slice(0, 80);
       if (!key || key.indexOf('|') === -1) continue;
       const kept = categories.find((c) => c.toLowerCase() === rawMem[k].toLowerCase());
       if (!kept) continue;
       catMemory[key] = kept;
     }
   
     // ── closedPeriods ───────────────────────────────────────────
     const closedPeriods = [];
     const closedSeen = new Set();
     const rawClosed = Array.isArray(raw.closedPeriods) ? raw.closedPeriods : [];
     for (const p of rawClosed) {
       if (typeof p !== 'string' || !PERIOD_RE.test(p)) { note('skipped an unreadable archived month'); continue; }
       if (closedSeen.has(p)) continue;
       closedSeen.add(p);
       closedPeriods.push(p);
     }
     closedPeriods.sort();
   
     // ── transactions ────────────────────────────────────────────
     const transactions = [];
     const txIds = new Set();
     let defaultedToCash = 0;
     const rawTxs = Array.isArray(raw.transactions) ? raw.transactions : [];
     if (raw.transactions !== undefined && !Array.isArray(raw.transactions)) note('the transaction list was not a list and was skipped');
     for (const t of rawTxs) {
       if (!isObject(t)) { note('skipped a malformed transaction'); continue; }
       const amount = toPositiveNumber(t.amount);
       if (amount === null) { note('dropped a transaction with an unusable amount'); continue; }
   
       let id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : newId();
       if (txIds.has(id)) { note('gave a duplicated transaction id a fresh one'); id = newId(); }
       txIds.add(id);
   
       const date = parseDate(t.date);
       if (!date) note('a transaction had no readable date and was dated today');
   
       const isTransfer = t.type === 'transfer';
   
       // Resolve the account. A v3 record has no accountId at all: its money was
       // whatever the user physically had, so it lands on Cash. An id dropped as a
       // duplicate of a same-named account is re-filed onto the survivor.
       const rawAccountId = typeof t.accountId === 'string' && accountIdSet.has(t.accountId)
         ? t.accountId
         : (typeof t.accountId === 'string' && accountAlias.has(t.accountId) ? accountAlias.get(t.accountId) : null);
       let accountId = rawAccountId;
       if (!accountId) {
         if (typeof t.accountId === 'string' && t.accountId) note('re-filed a transaction whose account no longer exists, under Cash');
         accountId = cashId;
         defaultedToCash++;
       }
   
       let toAccountId = null;
       if (isTransfer) {
         const rawToId = typeof t.toAccountId === 'string' && accountIdSet.has(t.toAccountId)
           ? t.toAccountId
           : (typeof t.toAccountId === 'string' && accountAlias.has(t.toAccountId) ? accountAlias.get(t.toAccountId) : null);
         toAccountId = rawToId;
         if (!toAccountId || toAccountId === accountId) {
           // A transfer that loops back into the same account moves nothing, so it
           // is meaningless rather than merely wrong.
           note('dropped a transfer that did not name a different account');
           continue;
         }
       }
   
       transactions.push({
         id,
         type: isTransfer ? 'transfer' : (t.type === 'income' ? 'income' : 'expense'),
         amount,
         // A transfer has no category: it is not spending, so filing it under
         // "Groceries" would quietly corrupt that category's budget.
         category: isTransfer ? '' : (cleanText(t.category, NAME_LIMIT) || fallbackCategory),
         comment: cleanText(t.comment, COMMENT_LIMIT),
         // Rewritten as a local stamp. A stored UTC instant is preserved exactly:
         // parseDate() resolves it, then toLocalStamp writes the local equivalent.
         date: toLocalStamp(date || new Date()),
         accountId,
         toAccountId: isTransfer ? toAccountId : null,
         source: typeof t.source === 'string' ? t.source : undefined,
         updatedAt: keepStamp(t.updatedAt)
       });
     }
   
     if (defaultedToCash) {
       note('put ' + defaultedToCash + ' earlier transaction(s) under Cash — change any that belong to a wallet in Records');
     }
   
     // ── debts ───────────────────────────────────────────────────
     const debts = [];
     const debtIds = new Set();
     const rawDebts = Array.isArray(raw.debts) ? raw.debts : [];
     if (raw.debts !== undefined && !Array.isArray(raw.debts)) note('the udhaar list was not a list and was skipped');
     for (const d of rawDebts) {
       if (!isObject(d)) { note('skipped a malformed udhaar entry'); continue; }
       const amount = toPositiveNumber(d.amount);
       const person = cleanText(d.person, NAME_LIMIT);
       if (amount === null) { note('dropped an udhaar entry with an unusable amount'); continue; }
       if (!person) { note('dropped an udhaar entry with no person name'); continue; }
   
       let id = typeof d.id === 'string' && d.id.trim() ? d.id.trim() : newId();
       if (debtIds.has(id)) { note('gave a duplicated udhaar id a fresh one'); id = newId(); }
       debtIds.add(id);
   
       const date = parseDate(d.date);
       // Strict booleans: a "false" string must not read as settled.
       const settled = d.settled === true;
       const settledAt = settled ? toLocalStamp(parseDate(d.settledAt) || date || new Date()) : null;
   
       debts.push({
         id,
         type: d.type === 'pay' ? 'pay' : 'receive',
         person,
         amount,
         note: cleanText(d.note, COMMENT_LIMIT),
         date: toLocalStamp(date || new Date()),
         settled,
         settledAt,
         ledger: d.ledger !== false,
         // Which account the money moved through. Old entries predate this and
         // carry nothing — debtAccountId() falls back for them at use time. An id
         // dropped as a duplicate follows its survivor here too.
         accountId: typeof d.accountId === 'string' && d.accountId.trim()
           ? (accountAlias.get(d.accountId.trim()) || (accountIdSet.has(d.accountId.trim()) ? d.accountId.trim() : null))
           : null,
         // Which bucket its ledger entries file under. Old entries predate this
         // too and resolve to Udhaar, exactly as they always filed.
         category: typeof d.category === 'string' && d.category.trim() ? d.category.trim().slice(0, NAME_LIMIT) : 'Udhaar',
         updatedAt: keepStamp(d.updatedAt)
       });
     }
   
     // ── shopping list ───────────────────────────────────────────
     const shopping = [];
     const shopIds = new Set();
     const rawShop = Array.isArray(raw.shopping) ? raw.shopping : [];
     for (const s of rawShop) {
       if (!isObject(s)) { note('skipped a malformed list item'); continue; }
       const name = cleanText(s.name, ITEM_LIMIT);
       if (!name) { note('skipped a list item with no name'); continue; }
   
       let id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : newId();
       if (shopIds.has(id)) { note('gave a duplicated list item id a fresh one'); id = newId(); }
       shopIds.add(id);
   
       const checked = s.checked === true;
       shopping.push({
         id,
         name,
         qty: cleanText(s.qty, QTY_LIMIT),
         note: cleanText(s.note, COMMENT_LIMIT),
         checked,
         createdAt: toLocalStamp(parseDate(s.createdAt) || new Date()),
         checkedAt: checked ? toLocalStamp(parseDate(s.checkedAt) || new Date()) : null,
         // A pointer to the expense this item produced, so the row can show it.
         boughtTxId: typeof s.boughtTxId === 'string' && s.boughtTxId ? s.boughtTxId : null,
         cost: toPositiveNumber(s.cost),
         updatedAt: keepStamp(s.updatedAt)
       });
     }
   
     // ── custody / amanat: money held for someone else ──────────
     // 'given' = the user handed it over and it is no longer theirs.
     // 'held'  = someone handed it to the user to keep. Neither is ever counted
     // in the balance; the only fields the balance reads are transactions.
     const custody = [];
     const custodyIds = new Set();
     const rawCustody = Array.isArray(raw.custody) ? raw.custody : [];
     for (const c of rawCustody) {
       if (!isObject(c)) { note('skipped a malformed amanat entry'); continue; }
       const person = cleanText(c.person, NAME_LIMIT);
       const amount = toPositiveNumber(c.amount);
       if (!person) { note('dropped an amanat entry with no person name'); continue; }
       if (amount === null) { note('dropped an amanat entry with an unusable amount'); continue; }
   
       let id = typeof c.id === 'string' && c.id.trim() ? c.id.trim() : newId();
       if (custodyIds.has(id)) { note('gave a duplicated amanat id a fresh one'); id = newId(); }
       custodyIds.add(id);
   
       // A partial return is normal, so 0 and partial are both fine — but never
       // more than what was handed over.
       let returned = c.returned === 0 ? 0 : toPositiveNumber(c.returned);
       if (returned === null) returned = 0;
       if (returned > amount) { note('capped an amanat return that was larger than the original amount'); returned = amount; }
   
       const date = parseDate(c.date);
       const returnedDate = returned > 0 ? (parseDate(c.returnedDate) || date || new Date()) : null;
   
       custody.push({
         id,
         person,
         direction: c.direction === 'given' ? 'given' : 'held',
         amount,
         returned,
         note: cleanText(c.note, COMMENT_LIMIT),
         date: toLocalStamp(date || new Date()),
         returnedDate: returnedDate ? toLocalStamp(returnedDate) : null,
         updatedAt: keepStamp(c.updatedAt)
       });
     }
   
     return {
       state: {
         version: SCHEMA_VERSION,
         transactions, debts, budgets, categories, shopping, custody,
         accounts,
         settings: { budgetOffset, lastAccountId, shoppingPeriod, budgetRollover, budgetRolloverPeriod, notes, timers, catMemory, budgetMoves, recurring, goals, templates, challenges },
         closedPeriods
       },
       problems
     };
   }
   
   /* ============================================================
      Persistence
      ============================================================ */
   
   /** Read + validate whatever is on disk. Never throws. */
   function loadState() {
     let raw = null;
     try {
       raw = localStorage.getItem(STORAGE_KEY);
     } catch (err) {
       storageUsable = false;
       return { state: blankState(), notice: 'This browser is blocking local storage, so nothing you enter can be saved.' };
     }
   
     if (raw === null) return migrateLegacy();
   
     let parsed;
     try {
       parsed = JSON.parse(raw);
     } catch (err) {
       return {
         state: blankState(),
         broken: true,
         notice: 'The saved data was corrupted and has been reset. Anything previously stored is gone — import a backup if you have one.'
       };
     }
   
     const { state: clean, problems } = sanitizeState(parsed);
     return {
       state: clean,
       repaired: problems.length > 0,
       notice: problems.length
         ? 'Repaired saved data: ' + problems.slice(0, 2).join('; ') + (problems.length > 2 ? ' (+' + (problems.length - 2) + ' more)' : '')
         : null
     };
   }
   
   /** One-time upgrade from the old four-key layout. */
   function migrateLegacy() {
     let found = null;
     try {
       const txs = localStorage.getItem('transactions');
       const cats = localStorage.getItem('categories');
       if (txs === null && cats === null) return { state: blankState(), notice: null };
       found = {
         transactions: safeParse(txs, []),
         debts: safeParse(localStorage.getItem('debts'), []),
         budgets: safeParse(localStorage.getItem('budgets'), {}),
         categories: safeParse(cats, null)
       };
     } catch (err) {
       return { state: blankState(), notice: null };
     }
   
     const { state: clean, problems } = sanitizeState(found);
     try { LEGACY_KEYS.forEach((k) => localStorage.removeItem(k)); } catch (err) { /* nothing we can do */ }
     return {
       state: clean,
       repaired: true,
       notice: 'Moved your existing data to the new storage format' + (problems.length ? ' and repaired ' + problems.length + ' issue(s)' : '') + '.'
     };
   }
   
   function safeParse(raw, fallback) {
     if (raw === null) return fallback;
     try { return JSON.parse(raw); } catch (err) { return fallback; }
   }
   
   /** Persist, then render. Reports quota failures instead of losing data silently. */
   function save() {
     // Stamp any changed records FIRST, so the sync timestamp is part of what
     // gets written to disk. Doing it after the write would leave the stamp only
     // in memory, and a reload would lose it.
     if (window.CashFlowSync) {
       if (window.CashFlowSync.reconcile(state)) window.CashFlowSync.queuePush();
     }
   
     let ok = true;
     try {
       localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
     } catch (err) {
       ok = false;
       const quota = err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
       toast(quota
         ? 'Storage is full — this change was NOT saved. Export a backup, then delete old records.'
         : 'This browser refused to save. Your change is only in memory and will be lost on reload.');
     }
     renderAll();
     return ok;
   }
   
   async function resetAll() {
     if (!confirm('Delete ALL transactions, udhaar, budgets, categories and list items from this browser? This cannot be undone. Export a backup first if you might want the data back.')) return;
     const S = window.CashFlowSync;
     // Signed in, this would NOT stay local: the sync engine compares against its
     // shadow, reads every vanished row as a deletion, and pushes tombstones for
     // all of them — wiping the cloud as a side effect. So sign out first (which
     // drops the session and the cursors) and forget the shadow too. Only then is
     // "local" actually local.
     if (S && S.isSignedIn) {
       try { await S.signOut(); } catch (err) { /* signing out locally matters more */ }
     }
     if (S && S.resetSyncState) S.resetSyncState();
     // Nothing is left on this browser, so the next sign-in is not a takeover of
     // anyone's records.
     if (S && S.clearLocalDataOwner) S.clearLocalDataOwner();
     try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
     state = blankState();
     reportRange = { mode: 'month' };
     budgetPeriod = null;
     renderAll();
     toast('All local data cleared. The cloud was not touched.');
   }
   
   /** Delete the ledger from the cloud, on purpose, with proof of ownership.
    *
    *  Backup files and "delete local data" never reach here: this is the one
    *  button that deletes server rows. It asks for the account password and
    *  re-signs in with it first — so a borrowed unlocked phone is not enough.
    *  Only ledger tables go: email_routes and pending_transactions are left
    *  exactly as they are, so the mail setup survives. Afterwards this browser
    *  is reset to match, with sync claims cleared so nothing gets re-uploaded. */
   async function deleteCloudData() {
     const S = window.CashFlowSync;
     if (!S || !S.isSignedIn) { toast('Sign in first — there is no cloud data without an account'); return; }
     const pwBox = $('cloudDeletePassword');
     const pw = pwBox && typeof pwBox.value === 'string' ? pwBox.value : '';
     if (!pw) { toast('Enter your account password first'); if (pwBox) pwBox.focus(); return; }
     const email = S.email;
     if (!confirm(
       'Permanently delete ALL your ledger data from the cloud?\n\n' +
       'Transactions, udhaar, shopping, accounts, budgets and categories.\n\n' +
       'Your email setup (forwarding addresses, pending queue) stays untouched.\n\n' +
       'This cannot be undone. Export a backup first if you might want anything back.'
     )) return;
   
     toast('Checking password…');
     let res;
     try {
       res = await S.signIn(email, pw);
     } catch (err) {
       toast('Could not reach the server — nothing was deleted');
       return;
     }
     if (res.error) { toast(res.error); return; }
     if (pwBox) pwBox.value = '';
   
     const failures = [];
     for (const t of ['transactions', 'accounts', 'debts', 'custody', 'shopping', 'prefs']) {
       try {
         await S.deleteUserRows(t);
       } catch (err) {
         failures.push(t);
       }
     }
     if (failures.length) {
       toast('Some cloud data could not be deleted (' + failures.join(', ') + '). Nothing was changed here — try again.');
       return;
     }
   
     if (S.resetSyncState) S.resetSyncState();
     state = blankState();
     reportRange = { mode: 'month' };
     budgetPeriod = null;
     save();
     toast('Cloud ledger deleted. Your email setup is untouched.');
   }
   
   /* ============================================================
      Derived figures
      ============================================================ */
   
   /** Totals over an optional window. Future-dated records are never counted.
    *  Transfers are skipped here on purpose: moving your own money between your
    *  own wallets is not income and not spending, and counting it would inflate
    *  the income box and burn category budgets for no reason. */
   function ledgerTotals(start, end) {
     let income = 0;
     let expense = 0;
     // Future-dated records are not money yet. periodBoundsOf() ends a month at
     // its last day, so a transaction dated later this month used to be counted
     // in the Income/Expense figures on Home — money that has not moved. Budget
     // rows already cap at today (budgetCounted); this makes the totals beside
     // them agree. A record dated tomorrow therefore waits until tomorrow.
     const cap = endOfToday();
     const stop = (!end || end > cap) ? cap : end;
     for (const t of state.transactions) {
       if (t.type === 'transfer') continue;
       const d = new Date(t.date);
       if (start && d < start) continue;
       if (stop && d > stop) continue;
       if (t.type === 'income') income += t.amount;
       else expense += t.amount;
     }
     return { income: round2(income), expense: round2(expense), net: round2(income - expense) };
   }
   
   /* ---------- accounts ---------- */
   
   function findAccount(id) { return state.accounts.find((a) => a.id === id) || null; }
   function accountName(id) { const a = findAccount(id); return a ? a.name : 'Unknown account'; }
   function cashAccountId() {
     const cash = state.accounts.find((a) => a.kind === 'cash');
     return cash ? cash.id : (state.accounts[0] ? state.accounts[0].id : '');
   }
   
   /** Give this device's factory accounts fresh ids after the server refused them.
    *
    *  Called from pushAll exactly once per accounts-push RLS failure, only after
    *  the refusal actually happened — never speculatively. The ids are opaque
    *  (every lookup is by id at runtime, every display by name), so renaming is
    *  invisible to the user; only the references have to follow, and they all
    *  live in transactions plus settings.lastAccountId. save() restamps whatever
    *  moved, so the retry — and the already-pushed transactions — converge on the
    *  next cycle. Returns true only when something was renamed to retry with. */
   async function remapCollidingAccountIds() {
     const factory = new Set(DEFAULT_ACCOUNTS.map((a) => a.id));
     const map = Object.create(null);
     for (const a of state.accounts || []) {
       if (a && factory.has(a.id) && !map[a.id]) map[a.id] = newId();
     }
     const ids = Object.keys(map);
     if (!ids.length) return false;
     for (const a of state.accounts) {
       if (a && map[a.id]) a.id = map[a.id];
     }
     for (const t of state.transactions || []) {
       if (!t) continue;
       if (map[t.accountId]) t.accountId = map[t.accountId];
       if (map[t.toAccountId]) t.toAccountId = map[t.toAccountId];
     }
     // Udhaar entries carry their own account reference; it must follow the
     // rename too, or a settled debt would land in the wrong (or vanished)
     // account and the balance would no longer agree.
     for (const d of state.debts || []) {
       if (!d) continue;
       if (map[d.accountId]) d.accountId = map[d.accountId];
     }
     if (state.settings && map[state.settings.lastAccountId]) {
       state.settings.lastAccountId = map[state.settings.lastAccountId];
     }
     const S = window.CashFlowSync;
     if (S) {
       // Tell the engine's shadow about the rename BEFORE save()'s reconcile runs.
       // Otherwise it reads the vanished factory ids as deletions, files tombstones
       // for rows this device never owned, and every future push re-fails on them —
       // the heal would fix the rows and wedge the tombstones in one move.
       if (typeof S.absorbShadow === 'function') S.absorbShadow('accounts', state.accounts);
       if (typeof S.forgetTombstones === 'function') S.forgetTombstones('accounts', ids);
     }
     save();
     toast('Synced your accounts under fresh ids — the defaults were already claimed by another account');
     return true;
   }
   function accountTint(kind) { return ACCOUNT_TINT[kind] || ACCOUNT_TINT_FALLBACK; }
   
   /** Running balance of one account, over the whole ledger.
    *  opening + income in − expense out + transfers in − transfers out. */
   function accountBalance(id) {
     let bal = 0;
     for (const t of state.transactions) {
       const d = new Date(t.date);
       if (Number.isNaN(d.getTime()) || d > endOfToday()) continue;   // future-dated money is not in the bank yet
       if (t.type === 'transfer') {
         if (t.toAccountId === id) bal += t.amount;
         if (t.accountId === id) bal -= t.amount;
       } else if (t.accountId === id) {
         bal += t.type === 'income' ? t.amount : -t.amount;
       }
     }
     const acc = findAccount(id);
     if (acc) bal += acc.openingBalance;
     return round2(bal);
   }
   
   /** Balance of every account, plus the grand total. */
   function allAccountBalances() {
     const rows = state.accounts.map((a) => ({
       account: a,
       balance: accountBalance(a.id)
     }));
     const total = round2(rows.reduce((s, r) => s + r.balance, 0));
     return { rows, total };
   }
   
   /** Income / expense / transfer split for one account over a window. */
   function accountActivity(id, start, end) {
     const cap = endOfToday();
     const stop = (!end || end > cap) ? cap : end;
     let income = 0;
     let expense = 0;
     let transferIn = 0;
     let transferOut = 0;
     for (const t of state.transactions) {
       const d = new Date(t.date);
       if (start && d < start) continue;
       if (stop && d > stop) continue;
       if (t.type === 'transfer') {
         if (t.toAccountId === id) transferIn += t.amount;
         if (t.accountId === id) transferOut += t.amount;
       } else if (t.accountId === id) {
         if (t.type === 'income') income += t.amount;
         else expense += t.amount;
       }
     }
     return { income: round2(income), expense: round2(expense), transferIn: round2(transferIn), transferOut: round2(transferOut) };
   }
   
   /** Every transfer, newest first, for the Accounts tab. */
   function transferList() {
     return state.transactions
       .filter((t) => t.type === 'transfer')
       .sort((a, b) => {
         const diff = new Date(b.date) - new Date(a.date);
         return diff !== 0 ? diff : (a.id < b.id ? -1 : 1);
       });
   }
   
   function countTransactionsForAccount(id) {
     return state.transactions.filter((t) => t.accountId === id || t.toAccountId === id).length;
   }
   
   function udhaarTotals() {
     let receive = 0;
     let pay = 0;
     for (const d of state.debts) {
       if (d.settled) continue;
       if (d.type === 'receive') receive += d.amount;
       else pay += d.amount;
     }
     return { receive: round2(receive), pay: round2(pay), net: round2(receive - pay) };
   }
   
   /** Expense per category inside a window. Uses a Map so category names can never
    *  collide with Object.prototype keys such as "toString" or "constructor". */
   function spendByCategory(start, end) {
     const cap = endOfToday();
     const stop = (!end || end > cap) ? cap : end;
     const map = new Map();
     for (const t of state.transactions) {
       if (t.type !== 'expense') continue;
       const d = new Date(t.date);
       if (start && d < start) continue;
       if (stop && d > stop) continue;
       map.set(t.category, round2((map.get(t.category) || 0) + t.amount));
     }
     return map;
   }
   
   /** Income per category inside a window — used to offset a budget when the
    *  category has that switch on. */
   function incomeByCategory(start, end) {
     const cap = endOfToday();
     const stop = (!end || end > cap) ? cap : end;
     const map = new Map();
     for (const t of state.transactions) {
       if (t.type !== 'income') continue;
       const d = new Date(t.date);
       if (start && d < start) continue;
       if (stop && d > stop) continue;
       map.set(t.category, round2((map.get(t.category) || 0) + t.amount));
     }
     return map;
   }
   
   function periodBounds(period) {
     const now = new Date();
     const today = endOfToday();
     if (period === 'week') {
       // Today plus the six days before it = seven days in total.
       return { start: addDays(now, -6), end: today, label: 'Last 7 days' };
     }
     if (period === 'month') {
       return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: today, label: periodLabel(currentPeriod()) };
     }
     if (period === 'prevMonth') {
       const p = previousPeriod(currentPeriod());
       const b = periodBoundsOf(p);
       return { start: b.start, end: b.end, label: periodLabel(p) };
     }
     if (period === 'custom') {
       const from = parseDate(reportRange.from);
       const to = parseDate(reportRange.to);
       if (!from) return { start: null, end: today, label: 'All time' };
       // Inclusive of the chosen "to" day.
       const end = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999) : today;
       const p = (x) => pad2(x.getDate()) + '/' + pad2(x.getMonth() + 1);
       return {
         start: new Date(from.getFullYear(), from.getMonth(), from.getDate()),
         end: end > today ? today : end,
         label: p(from) + (to ? ' – ' + p(to) : ' – today')
       };
     }
     return { start: null, end: today, label: 'All time' };
   }
   
   /** Every month that has any data in it, newest first. */
   function knownPeriods() {
     const set = new Set(state.closedPeriods);
     set.add(currentPeriod());
     for (const t of state.transactions) {
       const d = new Date(t.date);
       if (Number.isNaN(d.getTime())) continue;
       set.add(d.getFullYear() + '-' + pad2(d.getMonth() + 1));
     }
     for (const key of Object.keys(state.budgets)) {
       if (PERIOD_RE.test(key)) set.add(key);
     }
     return Array.from(set).filter(PERIOD_RE.test.bind(PERIOD_RE)).sort().reverse();
   }
   
   /* ============================================================
      Toast
      ============================================================ */
   
   let toastTimer = null;
   function toast(msg, action) {
     const existing = document.querySelector('.toast');
     if (existing) existing.remove();
     if (toastTimer) clearTimeout(toastTimer);
     const el = h('div', { class: 'toast show', role: 'status', 'aria-live': 'polite' }, msg);
     // Optional follow-up (Undo). The toast itself ignores clicks; the button
     // is the one thing inside it that opts back in.
     if (action && typeof action.fn === 'function') {
       const btn = h('button', {
         type: 'button',
         class: 'toast-btn',
         text: (typeof action.label === 'string' && action.label) ? action.label : 'Undo'
       });
       btn.addEventListener('click', () => {
         el.classList.remove('show');
         if (toastTimer) clearTimeout(toastTimer);
         setTimeout(() => el.remove(), 300);
         action.fn();
       });
       el.append(btn);
     }
     document.body.append(el);
     toastTimer = setTimeout(() => {
       el.classList.remove('show');
       setTimeout(() => el.remove(), 300);
     }, 3200);
   }
   
   /* ============================================================
      Appearance (per-device theme, never synced)
      ============================================================ */
   
   const THEME_KEY = 'cashflow:theme';
   const THEMES = ['sepia', 'dark'];
   const THEME_LABELS = { sepia: 'Sepia', dark: 'Dark' };
   
   /** The theme lives in its own storage key on purpose: it is a property of
    *  the device (this phone wants dark, that laptop wants light), not of the
    *  money. Putting it in app state would sync it everywhere and flip the
    *  other device's screen — the opposite of a preference. */
   function getTheme() {
     try {
       const t = localStorage.getItem(THEME_KEY);
       // 'light' retired with v37: anyone still on it gets sepia, the new
       // default, rather than a theme that no longer exists.
       if (t === 'light') return 'sepia';
       if (THEMES.indexOf(t) !== -1) return t;
     } catch (err) { /* storage blocked: fall back to sepia */ }
     return 'sepia';
   }
   
   function applyTheme() {
     const t = getTheme();
     try {
       document.documentElement.setAttribute('data-theme', t);
     } catch (err) { /* headless test env: nothing to paint on */ }
     // The accent reads differently on each theme, so it re-applies here.
     if (typeof applyAccent === 'function') applyAccent();
   }
   
   function setTheme(name) {
     if (THEMES.indexOf(name) === -1) return;
     try { localStorage.setItem(THEME_KEY, name); } catch (err) { /* ignore */ }
     applyTheme();
     renderThemeButtons();
     toast(THEME_LABELS[name] + ' theme on');
   }
   
   function renderThemeButtons() {
     const box = $('themeButtons');
     if (!box) return;
     const cur = getTheme();
     mount(box, THEMES.map((t) =>
       h('button', {
         type: 'button',
         class: 'btn-mini theme-btn' + (t === cur ? ' is-active' : ''),
         dataset: { act: 'theme-set', arg: t },
         'aria-pressed': t === cur ? 'true' : 'false'
       }, (t === cur ? '● ' : '○ ') + THEME_LABELS[t])));
   }
   
   /* ============================================================
      Tabs
      ============================================================ */
   
   /* ---------- build marker ----------
   
      Which version is actually running, and is it the newest one.
   
      A service worker keeps the last few builds and can hand any of them back, so
      "I deployed the fix and nothing changed" has a mundane explanation that is
      invisible from the inside — the page looks identical either way. This was
      reported more than once during development, and the answer was always "you are
      on the previous build". The check is deliberately passive: it fetches the
      current index.html, reads only the version out of it, and never touches the
      app's data, so it is safe to run on every load. */
   
   const BUILD_KEY = 'cashflow:buildSeen';
   
   function numericBuild(v) {
     const n = parseInt(String(v || '').replace(/^v/i, ''), 10);
     return Number.isFinite(n) ? n : -1;
   }
   
   function renderBuildBadge(state, text) {
     const badge = $('buildBadge');
     const out = $('buildText');
     const cfg = window.CASHFLOW_CONFIG || {};
     if (!badge || !out) return;
     badge.classList.remove('stale', 'checking');
     if (state) badge.classList.add(state);
     out.textContent = text || ('CashFlow OS ' + (cfg.appBuild || '?'));
     badge.title = state === 'stale'
       ? 'A newer version is deployed. Press to reload and get it.'
       : 'Version ' + (cfg.appBuild || '?') + ' — press to check for a newer one';
   }
   
   async function checkForNewerBuild(manual) {
     const badge = $('buildBadge');
     const cfg = window.CASHFLOW_CONFIG || {};
     if (badge) { badge.classList.add('checking'); badge.classList.remove('stale'); }
     if (manual) renderBuildBadge('', 'Checking…');
     try {
       /* No-store, and a cache-buster, because the whole question is whether the
          network has something newer than what the service worker is holding. A
          cached answer would report the build already running. */
       const res = await fetch('index.html?build=' + Date.now(), {
         cache: 'no-store',
         headers: { 'Cache-Control': 'no-cache' }
       });
       const html = await res.text();
       const m = /<meta name="app-build" content="([^"]+)">/.exec(html);
       const latest = m ? m[1] : null;
       const mine = cfg.appBuild;
   
       if (latest && numericBuild(latest) > numericBuild(mine)) {
         renderBuildBadge('stale', 'Newer version available · ' + latest);
         if (manual) toast('A newer version (' + latest + ') is deployed. Reload to get it.');
         // Returns the deployed build so the caller can announce it once.
         // Storage is left to announceNewBuildOnce: writing it here would mark
         // the build "seen" before the announcement is decided, and the toast
         // would never fire.
         return latest;
       }
       if (latest && latest !== mine) {
         /* Newer-looking but not numerically newer: a branch, or a rollback. Say
            so rather than calling it up to date. Not announced as an update,
            because it is not one. */
         renderBuildBadge('stale', 'Deployed: ' + latest + ' · running ' + mine);
         if (manual) toast('The deployed version is ' + latest + ', not ' + mine + '.');
         return false;
       }
       renderBuildBadge('', 'CashFlow OS ' + (mine || '?'));
       if (manual) toast('You are on the latest version (' + (mine || '?') + ').');
       return false;
     } catch (err) {
       renderBuildBadge('', 'CashFlow OS ' + (cfg.appBuild || '?'));
       if (manual) toast('Could not check for a newer version — you appear to be offline.');
       return false;
     }
   }
   
   function rememberSeenBuild(v) {
     try { localStorage.setItem(BUILD_KEY, v); } catch (err) { /* ignore */ }
   }
   
   /* Shown once per browser, the first time a new build is found, so it does not
      become a nagging habit — the badge itself is always there to look at. */
   function announceNewBuildOnce(latest) {
     let seen = null;
     try { seen = localStorage.getItem(BUILD_KEY); } catch (err) { seen = null; }
     if (seen === latest) return;
     rememberSeenBuild(latest);
     if (seen) toast('Updated to ' + latest);
   }
   
   function showTab(name, opts) {
     const o = opts || {};
     if (!TABS.some((t) => t.id === name)) name = 'home';
     activeTab = name;
   
     for (const panel of document.querySelectorAll('[data-panel]')) {
       const on = panel.dataset.panel === name;
       panel.hidden = !on;
     }
     for (const tab of document.querySelectorAll('[data-tab]')) {
       const on = tab.dataset.tab === name;
       tab.classList.toggle('is-active', on);
       tab.setAttribute('aria-selected', on ? 'true' : 'false');
       tab.tabIndex = on ? 0 : -1;
     }
   
     // Only the visible panel is worth measuring, so charts render once they show.
     renderAll();
   
     // Pending is the only tab that needs the network, and most sessions never
     // open it. Fetching on every page load spent requests to fill a panel nobody
     // looked at, on a connection that may not even exist.
     if (name === 'pending') { loadPendingTransactions(); loadEmailRouteStatus(); }
   
     if (!o.silent && typeof location !== 'undefined') {
       const hash = '#/' + name;
       if (location.hash !== hash) {
         try { location.hash = hash; } catch (err) { /* ignore */ }
       }
     }
     window.scrollTo(0, 0);
   }
   
   function tabFromHash() {
     const m = /^#\/([a-z]+)$/.exec(String(location.hash || ''));
     if (!m) return 'home';
     return TABS.some((t) => t.id === m[1]) ? m[1] : 'home';
   }
   
   /* ============================================================
      Selects
      ============================================================ */
   
   /**
    * Fill a <select> with categories.
    * `orphans` are names kept only by history (their category was deleted).
    * They are offered as options so editing an old record cannot silently
    * overwrite the category it was filed under.
    */
   function fillCategorySelect(select, opts) {
     if (!select) return;
     const o = opts || {};
     const orphans = o.orphans || [];
   
     const names = [];
     const seen = new Set();
     const add = (n) => {
       const key = String(n).toLowerCase();
       if (!n || seen.has(key)) return;
       seen.add(key);
       names.push(n);
     };
     orphans.forEach(add);
     state.categories.forEach(add);
   
     /* The value the control already holds is read BEFORE the option list is
        rebuilt: replacing the options resets the selection to the first one,
        so reading afterwards would always "hold" the first category and
        silently undo the user's pick on every re-render. */
     const heldBeforeMount = typeof select.value === 'string' ? select.value : '';
   
     mount(select, names.map((name) => {
       const isOrphan = !state.categories.some((c) => c.toLowerCase() === name.toLowerCase());
       return h('option', { value: name }, isOrphan ? name + ' (removed)' : name);
     }));
   
     /* What to keep selected. An explicit `selected` wins; otherwise the value
        the control already holds is kept as long as it is still a real choice —
        every re-render used to reset these dropdowns to the first entry, so a
        category typed into the Records form silently became "the first one"
        whenever a budget or category changed elsewhere. A control with nothing
        held yet (first fill) takes `fallback` when it exists, so the udhaar form
        opens on "Udhaar" rather than whatever category happens to be first. */
     const held = heldBeforeMount;
     const wanted = typeof o.selected === 'string' ? o.selected
       : held || (typeof o.fallback === 'string' && names.some((n) => n.toLowerCase() === o.fallback.toLowerCase())
         ? o.fallback
         : '');
     if (wanted) {
       const match = names.find((n) => n.toLowerCase() === String(wanted).toLowerCase());
       if (match) { select.value = match; return; }
     }
     select.selectedIndex = 0;
   }
   
   function refreshSelects() {
     fillCategorySelect($('txCategory'));
     fillCategorySelect($('budgetCategory'));
     // The udhaar category keeps whatever is picked now instead of snapping back
     // to "Udhaar" — but a form with nothing picked yet opens on the Udhaar
     // bucket (its fallback), which is where these entries file by default.
     fillCategorySelect($('debtCategory'), { fallback: 'Udhaar' });
     refreshAccountSelects();
   }
   
   /** Fill an account <select>. Archived accounts are omitted by default so new
    *  entries cannot land in a closed wallet, but a caller can ask for them by
    *  passing the id it needs to keep visible (used when editing a record).
    *  `emptyLabel` prepends a blank "no account" choice — for forms where not
    *  moving money right now is legitimate (an old udhaar being recorded). */
   function fillAccountSelect(select, opts) {
     if (!select) return;
     const o = opts || {};
     /* Keep what the control already holds when no explicit choice is given, for
        the same reason as the category select: these refill on every re-render,
        and resetting to the last-used account made a picked "No account movement"
        (or a wallet chosen a moment ago) snap back the instant anything else was
        saved. An explicit `selected` still wins. */
     const held = typeof select.value === 'string' ? select.value : '';
     const chosen = typeof o.selected === 'string' ? o.selected
       : (held && (held === '' ? !!o.emptyLabel : state.accounts.some((a) => a.id === held)))
         ? held
         : (state.settings.lastAccountId || cashAccountId());
     const list = state.accounts.filter((a) => !a.archived || a.id === chosen);
   
     mount(select,
       o.emptyLabel ? h('option', { value: '' }, o.emptyLabel) : null,
       list.map((a) => h('option', { value: a.id }, a.archived ? a.name + ' (archived)' : a.name)));
     if ((o.emptyLabel && chosen === '') || list.some((a) => a.id === chosen)) select.value = chosen;
     else if (o.emptyLabel) select.value = '';
     else if (list.length) select.value = list[0].id;
   }
   
   function refreshAccountSelects() {
     fillAccountSelect($('txAccount'));
     fillAccountSelect($('txToAccount'));
     fillAccountSelect($('itemAccount'));
     // The debt account is the one that mattered most to keep: an empty pick is a
     // real, deliberate answer ("this udhaar does not move money"), and it was
     // the value that snapped back to the last-used wallet on every save.
     fillAccountSelect($('debtAccount'), { emptyLabel: 'No account movement' });
     fillAccountSelect($('editAccount'));
     fillAccountSelect($('editToAccount'));
   }
   
   /** Month <select> for places that need to look back in time. */
   function fillPeriodSelect(select, opts) {
     if (!select) return;
     const o = opts || {};
     const periods = knownPeriods();
     mount(select, periods.map((p) => h('option', { value: p }, periodLabel(p) + (isClosed(p) ? ' (closed)' : ''))));
     const target = o.selected && periods.indexOf(o.selected) !== -1 ? o.selected : periods[0];
     if (target) select.value = target;
     return target;
   }
   
   /* ============================================================
      Accounts
      ============================================================ */
   
   function addAccount(nameInput, kindSelect) {
     const name = cleanText(nameInput.value, NAME_LIMIT);
     if (!name) { toast('Enter an account name'); return; }
     if (/[<>&"']/.test(name)) { toast('Account names cannot contain < > & " or \''); return; }
     if (state.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
       toast('"' + name + '" already exists');
       return;
     }
     if (state.accounts.length >= 24) { toast('24 accounts is the limit'); return; }
   
     const kind = ACCOUNT_KINDS.indexOf(kindSelect.value) !== -1 ? kindSelect.value : 'ewallet';
     state.accounts.push({ id: newId(), name, kind, openingBalance: 0, archived: false });
     nameInput.value = '';
     save();
     toast('Added "' + name + '"');
   }
   
   function renameAccount(id) {
     const acc = findAccount(id);
     if (!acc) { toast('That account no longer exists'); return; }
     const name = cleanText(window.prompt('Rename "' + acc.name + '" to:', acc.name), NAME_LIMIT);
     if (!name) return;   // cancelled or blank: leave it alone
     if (/[<>&"']/.test(name)) { toast('Account names cannot contain < > & " or \''); return; }
     if (state.accounts.some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) {
       toast('"' + name + '" already exists');
       return;
     }
     acc.name = name;
     save();
     toast('Renamed to "' + name + '"');
   }
   
   /** Set the opening balance — what was already in the account before the first
    *  transaction ever recorded against it. This is the one figure that is not
    *  derived from the ledger, so it is only ever edited on purpose. */
   function setOpeningBalance(id) {
     const acc = findAccount(id);
     if (!acc) { toast('That account no longer exists'); return; }
     const input = window.prompt(
       'Opening balance for "' + acc.name + '"\n\n' +
       'How much was in this account before you started recording transactions?\n' +
       'Use a minus sign if it was overdrawn.',
       String(acc.openingBalance)
     );
     if (input === null) return;
     const val = clampNumber(input, -MAX_AMOUNT, MAX_AMOUNT);
     acc.openingBalance = round2(val);
     save();
     toast(acc.name + ' opening balance set to ' + formatMoney(val));
   }
   
   function toggleArchiveAccount(id) {
     const acc = findAccount(id);
     if (!acc) { toast('That account no longer exists'); return; }
     if (acc.archived) {
       acc.archived = false;
       save();
       toast(acc.name + ' is active again');
       return;
     }
     const n = countTransactionsForAccount(id);
     const cash = cashAccountId();
     if (id === cash) {
       // The cash account is the migration target for old records, and the balance
       // card is built around it, so it must always exist.
       toast('Cash cannot be archived — every transaction has to land somewhere');
       return;
     }
     if (!confirm(
       'Archive "' + acc.name + '"?\n\n' +
       (n ? n + ' transaction(s) use it. They stay exactly where they are and keep counting towards its balance — the account just stops appearing in the "which account?" dropdowns.\n\n'
           : 'No transactions use it yet.\n\n') +
       'You can bring it back at any time.'
     )) return;
     acc.archived = true;
     save();
     toast('Archived "' + acc.name + '"');
   }
   
   function deleteAccount(id) {
     const acc = findAccount(id);
     if (!acc) { toast('That account no longer exists'); return; }
     if (id === cashAccountId()) { toast('Cash cannot be deleted — every transaction has to land somewhere'); return; }
     const n = countTransactionsForAccount(id);
     const u = state.debts.filter((d) => d.accountId === id).length;
     if (n > 0) {
       toast('"' + acc.name + '" has ' + n + ' transaction(s). Archive it instead — deleting would lose them.');
       return;
     }
     if (u > 0) {
       toast('"' + acc.name + '" is used by ' + u + ' udhaar entr(y/ies). Archive it instead — deleting would leave them dangling.');
       return;
     }
     if (!confirm('Delete "' + acc.name + '"? This cannot be undone.')) return;
     dropRecord('accounts', id);
     if (state.settings.lastAccountId === id) state.settings.lastAccountId = cashAccountId();
     save();
     toast('Deleted "' + acc.name + '"');
   }
   
   /** Merge accounts that share a name (case-insensitive) into one.
    *
    *  How the duplicates in the screenshot happened: a fresh device starts with
    *  the same factory accounts (Cash, NayaPay, Easypaisa) as every other fresh
    *  device. When the laptop signed in, its empty factory rows were stamped as
    *  "new" before the first pull, so the pull kept both copies — the empty local
    *  ones and the real server ones — under different ids but the same names.
    *  sanitizeState() merges same-name accounts on load from disk, but a sync
    *  pull bypasses it, so the pair survived on screen.
    *
    *  The survivor is the account with the most transactions (ties broken by the
    *  higher balance, so an empty shell never eats the real wallet). Losers have
    *  their transactions repointed, their opening balances folded in, and are
    *  removed via dropRecord so the delete tombstones to the server too — the
    *  other device converges on the next cycle instead of re-adding them.
    *  Returns true when something merged. */
   function mergeDuplicateAccounts(opts) {
     const o = opts || {};
     const groups = new Map();
     for (const a of state.accounts || []) {
       if (!a || typeof a.name !== 'string') continue;
       const key = a.name.trim().toLowerCase();
       if (!key) continue;
       if (!groups.has(key)) groups.set(key, []);
       groups.get(key).push(a);
     }
     let merged = 0;
     for (const list of groups.values()) {
       if (list.length < 2) continue;
       let survivor = list[0];
       let bestTx = -1;
       for (const a of list) {
         const n = countTransactionsForAccount(a.id);
         if (n > bestTx) { bestTx = n; survivor = a; }
       }
       const tied = list.filter((a) => countTransactionsForAccount(a.id) === bestTx);
       if (tied.length > 1) {
         tied.sort((x, y) => accountBalance(y.id) - accountBalance(x.id));
         survivor = tied[0];
       }
       for (const a of list) {
         if (a.id === survivor.id) continue;
         for (const t of state.transactions || []) {
           if (!t) continue;
           if (t.accountId === a.id) t.accountId = survivor.id;
           if (t.toAccountId === a.id) t.toAccountId = survivor.id;
         }
         for (const d of state.debts || []) {
           if (d && d.accountId === a.id) d.accountId = survivor.id;
         }
         survivor.openingBalance = round2(
           (Number(survivor.openingBalance) || 0) + (Number(a.openingBalance) || 0));
         if (state.settings && state.settings.lastAccountId === a.id) {
           state.settings.lastAccountId = survivor.id;
         }
         dropRecord('accounts', a.id);
         merged++;
       }
       if (!o.silent && merged) toast('Merged the duplicate "' + survivor.name + '" accounts — nothing was lost');
     }
     if (merged) { save(); return true; }
     return false;
   }
   
   /* ============================================================
      Udhaar partial returns
      ============================================================ */
   
   /** Record that part of an udhaar came back (or was paid back) — the "Return
    *  some" button, working like a part payment rather than an all-or-nothing
    *  settle. The entry keeps the remainder; only the returned slice is written
    *  to the ledger, and only when the entry is balance-tracked. A full return
    *  goes through the normal settle flow so its confirm and ledger link stay
    *  identical. Partial slices carry their own source marker, so settle /
    *  unsettle — which rebuilds only the 'debt:<id>' link — never touches them.
    *  Deleting the entry takes the whole trail (upfront, slices, link) with it. */
   function returnDebtSome(id) {
     const d = state.debts.find((x) => x.id === id);
     if (!d) { toast('That entry is already gone'); return; }
     if (d.settled) { toast('That entry is already settled'); return; }
     const out = d.amount;
   
     const input = window.prompt(
       d.type === 'receive'
         ? 'How much of the ' + formatMoney(out) + ' ' + d.person + ' owes you came back?\n\nEnter less for a part return, or the full amount to settle.'
         : 'How much of the ' + formatMoney(out) + ' you owe ' + d.person + ' are you paying back?\n\nEnter less for a part return, or the full amount to settle.',
       String(out)
     );
     if (input === null) return;
   
     let amount = toPositiveNumber(input);
     if (amount === null) amount = out;   // blank means "all of it"
     if (amount > out) { toast('That is more than the ' + formatMoney(out) + ' still outstanding'); return; }
   
     if (amount >= out) { settleDebt(id); return; }
   
     // The prompt-and-confirm already happened above, so this only moves the
     // money. applyDebtPayment answers 'settled' (amount reached the remainder —
     // not possible here, settleDebt handled it) or 'partial'. Checking for 'ok'
     // matched neither, so a part-return was written to memory and then thrown
     // away without save() — the balance moved on screen and snapped back on
     // reload. Save on every real answer.
     const res = applyDebtPayment(d, amount, debtAccountId(d), debtCategory(d));
     if (res === 'partial' && save()) {
       toast('Recorded ' + formatMoney(amount) + '. ' + formatMoney(d.amount) + ' still outstanding with ' + d.person + '.');
     } else if (res === null) {
       toast('That entry is already settled');
     }
   }
   
   /** File a payment against an open udhaar entry without asking anything.
    *
    *  The prompt-and-confirm lives with the callers (Return-some, Pending
    *  approve); this only moves the money. `category` is where the written rows
    *  file — the debt's own bucket, or the Pending row's picked one when the
    *  payment arrives as a bank email. A full payment settles the entry and
    *  writes the link like settleDebt does but into the given account and without
    *  a confirm — the caller already confirmed by pressing its own button. A
    *  partial payment shrinks the entry and writes the slice. Returns 'settled',
    *  'partial', or null when there was nothing to do. */
   function applyDebtPayment(d, amount, accId, category) {
     if (!d || d.settled) return null;
     if (!(amount > 0) || amount > d.amount) return null;
     const cat = (category && findCategory(category)) ? findCategory(category) : debtCategory(d);
     if (amount >= d.amount) {
       d.settled = true;
       d.settledAt = nowStamp();
       // The money landed here, so the entry now belongs to this account too —
       // the settlement link is written into it by syncLedgerForDebt.
       if (accId && findAccount(accId)) d.accountId = accId;
       syncLedgerForDebt(d, { category: cat });
       return 'settled';
     }
     d.amount = round2(d.amount - amount);
     if (d.ledger) {
       state.transactions.unshift({
         id: newId(),
         type: d.type === 'receive' ? 'income' : 'expense',
         amount,
         category: cat,
         comment: ('Udhaar part return — ' + (d.type === 'receive' ? d.person + ' paid back ' : 'paid ' + d.person + ' ') + formatMoney(amount)).slice(0, COMMENT_LIMIT),
         date: nowStamp(),
         accountId: accId && findAccount(accId) ? accId : debtAccountId(d),
         toAccountId: null,
         source: 'debtpart:' + d.id
       });
     }
     return 'partial';
   }
   
   /* ============================================================
      Categories
      ============================================================ */
   
   function findCategory(name) {
     const key = String(name).toLowerCase();
     return state.categories.find((c) => c.toLowerCase() === key);
   }
   
   /** The Udhaar bucket exists from the first udhaar entry on, for old and new
    *  installs alike: adding it to the defaults only helps fresh states, so the
    *  first entry that needs it creates it (once — afterwards it is just found). */
   function ensureUdhaarCategory() {
     if (!findCategory('Udhaar')) state.categories.push('Udhaar');
     return 'Udhaar';
   }
   
   /** Which bucket an udhaar entry's ledger rows file under: its own category,
    *  or Udhaar when that is gone (deleted since) or was never set. */
   function debtCategory(d) {
     const c = d && typeof d.category === 'string' ? findCategory(d.category) : null;
     if (c) return c;
     return ensureUdhaarCategory();
   }
   
   /** Which account an udhaar entry moves money through: the one picked when it
    *  was added, else the last-used account, else cash. Old entries predate the
    *  picker, so they resolve exactly like settlements always did. */
   function debtAccountId(d) {
     if (d && typeof d.accountId === 'string' && findAccount(d.accountId)) return d.accountId;
     const last = state.settings && state.settings.lastAccountId;
     if (last && findAccount(last)) return last;
     return cashAccountId();
   }
   
   function addCategory(nameInput) {
     const raw = (nameInput.value || '').trim();
     if (!raw) { toast('Enter a category name'); return; }
     if (raw.length > NAME_LIMIT) { toast('Category names are limited to ' + NAME_LIMIT + ' characters'); return; }
     if (/[<>&"']/.test(raw)) { toast('Category names cannot contain < > & " or \''); return; }
     if (findCategory(raw)) { toast('"' + raw + '" already exists'); return; }
   
     state.categories.push(raw);
     nameInput.value = '';
     save();
     toast('Added "' + raw + '"');
   }
   
   function removeCategory(name) {
     const match = findCategory(name);
     if (!match) { toast('That category no longer exists'); return; }
   
     if (state.categories.length <= 1) {
       toast('You need at least one category to file transactions under.');
       return;
     }
   
     const used = state.transactions.filter((t) => t.category.toLowerCase() === match.toLowerCase()).length;
     const budgetMonths = Object.keys(state.budgets).filter((p) => Object.prototype.hasOwnProperty.call(state.budgets[p], match));
   
     let msg = 'Delete the category "' + match + '"?';
     if (used > 0) {
       msg += '\n\n' + used + ' transaction(s) are filed under it. They will KEEP "' + match + '" — it will just no longer appear in dropdowns, and editing one will offer it back as a removed category.';
     }
     if (budgetMonths.length) {
       msg += '\n\nIts budget will be removed for: ' + budgetMonths.map(periodLabel).join(', ') + '.';
     }
     if (!confirm(msg)) return;
   
     state.categories = state.categories.filter((c) => c.toLowerCase() !== match.toLowerCase());
     for (const p of budgetMonths) delete state.budgets[p][match];
     delete state.settings.budgetOffset[match.toLowerCase()];
     save();
     toast('Deleted "' + match + '"');
   }
   
   /** Move a category up or down in Manage Categories. Every dropdown in the app
    *  is built from state.categories in order, so the order set here is the order
    *  seen everywhere — new entries land at the end until moved. */
   function moveCategory(name, dir) {
     const i = state.categories.findIndex((c) => c.toLowerCase() === String(name).toLowerCase());
     if (i === -1) return;
     const j = dir < 0 ? i - 1 : i + 1;
     if (j < 0 || j >= state.categories.length) return;
     const tmp = state.categories[i];
     state.categories[i] = state.categories[j];
     state.categories[j] = tmp;
     save();
   }
   
   /** Drop a dragged category before another. Same storage, same dropdowns. */
   function moveCategoryBefore(dragged, target) {
     const from = state.categories.findIndex((c) => c.toLowerCase() === String(dragged).toLowerCase());
     const to = state.categories.findIndex((c) => c.toLowerCase() === String(target).toLowerCase());
     if (from === -1 || to === -1 || from === to) return;
     const item = state.categories.splice(from, 1)[0];
     state.categories.splice(from < to ? to - 1 : to, 0, item);
     save();
   }
   
   let dragCatName = null;
   
   /* ============================================================
      Budgets
      ============================================================ */
   
   function budgetsFor(period) {
     const p = period || currentPeriod();
     if (!Object.prototype.hasOwnProperty.call(state.budgets, p)) {
       state.budgets[p] = Object.create(null);
     }
     return state.budgets[p];
   }
   
   function offsetOn(cat) { return state.settings.budgetOffset[String(cat).toLowerCase()] === true; }
   
   function setOffset(cat, on) {
     const key = String(cat).toLowerCase();
     if (on) state.settings.budgetOffset[key] = true;
     else delete state.settings.budgetOffset[key];
   }
   
   function activeBudgetPeriod() { return budgetPeriod || currentPeriod(); }
   
   function setBudget() {
     const period = activeBudgetPeriod();
     const cat = $('budgetCategory').value;
     if (!cat) { toast('Choose a category first'); return; }
     const amount = readAmountField($('budgetAmount'), 'Budget');
     if (amount.error) { toast(amount.error); return; }
   
     pushUndo('Budget set for ' + cat);
     budgetsFor(period)[cat] = amount.value;
     $('budgetAmount').value = '';
     if (save()) toast('Budget set for ' + cat + ' in ' + periodLabel(period), { label: 'Undo', fn: undoLast });
   }
   
   function removeBudget(cat) {
     const period = activeBudgetPeriod();
     if (!Object.prototype.hasOwnProperty.call(budgetsFor(period), cat)) return;
     if (!confirm('Remove the budget for "' + cat + '" in ' + periodLabel(period) + '?')) return;
     pushUndo('Budget removed for ' + cat);
     delete state.budgets[period][cat];
     if (save()) toast('Budget removed for ' + cat, { label: 'Undo', fn: undoLast });
   }
   
   /** Copy the previous month's limits into the month being viewed — but only
    *  where nothing is set yet. Existing limits always win, so repeating can
    *  never silently overwrite a number already chosen for this month. It only
    *  ever adds, which is why it needs no confirm: there is nothing to lose. */
   function repeatLastMonthBudgets() {
     const target = activeBudgetPeriod();
     const prev = previousPeriod(target);
     const src = state.budgets[prev];
     if (!src || !Object.keys(src).length) { toast('No budgets in ' + periodLabel(prev) + ' to repeat'); return; }
     const dest = budgetsFor(target);
     let n = 0;
     for (const cat of Object.keys(src)) {
       if (Object.prototype.hasOwnProperty.call(dest, cat)) continue;
       if (!findCategory(cat)) continue;
       dest[cat] = src[cat];
       n++;
     }
     if (!n) { toast('This month already has all of those budgets'); return; }
     if (save()) toast('Repeated ' + n + ' budget(s) from ' + periodLabel(prev));
   }
   
   /** What counted against a budget this month, after moved spending.
    *
    *  Raw spend minus any income offset, minus what this category gave away to
    *  other budgets, plus what it took in. Shared by the row, the summary, the
    *  category bars and the fix dialog, so all four always agree about the same
    *  number. Moves whose endpoint is no longer a live budget (deleted category
    *  or removed limit) are ignored where they stand — kept in data, inert —
    *  so nothing can count under a bucket that no longer exists. */
   function budgetCounted(cat, period) {
     const per = period || activeBudgetPeriod();
     const { start, end } = periodBoundsOf(per);
     const today = endOfToday();
     const windowEnd = end < today ? end : today;
     let base = 0;
     if (start <= windowEnd) {
       const gross = spendByCategory(start, windowEnd).get(cat) || 0;
       const inc = offsetOn(cat) ? (incomeByCategory(start, windowEnd).get(cat) || 0) : 0;
       base = Math.max(0, round2(gross - inc));
     }
     let out = 0;
     let inn = 0;
     for (const m of liveBudgetMoves(per)) {
       if (m.from === cat) out = round2(out + m.amount);
       if (m.to === cat) inn = round2(inn + m.amount);
     }
     return round2(Math.max(0, base - out) + inn);
   }
   
   /** Moves of one month that currently apply: well-formed, positive, and both
    *  ends live budgets of existing categories. Anything else stays stored but
    *  inert — never counted, never shown. */
   function liveBudgetMoves(period) {
     const per = period || activeBudgetPeriod();
     const limits = budgetsFor(per);
     const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
     return ((state.settings && state.settings.budgetMoves) || []).filter((m) =>
       m && typeof m.id === 'string' && typeof m.from === 'string' && typeof m.to === 'string' &&
       typeof m.amount === 'number' && m.amount > 0 &&
       has(limits, m.from) && has(limits, m.to) &&
       !!findCategory(m.from) && !!findCategory(m.to));
   }
   
   /** How much of a budget is still free: limit minus what counted against it
    *  this month, floored at zero. */
   function budgetFreeRoom(cat, period) {
     const per = period || activeBudgetPeriod();
     const limits = budgetsFor(per);
     if (!Object.prototype.hasOwnProperty.call(limits, cat)) return 0;
     return Math.max(0, round2(limits[cat] - budgetCounted(cat, per)));
   }
   
   /** Count `amount` of `cat`'s spending under `toCat` instead, within the month
    *  being viewed.
    *
    *  The over-budget fix that touches nothing but the budget math: Food over by
    *  2,000 with Bills 3,000 free becomes Food 10,000/10,000 counted and Bills
    *  7,000/8,000 — both limits stay exactly where they were, every transaction
    *  keeps its category, reports never change. Guarded both ways: no more than
    *  what the source has counted, no more than the target has free. Pure apart
    *  from the state it edits. Returns '' on success, otherwise the reason. */
   function applyBudgetMove(cat, amount, toCat) {
     const period = activeBudgetPeriod();
     const limits = budgetsFor(period);
     const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
     if (!has(limits, cat)) return 'No budget for "' + cat + '" in ' + periodLabel(period);
     if (!has(limits, toCat)) return 'No budget for "' + toCat + '" in ' + periodLabel(period);
     if (String(cat).toLowerCase() === String(toCat).toLowerCase()) return 'That is the same budget';
     if (!(amount > 0)) return 'Enter an amount to move';
     const counted = budgetCounted(cat, period);
     if (amount > counted) return 'Only ' + formatMoney(counted) + ' is counted under "' + cat + '"';
     const free = budgetFreeRoom(toCat, period);
     if (amount > free) return 'Only ' + formatMoney(free) + ' is free in "' + toCat + '"';
     if (!Array.isArray(state.settings.budgetMoves)) state.settings.budgetMoves = [];
     state.settings.budgetMoves.push({ id: newId(), period, from: cat, to: toCat, amount: round2(amount) });
     return '';
   }
   
   /** Undo one counted-spending move. Always safe: removing a move only restores
    *  the raw counts underneath. */
   function undoBudgetMove(id) {
     const moves = (state.settings && state.settings.budgetMoves) || [];
     const hit = moves.find((m) => m && m.id === id);
     if (!hit) { toast('That move is already gone'); return; }
     state.settings.budgetMoves = moves.filter((m) => m.id !== id);
     if (save()) toast('Back to counting under "' + hit.from + '"');
   }
   
   /** Open the fix dialog for one over-budget row: an amount field (prefilled
    *  with exactly the over amount) plus every other budget showing its free
    *  room — pick one, save, done. No typing names, no prompts, no transaction
    *  ever touched. */
   function openBudgetFix(cat) {
     const period = activeBudgetPeriod();
     const limits = budgetsFor(period);
     if (!Object.prototype.hasOwnProperty.call(limits, cat)) return;
     const over = Math.max(0, round2(budgetCounted(cat, period) - limits[cat]));
     const options = Object.keys(limits)
       .filter((c) => c.toLowerCase() !== String(cat).toLowerCase())
       .map((c) => ({ name: c, free: budgetFreeRoom(c, period) }))
       .filter((o) => o.free > 0);
     if (!options.length) { toast('No other budget has free room in ' + periodLabel(period)); return; }
     $('budgetFixCat').value = cat;
     const amt = $('budgetFixAmount');
     amt.value = over > 0 ? String(over) : '';
     amt.placeholder = over > 0 ? String(over) : 'Amount to move';
     $('budgetFixSub').textContent =
       '"' + cat + '" is over by ' + formatMoney(over) + ' in ' + periodLabel(period) +
       '. Count part of it under another budget instead — limits, transactions and reports stay exactly as they are.';
     const sel = $('budgetFixTo');
     mount(sel, options.map((o) => h('option', { value: o.name }, o.name + ' — ' + formatMoney(o.free) + ' free')));
     openModal('budgetFixModal');
   }
   
   /** Apply the fix dialog: one Save records the move, nothing else. */
   function saveBudgetFix() {
     const cat = $('budgetFixCat').value;
     const toCat = $('budgetFixTo').value;
     const amount = toPositiveNumber($('budgetFixAmount').value);
     const err = applyBudgetMove(cat, amount === null ? 0 : amount, toCat);
     if (err) { toast(err); return; }
     closeModal('budgetFixModal');
     if (save()) toast(formatMoney(amount) + ' now counts under "' + toCat + '"');
   }
   
   function changeBudgetPeriod(period) {
     budgetPeriod = PERIOD_RE.test(String(period)) ? period : null;
     renderAll();
   }
   
   /* ============================================================
      Transactions
      ============================================================ */
   
   /** Stamp a record as just-edited. The sync engine turns this into the
    *  last-write-wins ordering, so every mutation must go through here. */
   function touch(record) {
     if (window.CashFlowSync) record.updatedAt = window.CashFlowSync.touch();
     return record;
   }
   
   /** Remove a record and leave a tombstone, so the delete reaches other
    *  devices instead of the row coming back on the next pull. */
   function dropRecord(table, id) {
     if (window.CashFlowSync) window.CashFlowSync.markDeleted(table, id);
     state[table] = (state[table] || []).filter((r) => r.id !== id);
   }
   
   function readAmountField(input, label) {
     const raw = String(input.value == null ? '' : input.value).trim().replace(/,/g, '');
     if (raw === '') return { error: label + ' is required' };
     const n = evalAmountExpr(raw);
     if (!Number.isFinite(n)) return { error: label + ' must be a number or a sum like 120+80' };
     if (n <= 0) return { error: label + ' must be more than zero' };
     if (n > MAX_AMOUNT) return { error: label + ' is too large' };
     return { value: round2(n) };
   }
   
   /** Build a transaction from the Home form. Also used by the edit modal, so the
    *  validation lives in one place and a saved record can never be shaped
    *  differently depending on which form it came through. */
   /** What a `source` marker means, in words.
    *
    *  There are three kinds and only one of them is an udhaar entry, so the old
    *  two-way test labelled every non-list source "linked to an udhaar entry" — a
    *  bank payment arrived labelled as one. A wrong claim about where a record came
    *  from is worse than no claim: it sends someone looking for an udhaar entry
    *  that does not exist, and hides the one thing that is actually true, which is
    *  that this was read out of an email. */
   function sourceLabel(source) {
     const s = String(source || '');
     if (s.indexOf('list:') === 0) return 'bought from your list';
     if (s.indexOf('email:') === 0) return 'read from your bank’s email';
     if (s.indexOf('debtpart:') === 0) return 'udhaar part return';
     if (s.indexOf('udhaar:') === 0) return 'linked to an udhaar entry';
     if (s.indexOf('debt:') === 0) return 'linked to an udhaar entry';
     return 'added another way';
   }
   
   function buildTransaction(type, amount, category, comment, date, fromId, toId) {
     if (type === 'transfer') {
       if (fromId === toId) return { error: 'Pick two different accounts to move money between' };
       return {
         value: {
           id: newId(),
           type: 'transfer',
           amount,
           // No category on purpose: a transfer is not spending, and filing it
           // under one would corrupt that category's budget.
           category: '',
           comment,
           date,
           accountId: fromId,
           toAccountId: toId,
           source: undefined
         }
       };
     }
     if (!findAccount(fromId)) return { error: 'Choose which account this was paid from or into' };
     return {
       value: {
         id: newId(),
         type: type === 'income' ? 'income' : 'expense',
         amount,
         category,
         comment,
         date,
         accountId: fromId,
         toAccountId: null,
         source: undefined
       }
     };
   }
   
   function addTransaction() {
     const amount = readAmountField($('txAmount'), 'Amount');
     if (amount.error) { toast(amount.error); return; }
   
     const type = ['income', 'expense', 'transfer'].indexOf($('txType').value) !== -1 ? $('txType').value : 'expense';
     const fromId = $('txAccount').value;
     const toId = $('txToAccount').value;

     // Split expense, validated with the other form values so a bad names line
     // fails before anything is written. Each name becomes its own "owes me"
     // udhaar entry for an even share; the user's share stays with the expense.
     const splitNames = $('txSplitOn') && $('txSplitOn').checked && type === 'expense'
       ? splitNameList($('txSplitNames') ? $('txSplitNames').value : '')
       : [];
     if ($('txSplitOn') && $('txSplitOn').checked && type !== 'expense') {
       toast('Splitting works for expenses only — switched off for this save.');
       $('txSplitOn').checked = false;
       setHiddenSplit(false);
     }
     if (splitNames.length > 15) { toast('Splitting is limited to 15 people'); return; }
   
     const built = buildTransaction(
       type,
       amount.value,
       $('txCategory').value,
       cleanText($('txComment').value, COMMENT_LIMIT),
       inputToStamp($('txDate').value),
       fromId,
       toId
     );
     if (built.error) { toast(built.error); return; }
   
     pushUndo('Transaction saved');
     state.transactions.unshift(built.value);
     state.settings.lastAccountId = fromId;
   
     let share = 0;
     if (splitNames.length) {
       // Each named person gets an even share; the user's own share is what
       // the expense above already spent. Ledger stays false: the money left
       // with the expense, these are records of who owes what back.
       const splitCat = ensureUdhaarCategory();
       share = round2(amount.value / (splitNames.length + 1));
       for (const name of splitNames) {
         state.debts.push({
           id: newId(),
           type: 'receive',
           person: name,
           amount: share,
           note: cleanText('Split share' + (built.value.comment ? ' of ' + built.value.comment : ''), COMMENT_LIMIT),
           date: built.value.date,
           settled: false,
           settledAt: null,
           ledger: false,
           accountId: null,
           category: splitCat
         });
       }
     }
     $('txAmount').value = '';
     $('txComment').value = '';
     $('txType').value = 'expense';
     $('txDate').value = stampToInput(nowStamp());
     resetSplitInputs();
     setTxTypeFields();
     // No focus() here on purpose: after saving, no field re-activates itself —
     // the keyboard popping back up uninvited is the complaint this removes.
   
     if (!save()) return;
     toast(type === 'transfer'
       ? 'Moved ' + formatMoney(amount.value) + ' from ' + accountName(fromId) + ' to ' + accountName(toId)
       : (splitNames.length
         ? 'Split into ' + (splitNames.length + 1) + ' shares of ' + formatMoney(share) + ' — see Udhaar'
         : 'Transaction saved'), { label: 'Undo', fn: undoLast });
   }
   
   /** Show only the fields that apply to the selected type. A transfer has no
    *  category, so showing an unused dropdown there would invite a wrong filing. */
   function setTxTypeFields() {
     const isTransfer = $('txType').value === 'transfer';
     const setHidden = (id, hidden) => { const e = $(id); if (e) e.hidden = hidden; };
   
     setHidden('txCategoryGroup', isTransfer);
     setHidden('txToAccountGroup', !isTransfer);
     setHidden('txAccountGroup', false);
     const splitGroup = $('txSplitGroup');
     if (splitGroup) {
       const expense = $('txType').value === 'expense';
       splitGroup.hidden = !expense;
       if (!expense) setHiddenSplit(true);
     }
     if (isTransfer) {
       const to = $('txToAccount');
       const from = $('txAccount');
       if (to && from && to.value === from.value) {
         // Default the destination to something that is not the source.
         const other = Array.from(to.options).find((o) => o.value !== from.value);
         if (other) to.value = other.value;
       }
       const label = $('txAccountLabel');
       if (label) label.textContent = 'From account';
     } else {
       const label = $('txAccountLabel');
       if (label) label.textContent = 'Account';
     }
     if (isTransfer) {
       const sub = $('txTransferNote');
       if (sub) sub.hidden = false;
     } else {
       const sub = $('txTransferNote');
       if (sub) sub.hidden = true;
     }
   }
   
   function deleteTransaction(id) {
     const tx = state.transactions.find((t) => t.id === id);
     if (!tx) { toast('That transaction is already gone'); return; }
     const what = tx.type === 'transfer'
       ? 'transfer of ' + formatMoney(tx.amount) + ' from ' + accountName(tx.accountId) + ' to ' + accountName(tx.toAccountId)
       : tx.type + ' of ' + formatMoney(tx.amount);
     if (!confirm('Delete this ' + what + '?')) return;
     pushUndo('Transaction deleted');
     dropRecord('transactions', id);
     if (save()) toast('Transaction deleted', { label: 'Undo', fn: undoLast });
   }
   
   /* ---------- transaction edit modal ---------- */
   
   /** Show/hide the modal's category and destination-account rows. Mirrors
    *  setTxTypeFields so the two forms behave identically. */
   function setEditTypeFields() {
     const isTransfer = $('editType').value === 'transfer';
     const setHidden = (id, hidden) => { const e = $(id); if (e) e.hidden = hidden; };
     setHidden('editCategoryGroup', isTransfer);
     setHidden('editToAccountGroup', !isTransfer);
     setHidden('editAccountGroup', false);
     const label = $('editAccountLabel');
     if (label) label.textContent = isTransfer ? 'From account' : 'Account';
   }
   
   function openEditModal(id) {
     const tx = state.transactions.find((t) => t.id === id);
     if (!tx) { toast('That transaction no longer exists'); return; }
     $('editId').value = tx.id;
     $('editType').value = tx.type;
     $('editAmount').value = tx.amount;
     // Keep the original category selectable even if it was deleted, so saving
     // cannot silently re-file the record under a different category.
     fillCategorySelect($('editCategory'), { selected: tx.category, orphans: tx.category ? [tx.category] : [] });
     fillAccountSelect($('editAccount'), { selected: tx.accountId });
     fillAccountSelect($('editToAccount'), { selected: tx.toAccountId || undefined });
     $('editComment').value = tx.comment || '';
     $('editDate').value = stampToInput(tx.date);
     setEditTypeFields();
     openModal('editModal');
   }
   
   function saveEdit() {
     const id = $('editId').value;
     const tx = state.transactions.find((t) => t.id === id);
     if (!tx) { closeModal('editModal'); toast('That transaction no longer exists'); return; }
   
     const amount = readAmountField($('editAmount'), 'Amount');
     if (amount.error) { toast(amount.error); return; }
   
     const type = ['income', 'expense', 'transfer'].indexOf($('editType').value) !== -1 ? $('editType').value : 'expense';
     if (type === 'transfer' && $('editAccount').value === $('editToAccount').value) {
       toast('Pick two different accounts to move money between');
       return;
     }
     if (type !== 'transfer' && !findAccount($('editAccount').value)) {
       toast('Choose which account this was paid from or into');
       return;
     }
   
     // A record generated from a settled udhaar entry must be changed at the
     // udhaar entry, not here: syncLedgerForDebt() deletes and regenerates it on
     // every settlement change, so an edit made here would be silently discarded
     // the next time that debt is touched.
     //
     // Checked BEFORE any mutation. This used to sit after the assignments below,
     // where the early return left the live object half-edited in memory — the
     // next unrelated save() would then write the "rejected" edit to disk anyway.
     //
     // Only 'debt:' is guarded. 'list:' and 'email:' records are ordinary
     // standalone entries that nothing regenerates, so refusing to edit them would
     // just be an obstacle.
     if (typeof tx.source === 'string' && tx.source.indexOf('debt:') === 0) {
       closeModal('editModal');
       toast('This one came from a udhaar settlement. Change the udhaar entry, so the two stay in step.');
       return;
     }
   
     tx.type = type;
     tx.amount = amount.value;
     tx.category = type === 'transfer' ? '' : $('editCategory').value;
     tx.comment = cleanText($('editComment').value, COMMENT_LIMIT);
     tx.date = inputToStamp($('editDate').value);
     tx.accountId = $('editAccount').value;
     tx.toAccountId = type === 'transfer' ? $('editToAccount').value : null;
     touch(tx);
   
     closeModal('editModal');
     if (save()) toast('Transaction updated');
   }
   
   /* ============================================================
      Udhaar
      ============================================================ */
   
   async function addDebt() {
     const person = cleanText($('debtPerson').value, NAME_LIMIT);
     if (!person) { toast('Enter the person’s name'); return; }
     const amount = readAmountField($('debtAmount'), 'Amount');
     if (amount.error) { toast(amount.error); return; }
     const type = $('debtType').value === 'pay' ? 'pay' : 'receive';
     // Account is optional: picked means the money can move through it, empty
     // means this only records the debt (an old one, or money handled outside any
     // account) and the movement — if any — happens on settle.
     const accPick = $('debtAccount').value;
     const accId = accPick && findAccount(accPick) ? accPick : null;
     // Category is optional too: whatever the entry — and its later settlement —
     // files under. Defaults to the Udhaar bucket.
     const catPick = $('debtCategory') && $('debtCategory').value;
     const category = (catPick && findCategory(catPick)) ? findCategory(catPick) : ensureUdhaarCategory();
   
     // Money must never move on its own. With an account picked the user decides,
     // right here, whether this is a real movement through that account or just a
     // record — no silent +/- on the balance. With no account there is nothing to
     // move through, so only the record lands and no question is asked.
     let moveNow = false;
     if (accId) {
       const choice = await askChoice(
         'Add udhaar',
         (type === 'receive' ? person + ' owes you ' : 'You owe ' + person + ' ') + formatMoney(amount.value) +
           '. Move it through ' + accountName(accId) + ' now, or just record the udhaar?',
         [
           {
             value: 'move', kind: 'primary',
             label: 'Move ' + formatMoney(amount.value) + ' ' + (type === 'receive' ? 'out of ' : 'into ') + accountName(accId)
           },
           { value: 'record', label: 'Just record — no money moves' }
         ]
       );
       if (choice === null) return;          // cancelled: nothing is written
       moveNow = choice === 'move';
     }
     const ledger = moveNow;
   
     pushUndo('Udhaar entry added');
     const d = {
       id: newId(),
       type,
       person,
       amount: amount.value,
       note: cleanText($('debtNote').value, COMMENT_LIMIT),
       date: nowStamp(),
       settled: false,
       settledAt: null,
       ledger,
       accountId: accId,
       category
     };
     state.debts.push(d);
   
     // Lending pays out of the account immediately, borrowing lands in it. Settle
     // later records the reverse, so the two always net out and no second manual
     // entry is ever needed. Only when the user just above asked for the movement.
     if (ledger && accId) {
       state.transactions.unshift({
         id: newId(),
         type: type === 'receive' ? 'expense' : 'income',
         amount: amount.value,
         category,
         comment: (type === 'receive' ? 'Lent to ' + person : 'Borrowed from ' + person).slice(0, COMMENT_LIMIT),
         date: d.date,
         accountId: accId,
         toAccountId: null,
         source: 'debtout:' + d.id
       });
       state.settings.lastAccountId = accId;
     }
   
     $('debtPerson').value = '';
     $('debtAmount').value = '';
     $('debtNote').value = '';
     // No focus() here on purpose — see addTransaction.
   
     if (save()) toast(!ledger
       ? 'Udhaar recorded (no money moved)'
       : accId
         ? 'Udhaar added — ' + formatMoney(amount.value) + (type === 'receive' ? ' out of ' : ' into ') + accountName(accId)
         : 'Udhaar added — no money moved yet');
   }
   
   async function deleteDebt(id) {
     const d = state.debts.find((x) => x.id === id);
     if (!d) { toast('That entry is already gone'); return; }
   
     const choice = await askChoice(
       'Delete udhaar',
       'Delete ' + d.person + '’s ' + formatMoney(d.amount) + ' entry. Also remove the money entries it wrote (upfront, part-returns, settle), or only delete the udhaar record?',
       [
         { value: 'all', kind: 'danger', label: 'Delete udhaar and its money entries' },
         { value: 'record', label: 'Only delete the udhaar record' }
       ]
     );
     if (choice === null) return;
   
     pushUndo('Udhaar entry deleted');
     dropRecord('debts', id);
     if (choice === 'all') {
       syncLedgerForDebt(d, { forceRemove: true });
       // The upfront entry and any part-return slices are real movements this
       // entry caused — deleting the entry takes its whole trail with it, on
       // every device.
       state.transactions.filter((t) => t.source === 'debtout:' + id || String(t.source || '').indexOf('debtpart:' + id) === 0)
         .forEach((t) => dropRecord('transactions', t.id));
     }
     if (save()) toast('Udhaar deleted');
   }
   
   async function settleDebt(id) {
     const d = state.debts.find((x) => x.id === id);
     if (!d) { toast('That entry is already gone'); return; }
   
     // Settling can either move the money back (a real ledger entry in the
     // account it went through) or only close the record. Both are legitimate —
     // sometimes the cash already changed hands outside the app — so the user
     // picks, instead of the ledger being written behind their back.
     if (d.settled) {
       const choice = await askChoice(
         'Un-settle udhaar',
         'Un-settling ' + d.person + '’s ' + formatMoney(d.amount) + '. Remove the settled money entry from your balance, or only reopen the record?',
         [
           { value: 'ledger', kind: 'primary', label: 'Remove the money entry too' },
           { value: 'record', label: 'Only reopen the record' }
         ]
       );
       if (choice === null) return;
       d.settled = false;
       d.settledAt = null;
       // A record-only reopen leaves the settle entry in place as plain money;
       // the ledger path drops it through the normal linked-entry cleanup.
       if (choice === 'ledger') syncLedgerForDebt(d);
       if (save()) toast('Marked as unsettled');
       return;
     }
   
     const accId = debtAccountId(d);
     const choice = await askChoice(
       'Settle udhaar',
       'Settle ' + d.person + '’s ' + formatMoney(d.amount) + '. Record it in ' + accountName(accId) + ' as ' +
         (d.type === 'receive' ? 'income' : 'an expense') + ', or only close the record (no money moves)?',
       [
         { value: 'ledger', kind: 'primary', label: 'Record ' + formatMoney(d.amount) + ' in ' + accountName(accId) },
         { value: 'record', label: 'Only close the record' }
       ]
     );
     if (choice === null) return;
   
     d.settled = true;
     d.settledAt = nowStamp();
     if (choice === 'ledger') {
       d.ledger = true;
       syncLedgerForDebt(d);
     }
     if (save()) toast('Marked as settled');
   }
   
   /**
    * Keep the ledger in step with a debt. Idempotent: any previously linked
    * transaction is removed first, so toggling settle twice cannot duplicate it.
    * Only the 'debt:' link is rebuilt here — the upfront 'debtout:' entry from
    * adding, and any 'debtpart:' slices, are real movements and stay put.
    */
   function syncLedgerForDebt(d, opts) {
     const o = opts || {};
     const marker = 'debt:' + d.id;
     // Drop the previously linked entry, leaving a tombstone so the removal
     // also reaches other devices rather than the old row reappearing.
     state.transactions.filter((t) => t.source === marker)
       .forEach((t) => dropRecord('transactions', t.id));
     if (o.forceRemove) return;
     if (!d.settled || !d.ledger) return;
     // The settlement lands in the SAME account the entry went through — money
     // lent out of NayaPay comes back into NayaPay, not into whatever was used
     // last. Old entries predate the picker and resolve the old way.
     const accId = debtAccountId(d);
     state.transactions.unshift({
       id: newId(),
       type: d.type === 'receive' ? 'income' : 'expense',
       amount: d.amount,
       category: (o.category && findCategory(o.category)) ? findCategory(o.category) : debtCategory(d),
       comment: ('Udhaar settled — ' + (d.type === 'receive' ? d.person + ' paid me back' : 'I paid ' + d.person)).slice(0, COMMENT_LIMIT),
       date: d.settledAt || nowStamp(),
       accountId: accId,
       toAccountId: null,
       source: marker
     });
   }
   
   /* ---------- debt edit modal ---------- */
   
   function openDebtEditModal(id) {
     const d = state.debts.find((x) => x.id === id);
     if (!d) { toast('That entry no longer exists'); return; }
     $('editDebtId').value = d.id;
     $('editDebtType').value = d.type;
     $('editDebtPerson').value = d.person;
     $('editDebtAmount').value = d.amount;
     $('editDebtNote').value = d.note || '';
     $('editDebtLedger').checked = d.ledger;
     openModal('editDebtModal');
   }
   
   function saveDebtEdit() {
     const id = $('editDebtId').value;
     const d = state.debts.find((x) => x.id === id);
     if (!d) { closeModal('editDebtModal'); toast('That entry no longer exists'); return; }
   
     const person = cleanText($('editDebtPerson').value, NAME_LIMIT);
     if (!person) { toast('Enter the person’s name'); return; }
     const amount = readAmountField($('editDebtAmount'), 'Amount');
     if (amount.error) { toast(amount.error); return; }
   
     const ledgerChanged = d.ledger !== $('editDebtLedger').checked;
     d.type = $('editDebtType').value === 'pay' ? 'pay' : 'receive';
     d.person = person;
     d.amount = amount.value;
     d.note = cleanText($('editDebtNote').value, COMMENT_LIMIT);
     d.ledger = $('editDebtLedger').checked;
   
     // Re-link the ledger entry if the amount/direction/ledger flag changed, so a
     // settled debt's balance effect never disagrees with the record.
     if (ledgerChanged || d.settled) syncLedgerForDebt(d);
   
     // The upfront entry from adding is real money too: if the amount was edited,
     // follow it instead of leaving a stale figure behind.
     if (d.ledger) {
       const upfront = state.transactions.find((t) => t.source === 'debtout:' + d.id);
       if (upfront && upfront.amount !== d.amount) {
         upfront.amount = d.amount;
         upfront.type = d.type === 'receive' ? 'expense' : 'income';
         touch(upfront);
       }
     } else {
       state.transactions.filter((t) => t.source === 'debtout:' + d.id)
         .forEach((t) => dropRecord('transactions', t.id));
     }
   
     closeModal('editDebtModal');
     if (save()) toast('Udhaar updated');
   }
   
   /* ============================================================
      Shopping list
      ============================================================ */
   
   function addListItem() {
     const input = $('itemName');
     const name = cleanText(input.value, ITEM_LIMIT);
     if (!name) { toast('Enter something to buy'); return; }
     // Only an open item counts as a duplicate. A bought item may well be bought
     // again next week, and blocking that would quietly lose the entry.
     const dupe = state.shopping.find((s) => !s.checked && s.name.toLowerCase() === name.toLowerCase());
     if (dupe) { toast('"' + name + '" is already on the list'); return; }
   
     state.shopping.push({
       id: newId(),
       name,
       qty: cleanText($('itemQty').value, QTY_LIMIT),
       note: cleanText($('itemNote').value, COMMENT_LIMIT),
       checked: false,
       createdAt: nowStamp(),
       checkedAt: null,
       boughtTxId: null,
       cost: null
     });
   
     // Clear every field, so a repeated entry does not inherit the previous
     // quantity or note. No focus() here on purpose — see addTransaction.
     input.value = '';
     $('itemQty').value = '';
     $('itemNote').value = '';
     save();
   }
   
   function toggleListItem(id) {
     const item = state.shopping.find((s) => s.id === id);
     if (!item) { toast('That item is no longer on the list'); return; }
     item.checked = !item.checked;
     item.checkedAt = item.checked ? nowStamp() : null;
     if (!item.checked) { item.boughtTxId = null; item.cost = null; }
     save();
   }
   
   function deleteListItem(id) {
     const item = state.shopping.find((s) => s.id === id);
     if (!item) { toast('That item is no longer on the list'); return; }
     dropRecord('shopping', id);
     if (save()) toast('Removed "' + item.name + '"');
   }
   
   /** Turn every ticked item into one real expense, so the list and the balance
    *  can never disagree. The cost is split evenly across the ticked items purely
    *  for display; the expense itself keeps the exact amount entered. */
   function saveListPurchase() {
     const ticked = state.shopping.filter((s) => s.checked);
     if (!ticked.length) { toast('Tick at least one item first'); return; }
   
     const cost = readAmountField($('itemCost'), 'Amount');
     if (cost.error) { toast(cost.error); return; }
   
     const cat = findCategory('Groceries') ? 'Groceries' : (state.categories[0] || 'Other');
     const names = ticked.map((s) => s.name + (s.qty ? ' × ' + s.qty : ''));
     const accId = $('itemAccount').value && findAccount($('itemAccount').value)
       ? $('itemAccount').value
       : (state.settings.lastAccountId || cashAccountId());
     const tx = {
       id: newId(),
       type: 'expense',
       amount: cost.value,
       category: cat,
       comment: ('List: ' + names.join(', ')).slice(0, COMMENT_LIMIT),
       date: nowStamp(),
       accountId: accId,
       toAccountId: null,
       source: 'list:bulk'
     };
     state.transactions.unshift(tx);
   
     for (const s of ticked) {
       s.boughtTxId = tx.id;
       s.cost = round2(cost.value / ticked.length);
     }
   
     $('itemCost').value = '';
     save();
     toast('Saved ' + formatMoney(cost.value) + ' as ' + cat + ' for ' + ticked.length + ' item(s)');
   }
   
   function clearCheckedItems() {
     const n = state.shopping.filter((s) => s.checked).length;
     if (!n) { toast('Nothing ticked yet'); return; }
     if (!confirm('Remove ' + n + ' ticked item(s) from the list? The transactions they created are NOT deleted.')) return;
     for (const s of state.shopping.filter((x) => x.checked)) dropRecord('shopping', s.id);
     if (save()) toast('Cleared ' + n + ' item(s)');
   }
   
   /** Bring the shopping list into a new month.
    *
    *  Items are entered once and act as a standing list: when the calendar month
    *  changes, every item comes back unticked — bought flags, costs and expense
    *  links are cleared, the items themselves stay. Nothing is deleted (so the
    *  old expense entries in Records are untouched) and nothing has to be typed
    *  again. Returns true when anything changed, so callers know to persist.
    *  A file from before this existed carries no period and is stamped silently
    *  instead of wiped — upgrading must never clear the current ticks. */
   function maybeResetShopping() {
     if (!state.settings) return false;
     const cur = currentPeriod();
     const last = state.settings.shoppingPeriod;
     if (last === cur) return false;
     const rollover = typeof last === 'string' && PERIOD_RE.test(last) && last < cur;
     if (rollover) {
       for (const s of state.shopping || []) {
         s.checked = false;
         s.checkedAt = null;
         s.boughtTxId = null;
         s.cost = null;
       }
     }
     state.settings.shoppingPeriod = cur;
     return true;
   }
   
   /* ============================================================
      Notes + Timers (one tab, two sections)
      ============================================================ */
   
   /* Sticky-note looks. Only the class suffix is stored; anything outside this
      list falls back to yellow on the way in (see sanitizeState), so a foreign
      file can never inject an arbitrary class name. */
   const NOTE_COLORS = ['yellow', 'pink', 'green', 'blue', 'purple'];
   const NOTE_ICONS = ['📝', '⏱', '🏠', '💊', '🏋', '📚', '💰', '✈'];
   
   /** ms since a timer started. Timers never pause — there is no paused state to
    *  keep honest — so this is just now minus start. Pure in its inputs, so tests
    *  can pin the maths without waiting on a clock. */
   function timerElapsed(t, nowMs) {
     const now = typeof nowMs === 'number' ? nowMs : Date.now();
     return Math.max(0, now - (Number(t.startedAt) || now));
   }
   
   /** 90061000 -> "1d 01:01:01". Days are shown only past the first 24 hours,
    *  so a fresh timer reads like a stopwatch, not a calendar. */
   function formatElapsed(ms) {
     const s = Math.max(0, Math.floor(ms / 1000));
     const days = Math.floor(s / 86400);
     const p = (x) => String(x).padStart(2, '0');
     const clock = p(Math.floor((s % 86400) / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
     return (days > 0 ? days + 'd ' : '') + clock;
   }
   
   function findNote(id) { return (state.settings.notes || []).find((x) => x.id === id) || null; }
   function findTimer(id) { return (state.settings.timers || []).find((x) => x.id === id) || null; }
   
   /* ---------- timers ---------- */
   
   function addTimer() {
     const label = cleanText($('timerLabel').value, TIMER_LABEL_LIMIT);
     if (!label) { toast('Give the timer a short label'); return; }
     // Optional "counts from": backdate the moment being counted (e.g. "when I
     // last left home"), defaulting to right now. The future is clamped, not
     // trusted — a timer counting down from tomorrow is a bug, not a feature.
     let start = Date.now();
     const raw = $('timerStart') && $('timerStart').value;
     if (raw) {
       const d = new Date(raw);
       if (!Number.isNaN(d.getTime())) start = Math.min(d.getTime(), Date.now());
     }
     state.settings.timers.push({ id: newId(), label, startedAt: start });
     $('timerLabel').value = '';
     if ($('timerStart')) $('timerStart').value = '';
     // No focus() here on purpose — see addTransaction.
     if (save()) { tickTimers(); toast('Timer started'); }
   }
   
   function resetTimer(id) {
     const t = findTimer(id);
     if (!t) { toast('That timer is already gone'); return; }
     t.startedAt = Date.now();
     if (save()) { tickTimers(); toast('Timer restarted'); }
   }
   
   function deleteTimer(id) {
     const t = findTimer(id);
     if (!t) { toast('That timer is already gone'); return; }
     if (!confirm('Delete the timer "' + t.label + '"?')) return;
     state.settings.timers = state.settings.timers.filter((x) => x.id !== id);
     if (save()) toast('Timer deleted');
   }
   
   function renderTimers() {
     const list = $('timersList');
     if (!list) return;
     const timers = state.settings.timers || [];
     if (!timers.length) {
       mount(list, h('div', { class: 'empty-state' }, 'No timers running. Start one above — e.g. the day you left home.'));
       return;
     }
     // Oldest first: the longest-running moment is the one you check most.
     const sorted = timers.slice().sort((a, b) =>
       (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : 1));
     mount(list, sorted.map((t) => {
       const ms = timerElapsed(t);
       return h('div', { class: 'timer-item' },
         h('div', {
           class: 'timer-digits',
           dataset: { timerElapsed: t.id },
           title: '≈ ' + (ms / 86400000).toFixed(1) + ' days'
         }, formatElapsed(ms)),
         h('div', { class: 'timer-label' }, t.label),
         // Device-local, like every other date in the app: the moment as you
         // experienced it, not a UTC instant to convert in your head.
         h('div', { class: 'note-meta' }, 'Counting since ' + formatDate(toLocalStamp(new Date(t.startedAt)))),
         h('div', { class: 'note-actions' },
           button('Reset', 'timer-reset', { id: t.id }),
           button('Delete', 'timer-delete', { id: t.id, class: 'btn-mini danger' })
         )
       );
     }));
   }
   
   /** Refresh every visible timer. Called once a second while the app is open;
    *  each call is a text update on a handful of rows, nothing more. */
   function tickTimers() {
     try {
       if (typeof document === 'undefined' || !document.querySelectorAll) return;
       const els = document.querySelectorAll('[data-timer-elapsed]');
       for (const el of els) {
         const t = findTimer(el.dataset && el.dataset.timerElapsed);
         if (!t) continue;
         const ms = timerElapsed(t);
         el.textContent = formatElapsed(ms);
         el.title = '≈ ' + (ms / 86400000).toFixed(1) + ' days';
       }
     } catch (err) { /* timers must never break rendering */ }
   }
   
   let timerTickTimer = null;
   function startTimerTicker() {
     if (timerTickTimer) return;
     try { timerTickTimer = setInterval(tickTimers, 1000); } catch (err) { /* ignore */ }
   }
   
   /* ---------- notes ---------- */
   
   function noteColorClass(color) {
     return 'note-c-' + (NOTE_COLORS.indexOf(color) !== -1 ? color : 'yellow');
   }
   
   function addNote() {
     const title = cleanText($('noteTitle').value, NOTE_TITLE_LIMIT);
     if (!title) { toast('Give the note a title'); return; }
     const stamp = nowStamp();
     state.settings.notes.push({
       id: newId(),
       title,
       body: cleanText($('noteBody').value, NOTE_BODY_LIMIT, true),
       color: NOTE_COLORS.indexOf(($('noteColor') || {}).value) !== -1 ? $('noteColor').value : 'yellow',
       icon: NOTE_ICONS.indexOf(($('noteIcon') || {}).value) !== -1 ? $('noteIcon').value : '📝',
       pinned: false,
       createdAt: stamp,
       updatedAt: stamp
     });
     $('noteTitle').value = '';
     $('noteBody').value = '';
     // No focus() here on purpose — see addTransaction.
     if (save()) toast('Note saved');
   }
   
   function toggleNotePin(id) {
     const n = findNote(id);
     if (!n) { toast('That note is already gone'); return; }
     n.pinned = !n.pinned;
     if (save()) toast(n.pinned ? 'Pinned to the top' : 'Unpinned');
   }
   
   function openNoteEdit(id) {
     const n = findNote(id);
     if (!n) { toast('That note no longer exists'); return; }
     $('noteEditId').value = n.id;
     $('noteEditTitle').value = n.title;
     $('noteEditBody').value = n.body || '';
     $('noteEditColor').value = NOTE_COLORS.indexOf(n.color) !== -1 ? n.color : 'yellow';
     $('noteEditIcon').value = NOTE_ICONS.indexOf(n.icon) !== -1 ? n.icon : '📝';
     openModal('noteEditModal');
   }
   
   function saveNoteEdit() {
     const n = findNote($('noteEditId').value);
     if (!n) { closeModal('noteEditModal'); toast('That note no longer exists'); return; }
     const title = cleanText($('noteEditTitle').value, NOTE_TITLE_LIMIT);
     if (!title) { toast('Give the note a title'); return; }
     n.title = title;
     n.body = cleanText($('noteEditBody').value, NOTE_BODY_LIMIT, true);
     n.color = NOTE_COLORS.indexOf($('noteEditColor').value) !== -1 ? $('noteEditColor').value : 'yellow';
     n.icon = NOTE_ICONS.indexOf($('noteEditIcon').value) !== -1 ? $('noteEditIcon').value : '📝';
     // Device-local stamp, like every other date in the app.
     n.updatedAt = nowStamp();
     closeModal('noteEditModal');
     if (save()) toast('Note updated');
   }
   
   function deleteNote(id) {
     const n = findNote(id);
     if (!n) { toast('That note is already gone'); return; }
     if (!confirm('Delete the note "' + n.title + '"?')) return;
     state.settings.notes = state.settings.notes.filter((x) => x.id !== id);
     if (save()) toast('Note deleted');
   }
   
   function renderNotes() {
     const list = $('notesList');
     if (!list) return;
     const notes = state.settings.notes || [];
     const q = String(($('notesSearch') || {}).value || '').trim().toLowerCase();
     const shown = q
       ? notes.filter((n) => (n.title + ' ' + (n.body || '')).toLowerCase().indexOf(q) !== -1)
       : notes.slice();
     if (!shown.length) {
       mount(list, h('div', { class: 'empty-state' },
         q ? 'No notes match "' + q + '"' : 'No notes yet. Anything worth remembering — with a color and an icon, so the list is fun to scan.'));
       return;
     }
     // Pinned first, then most recently updated — the list leads with whatever
     // matters and whatever moved.
     const sorted = shown.slice().sort((a, b) =>
       ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) ||
       (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : (a.id < b.id ? -1 : 1)));
     mount(list, sorted.map((n) => h('div', { class: 'note-item ' + noteColorClass(n.color) },
       h('div', { class: 'note-head' },
         h('span', { class: 'note-icon', 'aria-hidden': 'true' }, n.icon || '📝'),
         h('span', { class: 'note-title' }, n.title),
         n.pinned ? h('span', { class: 'note-pin', title: 'Pinned' }, '📌') : null),
       n.body ? h('div', { class: 'note-body' }, n.body) : null,
       h('div', { class: 'note-meta' },
         'Added ' + formatDate(n.createdAt) + ' · Updated ' + formatDate(n.updatedAt || n.createdAt)),
       h('div', { class: 'note-actions' },
         button(n.pinned ? 'Unpin' : 'Pin', 'note-pin', { id: n.id }),
         button('Edit', 'note-edit', { id: n.id }),
         button('Delete', 'note-delete', { id: n.id, class: 'btn-mini danger' })
       )
     )));
   }
   
   /* ============================================================
      Charts (hand-rolled SVG — no library, so the app stays offline-static)
      ============================================================ */
   
   function polarToCartesian(cx, cy, r, angleDeg) {
     const a = ((angleDeg - 90) * Math.PI) / 180;
     return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
   }
   
   function donutPath(cx, cy, rOuter, rInner, startAngle, endAngle) {
     const large = endAngle - startAngle > 180 ? 1 : 0;
     const s = polarToCartesian(cx, cy, rOuter, startAngle);
     const e = polarToCartesian(cx, cy, rOuter, endAngle);
     const si = polarToCartesian(cx, cy, rInner, endAngle);
     const ei = polarToCartesian(cx, cy, rInner, startAngle);
     return 'M ' + s.x.toFixed(2) + ' ' + s.y.toFixed(2) +
       ' A ' + rOuter + ' ' + rOuter + ' 0 ' + large + ' 1 ' + e.x.toFixed(2) + ' ' + e.y.toFixed(2) +
       ' L ' + si.x.toFixed(2) + ' ' + si.y.toFixed(2) +
       ' A ' + rInner + ' ' + rInner + ' 0 ' + large + ' 0 ' + ei.x.toFixed(2) + ' ' + ei.y.toFixed(2) + ' Z';
   }
   
   /** `pairs` is [[label, value], ...]. Renders a donut with the total in the hole. */
   function donutChart(pairs, opts) {
     const o = opts || {};
     const size = o.size || 200;
     const thickness = o.thickness || 32;
     const cx = size / 2;
     const cy = size / 2;
     const rOuter = size / 2 - 3;
     const rInner = rOuter - thickness;
   
     const data = pairs.filter((p) => p[1] > 0);
     const total = data.reduce((s, p) => s + p[1], 0);
     const kids = [];
   
     if (!total) {
       kids.push(hs('circle', { cx, cy, r: (rOuter + rInner) / 2, fill: 'none', stroke: '#e5e5ea', 'stroke-width': thickness }));
     } else {
       let angle = 0;
       data.forEach((p, i) => {
         const sweep = Math.max(0.35, (p[1] / total) * 359.99);
         kids.push(hs('path', {
           d: donutPath(cx, cy, rOuter, rInner, angle, angle + sweep),
           fill: CHART_COLORS[i % CHART_COLORS.length],
           stroke: '#fff',
           'stroke-width': 2
         }, hs('title', { text: p[0] + ' — ' + formatMoney(p[1]) + ' (' + Math.round((p[1] / total) * 100) + '%)' })));
         angle += sweep;
       });
     }
   
     kids.push(hs('text', {
       x: cx, y: cy - 1, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 700,
       fill: '#1c1c1e', 'font-family': 'inherit', text: o.centerValue || formatMoney(total)
     }));
     kids.push(hs('text', {
       x: cx, y: cy + 15, 'text-anchor': 'middle', 'font-size': 10.5,
       fill: '#666670', 'font-family': 'inherit', text: o.centerLabel || 'total'
     }));
   
     return hs('svg', {
       class: 'chart-donut', viewBox: '0 0 ' + size + ' ' + size,
       width: size, height: size, role: 'img', 'aria-label': o.aria || 'Spending by category'
     }, kids);
   }
   
   /** `series` is [{label, income, expense}]. Grouped bars, income vs expense. */
   function trendChart(series, opts) {
     const o = opts || {};
     const w = 320;
     const h = 132;
     const padT = 10;
     const padB = 26;
     const plot = h - padT - padB;
     const gap = 2;
     const slot = w / Math.max(1, series.length);
     const barW = Math.max(2, Math.min(11, (slot - gap) / 2));
   
     const max = Math.max(1, ...series.map((b) => Math.max(b.income, b.expense)));
     const kids = [
       hs('line', { x1: 0, y1: padT + plot, x2: w, y2: padT + plot, stroke: '#dcdce1', 'stroke-width': 1 })
     ];
   
     series.forEach((b, i) => {
       const x0 = i * slot + (slot - barW * 2 - gap) / 2;
       const hi = Math.round((b.income / max) * plot);
       const he = Math.round((b.expense / max) * plot);
       if (hi > 0) {
         kids.push(hs('rect', {
           x: x0.toFixed(1), y: (padT + plot - hi).toFixed(1), width: barW.toFixed(1), height: hi,
           rx: 1.5, fill: '#127531'
         }, hs('title', { text: b.label + ' — in ' + formatMoney(b.income) })));
       }
       if (he > 0) {
         kids.push(hs('rect', {
           x: (x0 + barW + gap).toFixed(1), y: (padT + plot - he).toFixed(1), width: barW.toFixed(1), height: he,
           rx: 1.5, fill: '#c0271d'
         }, hs('title', { text: b.label + ' — out ' + formatMoney(b.expense) })));
       }
       // Thin the labels out so they never overlap, and always keep the first and
       // last so the span of the chart stays readable.
       const every = slot < 26 ? Math.ceil(26 / slot) : 1;
       if (i % every === 0 || i === series.length - 1) {
         // A 3-letter month label needs more room than a day number.
         const size = b.label.length > 2 ? 8.5 : 9;
         kids.push(hs('text', {
           x: (i * slot + slot / 2).toFixed(1), y: h - 12, 'text-anchor': 'middle',
           'font-size': size, fill: '#666670', 'font-family': 'inherit', text: b.label
         }));
       }
     });
   
     return hs('svg', {
       class: 'chart-trend', viewBox: '0 0 ' + w + ' ' + h, role: 'img',
       'aria-label': o.aria || 'Income and expense over the period', preserveAspectRatio: 'none'
     }, kids);
   }
   
   /** Name the bucket size for the chart heading, inferred from the label format
    *  that bucketSeries produces. */
   function bucketUnit(sampleLabel) {
     if (/^\d{4}$/.test(sampleLabel)) return 'year';
     if (/^[A-Z][a-z]{2}$/.test(sampleLabel)) return 'month';
     if (String(sampleLabel).indexOf('/') !== -1) return 'week';
     return 'day';
   }
   
   function chartLegend(pairs) {
     const total = pairs.reduce((s, p) => s + p[1], 0);
     if (!total) return null;
     return h('ul', { class: 'chart-legend' }, pairs.map((p, i) =>
       h('li', null,
         h('span', { class: 'legend-dot', style: 'background:' + CHART_COLORS[i % CHART_COLORS.length] }),
         h('span', { class: 'legend-label' }, p[0]),
         h('span', { class: 'legend-value' }, formatMoney(p[1]) + '  ' + Math.round((p[1] / total) * 100) + '%')
       )
     ));
   }
   
   /** The oldest transaction date, or null when there is nothing stored.
    *  "All time" charts anchor to this rather than to the epoch, so the graph
    *  shows the years that actually have records instead of 56 empty ones. */
   function earliestTransactionDate() {
     let earliest = null;
     for (const t of state.transactions) {
       const d = new Date(t.date);
       if (Number.isNaN(d.getTime())) continue;
       if (!earliest || d < earliest) earliest = d;
     }
     return earliest;
   }
   
   /** Split a window into day, week, month or year buckets for the trend chart, so
    *  the granularity always fits the span. Never caps the bucket count: dropping
    *  the tail of a long range would make the chart disagree with the totals. */
   function bucketSeries(start, end) {
     const anchor = start || earliestTransactionDate() || new Date(end);
     const days = dayDiff(anchor, end);
     const gran = days <= 45 ? 'day' : days <= 240 ? 'week' : days <= 4000 ? 'month' : 'year';
   
     const buckets = [];
     if (gran === 'year') {
       // A year cursor rather than day arithmetic, so a long range cannot drift.
       for (let y = anchor.getFullYear(); y <= end.getFullYear(); y++) {
         buckets.push({ label: String(y), income: 0, expense: 0 });
       }
     } else if (gran === 'month') {
       let y = anchor.getFullYear();
       let m = anchor.getMonth();
       const last = new Date(end.getFullYear(), end.getMonth());
       for (let guard = 0; guard < 1200; guard++) {
         if (y > last.getFullYear() || (y === last.getFullYear() && m > last.getMonth())) break;
         buckets.push({ label: MONTH_ABBR[m], income: 0, expense: 0 });
         m++; if (m > 11) { m = 0; y++; }
       }
     } else {
       const step = gran === 'week' ? 7 : 1;
       for (let t = startOfDay(anchor); t <= end; t = addDays(t, step)) {
         buckets.push({
           label: gran === 'week' ? (t.getDate() + '/' + (t.getMonth() + 1)) : String(t.getDate()),
           income: 0,
           expense: 0
         });
       }
     }
     if (!buckets.length) return buckets;
   
     const step = gran === 'day' ? 1 : gran === 'week' ? 7 : 0;
     for (const t of state.transactions) {
       const d = new Date(t.date);
       if (d < anchor || d > end) continue;
       let idx;
       if (step) {
         idx = Math.floor(dayDiff(anchor, d) / step);
       } else if (gran === 'month') {
         // Clamped so a record on the 31st cannot skip past the last bucket.
         idx = Math.max(0, (d.getFullYear() - anchor.getFullYear()) * 12 + (d.getMonth() - anchor.getMonth()));
       } else {
         idx = Math.max(0, d.getFullYear() - anchor.getFullYear());
       }
       if (idx < 0 || idx >= buckets.length) continue;
       if (t.type === 'income') buckets[idx].income += t.amount;
       else buckets[idx].expense += t.amount;
     }
     return buckets;
   }
   
   /* ============================================================
      Reports
      ============================================================ */
   
   function showReport(mode, opts) {
     const o = opts || {};
     reportRange = { mode: mode };
     if (o.from) reportRange.from = o.from;
     if (o.to) reportRange.to = o.to;
     renderAll();
     const out = $('reportOutput');
     if (out && out.scrollIntoView) out.scrollIntoView({ block: 'nearest' });
   }
   
   function applyCustomRange() {
     const from = $('reportFrom').value;
     const to = $('reportTo').value;
     if (!from) { toast('Pick a start date'); return; }
     if (to && to < from) { toast('The end date is before the start date'); return; }
     reportRange = { mode: 'custom', from: from, to: to || '' };
     renderAll();
   }
   
   function renderReport() {
     const out = $('reportOutput');
     if (!out) return;
   
     // Keep the active preset button lit.
     for (const b of document.querySelectorAll('[data-act="report"]')) {
       b.classList.toggle('is-active', b.dataset.arg === reportRange.mode);
     }
     if (reportRange.mode === 'custom') {
       if ($('reportFrom')) $('reportFrom').value = reportRange.from || '';
       if ($('reportTo')) $('reportTo').value = reportRange.to || '';
     }
   
     const { start, end, label } = periodBounds(reportRange.mode);
     const totals = ledgerTotals(start, end);
     const byCat = spendByCategory(start, end);
     // Equal amounts fall back to the name, so the ranking is a total order and
     // two categories with the same total never swap places between renders.
     const ranked = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
     const count = state.transactions.filter((t) => {
       const d = new Date(t.date);
       return (!start || d >= start) && (!end || d <= end);
     }).length;
   
     // Donut shows the top slices plus one "Other" slice, so a dozen tiny
     // categories cannot turn the ring into confetti.
     const TOP = 6;
     let slices = ranked.slice(0, TOP);
     if (ranked.length > TOP) {
       const rest = ranked.slice(TOP).reduce((s, p) => s + p[1], 0);
       if (rest > 0) slices = slices.concat([['Other (' + (ranked.length - TOP) + ')', round2(rest)]]);
     }
     const buckets = bucketSeries(start, end);
   
     const section = h('div', { class: 'report-section' },
       h('div', { class: 'report-period' }, label + ' · ' + count + ' transaction(s)'),
   
       h('div', { class: 'chart-block' },
         h('div', { class: 'chart-donut-wrap' },
           donutChart(slices, {
             centerValue: formatMoney(totals.expense),
             centerLabel: 'spent',
             aria: 'Spending by category, ' + label
           })
         ),
         chartLegend(slices)
       ),
   
       h('div', { class: 'chart-block' },
         h('div', { class: 'chart-title' }, 'Money in vs out' + (buckets.length ? '  ·  per ' + bucketUnit(buckets[0].label) : '')),
         trendChart(buckets, { aria: 'Income and expense over ' + label }),
         h('div', { class: 'chart-legend-inline' },
           h('span', null, h('span', { class: 'legend-dot', style: 'background:#127531' }), 'Income'),
           h('span', null, h('span', { class: 'legend-dot', style: 'background:#c0271d' }), 'Expense')
         )
       ),
   
       ranked.length
         ? h('div', null, ranked.map(([cat, amt]) =>
             h('div', { class: 'report-row' },
               h('span', { class: 'label' }, cat),
               h('span', { class: 'value neg' }, formatMoney(amt))
             )))
         : h('div', { class: 'empty-state' }, 'No expenses in this period'),
   
       h('div', { class: 'report-total' }, h('span', {}, 'Total income'), h('span', { class: 'pos' }, formatMoney(totals.income))),
       h('div', { class: 'report-total' }, h('span', {}, 'Total expense'), h('span', { class: 'neg' }, formatMoney(totals.expense))),
       h('div', { class: 'report-total strong' },
         h('span', {}, 'Net'),
         h('span', { class: totals.net < 0 ? 'neg' : 'pos' }, formatMoney(totals.net, { signed: true })))
     );
   
     renderInsights();
     mount(out, section);
   }
   
   /* ============================================================
       Home extras, quick add, goals, recurring, challenges
       ------------------------------------------------------------
       Plans and goals live in the synced prefs settings (see
       sanitizeState): no new tables, no migration. Safe-to-spend
       and the no-spend streak are derived from records on every
       render — never stored, never stale.
       ============================================================ */

   /** Days left in the current month, counting today. */
   function daysLeftThisMonth() {
     const n = new Date();
     return new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate() - n.getDate() + 1;
   }

   /** Money you can still spend today without eating into a budget:
    *  what the budget summary leaves over, shared across the days
    *  still to come. Even with no budgets the number is meaningful —
    *  the whole balance, day-shared. */
   function safeToSpend() {
     const sum = budgetSummary(currentPeriod());
     const days = daysLeftThisMonth();
     return {
       perDay: round2(sum.remaining / days),
       remaining: sum.remaining,
       reserved: sum.reserved,
       days,
       hasBudgets: Object.keys(budgetsFor(currentPeriod())).length > 0
     };
   }

   /** Consecutive days ending today with no expense. Transfers never break
      it — they move money, not spend it. A today that already has an
      expense gives 0, which is the honest answer. */
   function noSpendStreak() {
     const spentDays = new Set();
     // A streak older than the records themselves would be fiction, so the
     // count is capped at how long anything has been recorded at all. No
     // records yet means no claim — a zero.
     let earliest = null;
     for (const t of state.transactions) {
       const d = new Date(t.date);
       if (Number.isNaN(d.getTime())) continue;
       if (!earliest || d < earliest) earliest = d;
       if (t.type !== 'expense') continue;
       spentDays.add(d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate());
     }
     if (!earliest) return 0;
     const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
     const cap = Math.max(1, Math.round((midnight(new Date()) - midnight(earliest)) / 86400000) + 1);
     let count = 0;
     const today = new Date();
     for (let i = 0; i < cap; i++) {
       const d = addDays(today, -i);
       if (spentDays.has(d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate())) break;
       count++;
     }
     return count;
   }

   function ordinal(n) {
     const s = ['th', 'st', 'nd', 'rd'];
     const v = n % 100;
     return n + (s[(v - 20) % 10] || s[v] || s[0]);
   }

   /** Names line of the split control → clean name list, in the order typed. */
   function splitNameList(v) {
     return String(v || '').split(',')
       .map((s) => cleanText(s, NAME_LIMIT))
       .filter(Boolean);
   }

   function setHiddenSplit(hidden) {
     const w = $('txSplitNamesWrap');
     if (w) w.hidden = hidden;
   }
   function resetSplitInputs() {
     const on = $('txSplitOn');
     if (on) on.checked = false;
     const names = $('txSplitNames');
     if (names) names.value = '';
     setHiddenSplit(true);
   }


   /* ---------- home: stats, quick add, goals ---------- */

   function renderHomeExtras() {
     const box = $('statBox');
     if (box) {
       const sts = safeToSpend();
       const streak = noSpendStreak();
       mount(box,
         h('div', { class: 'stat-card' },
           h('span', { class: 'stat-label', title: 'Balance left after this month’s budgets, shared over the days still to come' }, 'Safe to spend today'),
           h('span', { class: 'stat-value' }, formatMoney(sts.perDay)),
           h('span', { class: 'stat-sub' }, sts.hasBudgets
             ? formatMoney(sts.remaining) + ' over ' + sts.days + ' day' + (sts.days === 1 ? '' : 's') + ' · ' + formatMoney(sts.reserved) + ' reserved'
             : 'no budgets set — the whole balance, day-shared')),
         h('div', { class: 'stat-card' },
           h('span', { class: 'stat-label', title: 'Days in a row with no expense, counting today. Transfers do not break it.' }, 'No-spend streak'),
           h('span', { class: 'stat-value' }, streak + ' day' + (streak === 1 ? '' : 's')),
           h('span', { class: 'stat-sub' }, streak > 0 ? 'In a row so far' : 'Spend nothing today to start'))
       );
     }
     renderChips();
     renderGoals();
     fillCategorySelect($('tplCategory'));
   }

   function renderChips() {
     const box = $('chipRow');
     if (!box) return;
     const list = state.settings.templates || [];
     if (!list.length) {
       mount(box, h('div', { class: 'empty-state' }, 'No templates yet — save one below and this row becomes one-tap entries.'));
       return;
     }
     mount(box, list.map((t) =>
       h('button', {
         type: 'button',
         class: 'chip',
         dataset: { act: 'tpl-use', id: t.id },
         title: 'Files a ' + t.type + ' of ' + formatMoney(t.amount) + ' in ' + t.category + ', from the account last used here',
         'aria-label': 'Add ' + t.label + ', ' + formatMoney(t.amount)
       },
         t.label + ' · ' + formatMoney(t.amount),
         h('span', { class: 'chip-type ' + t.type }, t.type === 'income' ? 'in' : 'out'),
         h('span', { class: 'chip-x', role: 'button', title: 'Remove template', 'aria-label': 'Remove template ' + t.label, dataset: { act: 'tpl-remove', id: t.id } }, '✕')
       )
     ));
   }

   function renderGoals() {
     const box = $('goalList');
     if (!box) return;
     const list = state.settings.goals || [];
     if (!list.length) {
       mount(box, h('div', { class: 'empty-state' }, 'No goals yet. Name something worth saving for and give it a target.'));
       return;
     }
     mount(box, list.map((g) => {
       const pct = g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
       const done = g.saved >= g.target;
       return h('div', { class: 'mini-item' },
         h('div', { class: 'mini-head' },
           h('span', { class: 'label' }, g.name),
           h('span', { class: 'value' + (done ? ' pos' : '') }, formatMoney(g.saved) + ' of ' + formatMoney(g.target))),
         h('div', { class: 'progress-bar', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': g.name + ' progress' },
           h('div', { class: 'progress-fill ' + (done ? 'ok' : 'warn'), style: 'width:' + pct + '%' })),
         h('div', { class: 'mini-status ' + (done ? 'ok' : 'warn') }, done ? 'Done — target reached' : formatMoney(round2(g.target - g.saved)) + ' to go'),
         h('div', { class: 'mini-actions' },
           done ? null : button('Set aside…', 'goal-add', { id: g.id, title: 'Note money as set aside for this goal — a progress note, accounts and budgets stay untouched' }),
           button('Delete', 'goal-remove', { id: g.id, class: 'btn-mini danger' }))
       );
     }));
   }

   function addGoal() {
     if ((state.settings.goals || []).length >= 12) { toast('12 goals is the limit'); return; }
     const name = cleanText($('goalName').value, NAME_LIMIT);
     const target = readAmountField($('goalTarget'), 'Target');
     if (!name) { toast('Give the goal a name'); return; }
     if (target.error) { toast(target.error); return; }
     if ((state.settings.goals || []).some((g) => g.name.toLowerCase() === name.toLowerCase())) { toast('A goal with that name already exists'); return; }
     pushUndo('Goal added');
     state.settings.goals.push({ id: newId(), name, target: target.value, saved: 0 });
     $('goalName').value = '';
     $('goalTarget').value = '';
     if (save()) toast('Goal added', { label: 'Undo', fn: undoLast });
   }

   function openGoalModal(id) {
     const g = (state.settings.goals || []).find((x) => x.id === id);
     if (!g) return;
     $('goalModalId').value = id;
     $('goalModalSub').textContent = g.name + ' — ' + formatMoney(g.saved) + ' of ' + formatMoney(g.target) +
       ' saved so far (' + formatMoney(round2(g.target - g.saved)) + ' to go).';
     $('goalModalAmount').value = '';
     openModal('goalModal');
   }

   function saveGoalPayment() {
     const g = (state.settings.goals || []).find((x) => x.id === $('goalModalId').value);
     if (!g) { closeModal('goalModal'); return; }
     const amount = readAmountField($('goalModalAmount'), 'Amount');
     if (amount.error) { toast(amount.error); return; }
     pushUndo('Goal progress noted');
     const wasDone = g.saved >= g.target;
     g.saved = round2(Math.min(g.target, g.saved + amount.value));
     closeModal('goalModal');
     const done = g.saved >= g.target;
     if (save()) {
       toast(done && !wasDone
         ? 'Goal reached — ' + g.name + ' is fully saved up'
         : 'Noted for ' + g.name, { label: 'Undo', fn: undoLast });
     }
   }

   function removeGoal(id) {
     const g = (state.settings.goals || []).find((x) => x.id === id);
     if (!g) return;
     if (!confirm('Delete the goal "' + g.name + '"? The progress noted so far goes with it.')) return;
     pushUndo('Goal deleted');
     state.settings.goals = (state.settings.goals || []).filter((x) => x.id !== id);
     if (save()) toast('Goal deleted', { label: 'Undo', fn: undoLast });
   }

   function addTemplate() {
     if ((state.settings.templates || []).length >= 12) { toast('12 templates is the limit'); return; }
     const label = cleanText($('tplLabel').value, ITEM_LIMIT);
     const amount = readAmountField($('tplAmount'), 'Amount');
     if (!label) { toast('Give the template a name'); return; }
     if (amount.error) { toast(amount.error); return; }
     pushUndo('Template saved');
     state.settings.templates.push({
       id: newId(),
       label,
       type: $('tplType').value === 'income' ? 'income' : 'expense',
       amount: amount.value,
       category: $('tplCategory').value
     });
     $('tplLabel').value = '';
     $('tplAmount').value = '';
     if (save()) toast('Template saved — its chip can file entries now', { label: 'Undo', fn: undoLast });
   }

   function useTemplate(id) {
     const t = (state.settings.templates || []).find((x) => x.id === id);
     if (!t) return;
     const accId = findAccount(state.settings.lastAccountId) ? state.settings.lastAccountId : cashAccountId();
     const built = buildTransaction(t.type, t.amount, t.category, t.label, nowStamp(), accId, null);
     if (built.error) { toast(built.error); return; }
     pushUndo('Filed from template');
     state.transactions.unshift(built.value);
     state.settings.lastAccountId = accId;
     if (save()) toast('Filed ' + t.label + ' — ' + formatMoney(t.amount), { label: 'Undo', fn: undoLast });
   }

   function removeTemplate(id) {
     const list = state.settings.templates || [];
     if (!list.some((x) => x.id === id)) return;
     pushUndo('Template removed');
     state.settings.templates = list.filter((x) => x.id !== id);
     if (save()) toast('Template removed', { label: 'Undo', fn: undoLast });
   }


   /* ---------- records: recurring plans ---------- */

   function renderRecurring() {
     const box = $('recList');
     fillRecDays();
     fillCategorySelect($('recCategory'));
     fillAccountSelect($('recAccount'));
     if (!box) return;
     const list = (state.settings.recurring || []).slice()
       .sort((a, b) => (a.active === b.active ? a.dayOfMonth - b.dayOfMonth : (a.active ? -1 : 1)));
     if (!list.length) {
       mount(box, h('div', { class: 'empty-state' }, 'No plans yet. Rent, salary, subscriptions — say how much and which day.'));
       return;
     }
     mount(box, list.map((r) =>
       h('div', { class: 'mini-item' },
         h('div', { class: 'mini-head' },
           h('span', { class: 'label' }, r.label || r.category),
           h('span', { class: 'value ' + (r.type === 'income' ? 'pos' : 'neg') },
             formatMoney(r.amount, { signed: r.type === 'income' }))),
         h('div', { class: 'mini-meta' },
           (r.type === 'income' ? 'Income' : 'Expense') + ' · ' + r.category + ' · ' +
           (findAccount(r.accountId) ? accountName(r.accountId) : 'last-used account') + ' · the ' + ordinal(r.dayOfMonth) +
           ' of every month' + (r.active ? '' : ' · paused')),
         h('div', { class: 'mini-actions' },
           button(r.active ? 'Pause' : 'Resume', 'rec-toggle', { id: r.id }),
           button('Delete', 'rec-delete', { id: r.id, class: 'btn-mini danger' }))
       )
     ));
   }

   function fillRecDays() {
     const sel = $('recDay');
     if (!sel) return;
     const held = sel.value;
     mount(sel, Array.from({ length: 28 }, (_, i) => h('option', { value: String(i + 1) }, 'Day ' + (i + 1) + ' of the month')));
     if (held) sel.value = held;
     if (!sel.value) sel.value = '1';
   }

   function addRecurring() {
     if ((state.settings.recurring || []).length >= 24) { toast('24 plans is the limit'); return; }
     const label = cleanText($('recLabel').value, ITEM_LIMIT);
     const amount = readAmountField($('recAmount'), 'Amount');
     if (amount.error) { toast(amount.error); return; }
     pushUndo('Recurring plan added');
     const recAcc = $('recAccount');
     const recPlanAccount = recAcc && findAccount(recAcc.value) ? recAcc.value : null;
     state.settings.recurring.push({
       id: newId(),
       type: $('recType').value === 'income' ? 'income' : 'expense',
       amount: amount.value,
       category: $('recCategory').value,
       accountId: recPlanAccount,
       label,
       dayOfMonth: clampNumber($('recDay').value, 1, 28),
       active: true,
       lastFiled: null
     });
     $('recLabel').value = '';
     $('recAmount').value = '';
     if (save()) {
       toast('Plan added — it files itself on the ' + ordinal(clampNumber($('recDay').value, 1, 28)), { label: 'Undo', fn: undoLast });
     }
   }

   function toggleRecurring(id) {
     const r = (state.settings.recurring || []).find((x) => x.id === id);
     if (!r) return;
     pushUndo('Recurring plan ' + (r.active ? 'paused' : 'resumed'));
     r.active = !r.active;
     if (save()) toast(r.active ? 'Plan resumed' : 'Plan paused — nothing files until it is resumed');
   }

   function deleteRecurring(id) {
     const r = (state.settings.recurring || []).find((x) => x.id === id);
     if (!r) return;
     if (!confirm('Delete this plan? Entries it already filed stay in your records.')) return;
     pushUndo('Recurring plan deleted');
     state.settings.recurring = (state.settings.recurring || []).filter((x) => x.id !== id);
     if (save()) toast('Plan deleted', { label: 'Undo', fn: undoLast });
   }

   /** Files every active plan whose day has come in a month it has not yet
      filed for. One entry per plan per run in the current month, whatever
      earlier months were missed; filed entries carry the plan's day, at 09:00,
      into the account last used on this device. Returns how many were filed —
      the caller persists and announces. */
   function maybeFileRecurring() {
     const cur = currentPeriod();
     const today = new Date();
     let filed = 0;
     for (const r of state.settings.recurring || []) {
       if (!r.active) continue;
       if (r.lastFiled === cur) continue;
       if (r.dayOfMonth > today.getDate()) continue;
       const accId = findAccount(r.accountId) ? r.accountId
         : findAccount(state.settings.lastAccountId) ? state.settings.lastAccountId : cashAccountId();
       const built = buildTransaction(r.type, r.amount, r.category, r.label || r.category, cur + '-' + pad2(r.dayOfMonth) + 'T09:00', accId, null);
       if (built.error) continue;
       pushUndo('Recurring entry filed');
       built.value.source = 'plan:' + r.id;
       state.transactions.unshift(built.value);
       r.lastFiled = cur;
       filed++;
     }
     return filed;
   }


   /* ---------- budget: rollover + challenges ---------- */

   /** Carries unused budget room into the current month once per month, when
      the toggle is on. Only fills categories that are still real and have no
      limit in the new month yet — nothing is ever overwritten. Fires
      regardless of when the toggle was turned on; budgetRolloverPeriod marks
      the month as processed. */
   function maybeRolloverBudgets() {
     const cur = currentPeriod();
     const s = state.settings;
     if (s.budgetRolloverPeriod === cur) return false;
     const willRoll = s.budgetRollover === true;
     if (willRoll) {
       const prev = previousPeriod(cur);
       const src = state.budgets[prev];
       if (src) {
         const dest = budgetsFor(cur);
         for (const cat of Object.keys(src)) {
           if (Object.prototype.hasOwnProperty.call(dest, cat)) continue;
           if (!findCategory(cat)) continue;
           dest[cat] = round2((src[cat] || 0) + budgetFreeRoom(cat, prev));
         }
       }
     }
     s.budgetRolloverPeriod = cur;
     return willRoll;
   }

   function renderChallenges() {
     const box = $('challengeList');
     fillCategorySelect($('challengeCategory'));
     if (!box) return;
     const period = activeBudgetPeriod();
     const list = (state.settings.challenges || []).filter((c) => c.period === period);
     if (!list.length) {
       mount(box, h('div', { class: 'empty-state' }, 'No challenges for ' + periodLabel(period) + ' — pick a category and a cap below.'));
       return;
     }
     mount(box, list.map((c) => {
       const used = budgetCounted(c.category, c.period);
       const pct = c.cap > 0 ? Math.min(100, (used / c.cap) * 100) : 0;
       const over = used > c.cap;
       return h('div', { class: 'mini-item' },
         h('div', { class: 'mini-head' },
           h('span', { class: 'label' }, c.category),
           h('span', { class: 'value' + (over ? ' neg' : '') }, formatMoney(used) + ' of ' + formatMoney(c.cap))),
         h('div', { class: 'progress-bar', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': c.category + ' challenge' },
           h('div', { class: 'progress-fill ' + (over ? 'over' : (pct >= 70 ? 'warn' : 'ok')), style: 'width:' + pct + '%' })),
         h('div', { class: 'mini-status ' + (over ? 'over' : 'ok') },
           over ? 'Over by ' + formatMoney(round2(used - c.cap)) : formatMoney(round2(c.cap - used)) + ' left under the cap'),
         h('div', { class: 'mini-actions' },
           button('Delete', 'challenge-remove', { id: c.id, class: 'btn-mini danger' }))
       );
     }));
   }

   function addChallenge() {
     if ((state.settings.challenges || []).length >= 12) { toast('12 challenges is the limit'); return; }
     const cat = $('challengeCategory').value;
     if (!findCategory(cat)) { toast('Choose a category'); return; }
     const cap = readAmountField($('challengeCap'), 'Challenge cap');
     if (cap.error) { toast(cap.error); return; }
     const period = activeBudgetPeriod();
     if ((state.settings.challenges || []).some((c) => c.period === period && c.category === cat)) {
       toast('That category already has a challenge for ' + periodLabel(period));
       return;
     }
     pushUndo('Challenge added');
     state.settings.challenges.push({ id: newId(), period, category: cat, cap: cap.value });
     $('challengeCap').value = '';
     if (save()) toast('Challenge on — keep ' + cat + ' under ' + formatMoney(cap.value), { label: 'Undo', fn: undoLast });
   }

   function removeChallenge(id) {
     const c = (state.settings.challenges || []).find((x) => x.id === id);
     if (!c) return;
     if (!confirm('Remove the ' + c.category + ' challenge for ' + periodLabel(c.period) + '?')) return;
     pushUndo('Challenge removed');
     state.settings.challenges = (state.settings.challenges || []).filter((x) => x.id !== id);
     if (save()) toast('Challenge removed', { label: 'Undo', fn: undoLast });
   }


   /* ---------- reports: insights + spending pattern ---------- */

   function renderInsights() {
     const box = $('insightBox');
     if (!box) return;
     const { start, end } = periodBounds(reportRange.mode);
     const totals = ledgerTotals(start, end);
     const byCat = spendByCategory(start, end);
     const ranked = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
     if (!ranked.length) { mount(box); return; }

     const rows = [];
     if (totals.income > 0) {
       rows.push(['Savings rate', Math.round(((totals.income - totals.expense) / totals.income) * 100) + '% of income kept']);
     }
     const topShare = totals.expense > 0 ? Math.round((ranked[0][1] / totals.expense) * 100) : 0;
     rows.push(['Biggest category', ranked[0][0] + ' — ' + formatMoney(ranked[0][1]) + ' (' + topShare + '% of spending)']);

     const byDay = [0, 0, 0, 0, 0, 0, 0];
     let big = null;
     for (const t of state.transactions) {
       if (t.type !== 'expense') continue;
       const d = new Date(t.date);
       if (start && d < start) continue;
       if (end && d > end) continue;
       byDay[d.getDay()] = round2(byDay[d.getDay()] + t.amount);
       if (!big || t.amount > big.amount) big = t;
     }
     const heaviest = Math.max.apply(null, byDay);
     if (heaviest > 0) {
       rows.push(['Most expensive weekday', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][byDay.indexOf(heaviest)] + ' — ' + formatMoney(heaviest)]);
     }
     if (big) rows.push(['Largest entry', formatMoney(big.amount) + (big.category ? ' in ' + big.category : '')]);

     let persona = 'Balanced';
     if (totals.income > 0 && totals.net < 0) persona = 'Outspending income';
     else if (totals.income > 0 && totals.net >= round2(totals.income * 0.35)) persona = 'Strong saver';

     mount(box, h('section', { class: 'insight-card', 'aria-label': 'Insights' },
       h('h3', { class: 'insight-title' }, 'Insights'),
       rows.map(([k, v]) => h('div', { class: 'report-row' }, h('span', { class: 'label' }, k), h('span', { class: 'value' }, v))),
       h('div', { class: 'insight-persona' },
         h('span', { class: 'persona', title: 'Read off the range shown: money kept versus money coming in' }, 'Pattern'),
         h('span', null, persona))));
   }


   /* ---------- voice entry (online only) ---------- */

   /** Online-only by nature: browser speech recognition runs on a server, so
      offline the button is disabled rather than half-working. */
   function updateVoiceAvailability() {
     const mic = $('txVoice');
     if (!mic) return;
     const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
     const ok = !!SR && navigator.onLine !== false;
     mic.disabled = !ok;
     mic.title = !SR
       ? 'Voice entry needs Chrome or Edge'
       : (ok
         ? 'Speak like "bought chai 120 cash" — it fills the form, you still press Save'
         : 'Voice entry needs an internet connection');
   }

   function setupVoice() {
     const mic = $('txVoice');
     if (!mic) return;
     mic.addEventListener('click', () => {
       const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
       if (!SR || navigator.onLine === false) { updateVoiceAvailability(); return; }
       if (window.isSecureContext === false) { toast('Voice entry needs a https:// address'); return; }
       let rec;
       try {
         rec = new SR();
       } catch (err) { updateVoiceAvailability(); return; }
       rec.lang = 'en-US';
       rec.interimResults = false;
       rec.maxAlternatives = 1;
       mic.classList.add('listening');
       rec.onresult = (e) => {
         const alt = e.results && e.results[0] && e.results[0][0];
         const text = String((alt && alt.transcript) || '').trim();
         if (text) applyVoiceText(text);
       };
       rec.onerror = (e) => {
         mic.classList.remove('listening');
         const kind = e && e.error;
         // Each refusal says why — the message is the fix, not just an apology.
         if (kind === 'not-allowed') toast('Microphone is blocked — allow mic access for this site, then tap again');
         else if (kind === 'no-speech') toast('Nothing was heard — tap and speak again, closer to the mic');
         else if (kind === 'audio-capture') toast('No microphone found on this device');
         else if (kind === 'network-error' || kind === 'service-not-allowed') toast('Voice entry needs a working internet connection');
         else toast('Voice did not come through — type it instead');
       };
       rec.onend = () => mic.classList.remove('listening');
       try { rec.start(); } catch (err) { mic.classList.remove('listening'); updateVoiceAvailability(); }
     });
     window.addEventListener('online', updateVoiceAvailability);
     window.addEventListener('offline', updateVoiceAvailability);
     updateVoiceAvailability();
   }

   /** Text → form. The first number heard is the amount; an income word
      switches the type; a recognised account name fills the account; the
      transcript lands in the comment. Category and date stay as the form
      already has them — guessing those was too often wrong. Saving stays a
      button press: speech is fast, but filing money quietly is a mistake. */
   function applyVoiceText(text) {
     const lower = text.toLowerCase();
     const heard = (String(text).match(/\d[\d,]*/) || [])[0];
     const amount = heard ? toPositiveNumber(heard) : null;
     if (amount === null) {
       toast('Could not hear an amount — say the number first, like "chai 120 cash"');
       return;
     }
     if (/\b(salary|received|got|earned|deposit|refund|refunded)\b/.test(lower)) $('txType').value = 'income';
     else if (/\b(spent|paid|bought|expense|gave)\b/.test(lower)) $('txType').value = 'expense';
     // Account names are matched as whole words: the text is padded so "Sada"
     // does not hide inside "SadaPay" and vice versa.
     const padded = ' ' + lower.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim() + ' ';
     const acc = state.accounts.find((a) => !a.archived &&
       a.name.toLowerCase().trim().length >= 3 && padded.indexOf(' ' + a.name.toLowerCase().trim() + ' ') !== -1);
     if (acc) $('txAccount').value = acc.id;
     $('txAmount').value = String(amount);
     const commentBox = $('txComment');
     if (commentBox && !commentBox.value) commentBox.value = cleanText(text, COMMENT_LIMIT);
     setTxTypeFields();
     toast('Heard: "' + text + '" — press Save when it looks right');
   }


   /* ---------- accent color (Settings → Appearance) ---------- */

   /* Per-device like the theme: it is how this screen looks, not what the
      money says. The palette is fixed and dark enough for white text, so
      contrast survives any pick; in dark mode the text accent is lifted
      toward white while fills stay as chosen. */
   const ACCENT_KEY = 'cashflow:accent';
   const ACCENTS = ['#0a58ca', '#127531', '#6b21a8', '#8a5200', '#0e7490', '#be185d', '#4338ca', '#c0271d'];

   function getAccent() {
     try {
       const a = localStorage.getItem(ACCENT_KEY);
       return ACCENTS.indexOf(a) !== -1 ? a : null;
     } catch (err) { return null; }
   }

   /** #rrggbb mixed toward white by amt (0..1). */
   function lightenHex(hex, amt) {
     const n = parseInt(hex.slice(1), 16);
     const mix = (c) => Math.round(c + (255 - c) * amt);
     const r = mix((n >> 16) & 255);
     const g = mix((n >> 8) & 255);
     const b = mix(n & 255);
     return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
   }

   function applyAccent() {
     const a = getAccent();
     const root = document.documentElement;
     if (!a) {
       root.style.removeProperty('--accent');
       root.style.removeProperty('--accent-solid');
       return;
     }
     root.style.setProperty('--accent', getTheme() === 'dark' ? lightenHex(a, 0.55) : a);
     root.style.setProperty('--accent-solid', a);
   }

   function setAccent(color) {
     if (ACCENTS.indexOf(color) === -1) return;
     try { localStorage.setItem(ACCENT_KEY, color); } catch (err) { /* ignore */ }
     applyAccent();
     renderAccentSwatches();
     toast('Accent updated');
   }

   function renderAccentSwatches() {
     const box = $('accentRow');
     if (!box) return;
     const cur = getAccent();
     mount(box, ACCENTS.map((c) =>
       h('button', {
         type: 'button',
         class: 'swatch' + (c === cur ? ' is-active' : ''),
         style: 'background:' + c,
         dataset: { act: 'accent-set', arg: c },
         'aria-pressed': c === cur ? 'true' : 'false',
         'aria-label': 'Accent color ' + c,
         title: 'Accent ' + c
       })));
   }

   /* ============================================================
      Month archive
      ============================================================ */
   
   /* ============================================================
      Backup
      ============================================================ */
   
   function exportBackup(opts) {
     const o = opts || {};
     const payload = {
       app: APP_IDS[0],
       version: SCHEMA_VERSION,
       exportDate: new Date().toISOString(),
       transactions: state.transactions,
       debts: state.debts,
       budgets: state.budgets,
       categories: state.categories,
       shopping: state.shopping,
       custody: state.custody,
       accounts: state.accounts,
       settings: state.settings,
       closedPeriods: state.closedPeriods
     };
   
     // The download is best-effort. Closing a month or exporting must never fail
     // because the browser refused to create an object URL, so any error here is
     // reported and swallowed rather than thrown.
     let ok = false;
     try {
       if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw new Error('no createObjectURL');
       const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
       const url = URL.createObjectURL(blob);
       const a = h('a', { href: url, download: 'salary_backup_' + localDateStamp() + '.json' });
       document.body.append(a);
       a.click();
       a.remove();
       // Revoking synchronously can cancel the download in some browsers.
       setTimeout(() => { try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ } }, 10000);
       ok = true;
     } catch (err) {
       console.warn('Backup download failed:', err);
     }
     if (!o.quiet) toast(ok ? 'Backup exported' : 'Could not download the file. Your data is unchanged.');
   }
   
   async function importBackup() {
     const input = $('importFile');
     const file = input.files && input.files[0];
     input.value = '';   // always reset, so a cancelled import cannot silently repeat
     if (!file) { toast('Choose a .json backup file first'); return; }
   
     let parsed;
     try {
       parsed = JSON.parse(await file.text());
     } catch (err) {
       toast('That file is not valid JSON');
       return;
     }
     if (!isObject(parsed)) { toast('That is not a ' + APP_NAME + ' backup'); return; }
     // Accept backups from before the rename as well as after it.
     if (typeof parsed.app === 'string' && APP_IDS.indexOf(parsed.app) === -1) {
       toast('That file is not a ' + APP_NAME + ' backup');
       return;
     }
   
     const { state: incoming, problems } = sanitizeState(parsed);
     const { state: merged, added } = mergeIncomingState(state, incoming);
   
     const newBits = [];
     if (added.transactions) newBits.push(added.transactions + ' transaction(s)');
     if (added.debts) newBits.push(added.debts + ' udhaar entr(y/ies)');
     if (added.shopping) newBits.push(added.shopping + ' list item(s)');
     if (added.notes) newBits.push(added.notes + ' note(s)');
     if (added.timers) newBits.push(added.timers + ' timer(s)');
     if (added.accounts) newBits.push(added.accounts + ' account(s)');
     if (added.categories) newBits.push(added.categories + ' categor(y/ies)');
   
     if (!confirm(
       'Merge "' + file.name + '" into this browser?\n\n' +
       (newBits.length ? 'New: ' + newBits.join(', ') + '.\n\n' : 'Nothing in it is new — everything it holds is already here.\n\n') +
       'What is already here is never touched or deleted; only genuinely new rows are added.\n\n' +
       (problems.length ? 'Note: the file needed ' + problems.length + ' repair(s) on the way in.\n\n' : '') +
       'Continue?'
     )) return;
   
     state = merged;
     reportRange = { mode: 'month' };
     budgetPeriod = null;
     // A shared file can carry same-name accounts under different ids; fold them
     // the same way a sync pull is folded. mergeDuplicateAccounts saves itself
     // when it merges, so save() below runs only when there was nothing to fold.
     if (!mergeDuplicateAccounts({ silent: true })) save();
     toast(newBits.length
       ? 'Merged in ' + newBits.join(', ') + ' — nothing already here was touched'
       : 'Nothing new to merge — everything is already here');
   }
   
   /** Merge a backup file INTO the current state instead of replacing it.
    *
    *  Hand-carried files (someone shares their shopping items, a backup from the
    *  other device) must add, never delete: every collection is unioned by id,
    *  and on any conflict the row already here wins. Categories keep their order
    *  with new ones appended; budgets fill months and categories that are
    *  missing while existing limits stand; settings stay this device's own with
    *  only gaps filled. Returns the merged state plus how many rows were new, so
    *  the caller can say exactly what arrived. Pure in its inputs — the two
    *  states are only read — which is what makes it unit-testable. */
   function mergeIncomingState(current, incoming) {
     const unionById = (cur, inc) => {
       const seen = new Set();
       const out = [];
       for (const r of cur || []) {
         if (!r || typeof r.id !== 'string') continue;
         if (seen.has(r.id)) continue;
         seen.add(r.id);
         out.push(r);
       }
       let added = 0;
       for (const r of inc || []) {
         if (!r || typeof r.id !== 'string') continue;
         if (seen.has(r.id)) continue;
         seen.add(r.id);
         out.push(r);
         added++;
       }
       return { rows: out, added };
     };
   
     const tx = unionById(current.transactions, incoming.transactions);
     const debts = unionById(current.debts, incoming.debts);
     const shopping = unionById(current.shopping, incoming.shopping);
     const custody = unionById(current.custody, incoming.custody);
     const accounts = unionById(current.accounts, incoming.accounts);
   
     const categories = (current.categories || []).slice();
     const haveCat = new Set(categories.map((c) => String(c).toLowerCase()));
     let addedCats = 0;
     for (const c of incoming.categories || []) {
       if (typeof c !== 'string') continue;
       if (haveCat.has(c.toLowerCase())) continue;
       haveCat.add(c.toLowerCase());
       categories.push(c);
       addedCats++;
     }
   
     const budgets = Object.create(null);
     for (const p of Object.keys((current && current.budgets) || {})) {
       budgets[p] = Object.assign(Object.create(null), current.budgets[p]);
     }
     for (const p of Object.keys((incoming && incoming.budgets) || {})) {
       if (!PERIOD_RE.test(p) || !isObject(incoming.budgets[p])) continue;
       if (!budgets[p]) budgets[p] = Object.create(null);
       for (const cat of Object.keys(incoming.budgets[p])) {
         if (!Object.prototype.hasOwnProperty.call(budgets[p], cat)) budgets[p][cat] = incoming.budgets[p][cat];
       }
     }
   
     const cp = new Set();
     for (const p of (current.closedPeriods || []).concat(incoming.closedPeriods || [])) {
       if (typeof p === 'string' && PERIOD_RE.test(p)) cp.add(p);
     }
   
     const accountIds = new Set(accounts.rows.map((a) => a && a.id));
     const curS = (current && current.settings) || {};
     const incS = (incoming && incoming.settings) || {};
     const offset = Object.assign(Object.create(null), curS.budgetOffset || {});
     for (const k of Object.keys(incS.budgetOffset || {})) {
       if (!offset[k] && incS.budgetOffset[k] === true) offset[k] = true;
     }
     const cash = accounts.rows.find((a) => a && a.kind === 'cash') || accounts.rows[0];
     const notes = unionById(curS.notes, incS.notes);
     const timers = unionById(curS.timers, incS.timers);
     // Feature lists merge like every other by-id collection: current rows win
     // each id, the rest is appended. Both sides are already validated shapes.
     const rec = unionById(curS.recurring, incS.recurring);
     const goalRows = unionById(curS.goals, incS.goals);
     const tpl = unionById(curS.templates, incS.templates);
     const chal = unionById(curS.challenges, incS.challenges);
     const rolloverOn = curS.budgetRollover === true || incS.budgetRollover === true;
     // Moves merge like everything else: current rows win each id, the rest is
     // appended. sanitizeState already validated both sides' shapes.
     const moves = unionById(curS.budgetMoves, incS.budgetMoves);
     // Memories merge with the current device winning each key, then capped —
     // same rule as everything else: what is here is never overwritten.
     const mem = Object.assign(Object.create(null), incS.catMemory || {}, curS.catMemory || {});
     for (const k of Object.keys(mem)) {
       if (typeof mem[k] !== 'string') { delete mem[k]; continue; }
     }
     while (Object.keys(mem).length > CAT_MEMORY_LIMIT) delete mem[Object.keys(mem)[0]];
   
     return {
       state: {
         version: SCHEMA_VERSION,
         transactions: tx.rows,
         debts: debts.rows,
         budgets,
         categories,
         shopping: shopping.rows,
         custody: custody.rows,
         accounts: accounts.rows,
         settings: {
           budgetOffset: offset,
           lastAccountId: (typeof curS.lastAccountId === 'string' && accountIds.has(curS.lastAccountId))
             ? curS.lastAccountId
             : (cash ? cash.id : CASH_ACCOUNT_ID),
           shoppingPeriod: (typeof curS.shoppingPeriod === 'string' && PERIOD_RE.test(curS.shoppingPeriod))
             ? curS.shoppingPeriod
             : null,
           budgetRollover: rolloverOn,
           budgetRolloverPeriod: (typeof curS.budgetRolloverPeriod === 'string' && PERIOD_RE.test(curS.budgetRolloverPeriod))
             ? curS.budgetRolloverPeriod
             : (typeof incS.budgetRolloverPeriod === 'string' && PERIOD_RE.test(incS.budgetRolloverPeriod) ? incS.budgetRolloverPeriod : null),
           notes: notes.rows,
           timers: timers.rows,
           catMemory: mem,
           budgetMoves: moves.rows,
           recurring: rec.rows,
           goals: goalRows.rows,
           templates: tpl.rows,
           challenges: chal.rows
         },
         closedPeriods: Array.from(cp).sort()
       },
       added: {
         transactions: tx.added,
         debts: debts.added,
         shopping: shopping.added,
         accounts: accounts.added,
         notes: notes.added,
         timers: timers.added,
         categories: addedCats
       }
     };
   }
   
   /* ============================================================
      Modals
      ============================================================ */
   
   let lastFocused = null;
   let activeModalId = null;
   
   function modalFocusables(modal) {
     return Array.prototype.filter.call(
       modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
       (el) => !el.disabled && el.offsetParent !== null
     );
   }
   
   function openModal(id) {
     const modal = $(id);
     if (!modal) return;
     lastFocused = document.activeElement;
     activeModalId = id;
     modal.classList.add('active');
     modal.setAttribute('aria-hidden', 'false');
     document.body.classList.add('modal-open');
   
     const focusables = modalFocusables(modal);
     if (focusables.length) focusables[0].focus();
     else modal.focus();
   }
   
   function closeModal(id) {
     const modal = $(id) || (activeModalId ? $(activeModalId) : null);
     if (!modal) return;
     const wasChoice = modal.id === 'choiceModal';
     modal.classList.remove('active');
     modal.setAttribute('aria-hidden', 'true');
     document.body.classList.remove('modal-open');
     activeModalId = null;
     if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
     lastFocused = null;
     // Backing out of the choice dialog (Escape, backdrop tap, Cancel) is itself
     // an answer — "neither" — so the awaiting action is released with null
     // instead of hanging on a promise nobody resolves.
     if (wasChoice && choiceResolve) { const r = choiceResolve; choiceResolve = null; r(null); }
   }
   
   /* The single-question dialog. A yes/no confirm cannot carry the real decision
      behind an udhaar action — "settle it and move the money" and "just close the
      entry" are both legitimate and opposite — so this asks with named options and
      awaits the pick. Kept separate from window.confirm on purpose: the answer is
      a value, not a boolean, and the extra "do nothing" is as reachable as the
      others (Escape / backdrop / Cancel all resolve null). */
   let choiceResolve = null;
   
   function askChoice(title, message, options) {
     const modal = $('choiceModal');
     if (!modal) return Promise.resolve(null);
     return new Promise((resolve) => {
       choiceResolve = resolve;
       $('choiceTitle').textContent = title;
       $('choiceMessage').textContent = message;
       // Buttons are built fresh per question, so binding their click here is
       // safe — nothing re-renders them out from under the handler.
       mount($('choiceButtons'), options.map((o) => h('button', {
         class: 'btn ' + (o.kind === 'primary' ? 'btn-primary'
           : o.kind === 'danger' ? 'btn-danger'
             : o.kind === 'cancel' ? 'btn-cancel' : 'btn-dark'),
         type: 'button',
         onclick: () => {
           const r = choiceResolve;
           choiceResolve = null;
           closeModal('choiceModal');
           if (r) r(o.value);
         }
       }, o.label)));
       openModal('choiceModal');
     });
   }
   
   function handleModalKeys(e) {
     if (!activeModalId) return;
     const modal = $(activeModalId);
     if (!modal) return;
   
     if (e.key === 'Escape') { e.preventDefault(); closeModal(activeModalId); return; }
     if (e.key !== 'Tab') return;
   
     const focusables = modalFocusables(modal);
     if (!focusables.length) { e.preventDefault(); return; }
     const first = focusables[0];
     const last = focusables[focusables.length - 1];
     if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
     else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
   }
   
   /* ============================================================
      Rendering
      ============================================================ */
   
   function renderBalance() {
     // Income and Expense are this month's flow; the headline stays lifetime, so
     // a new month reads fresh zeros up top while the total below it is untouched.
     const per = currentPeriod();
     const b = periodBoundsOf(per);
     const all = ledgerTotals(b.start, b.end);
     const u = udhaarTotals();
     const { rows, total } = allAccountBalances();
     const pl = $('balancePeriod');
     if (pl) pl.textContent = periodLabel(per);
   
     // The headline is the sum of the account boxes below it, so the two can never
     // disagree — which is exactly why a transfer, which moves money between the
     // boxes without touching income or expense, leaves this number unchanged.
     const el = $('balanceDisplay');
     el.textContent = formatMoney(total);
     el.classList.toggle('negative', total < 0);
     el.classList.toggle('positive', total >= 0);
   
     $('totalIncome').textContent = formatMoney(all.income);
     $('totalExpense').textContent = formatMoney(all.expense);
   
     // Last month's figure in the same row: answers "purani amount kitni thi"
     // without leaving Home. This month's flow is above it; this one is last
     // month's net (income minus expense), under a generic label — no month name
     // on display. When last month holds nothing, the card hides itself instead
     // of showing a meaningless zero.
     try {
       const prev = previousPeriod(per);
       const pb = periodBoundsOf(prev);
       const pt = ledgerTotals(pb.start, pb.end);
       const card = $('prevCard');
       const empty = !(pt.income > 0 || pt.expense > 0);
       if (card) card.hidden = empty;
       if (!empty) {
         const pval = $('totalPrev');
         if (pval) {
           pval.textContent = formatMoney(round2(pt.income - pt.expense), { signed: true });
           pval.title = 'In ' + formatMoney(pt.income) + ' · out ' + formatMoney(pt.expense);
         }
       }
     } catch (err) { /* a bad date must never blank the whole card */ }
   
     mount($('accountBoxes'), rows.map((r) => {
       const tint = accountTint(r.account.kind);
       return h('div', {
         class: 'acct-box' + (r.account.archived ? ' is-archived' : ''),
         style: 'background:' + tint.bg + ';color:' + tint.ink
       },
         h('span', { class: 'acct-box-name' }, r.account.name + (r.account.archived ? ' (archived)' : '')),
         h('span', { class: 'acct-box-value' }, formatMoney(r.balance)),
         r.account.openingBalance
           ? h('span', { class: 'acct-box-meta' }, 'opening ' + formatMoney(r.account.openingBalance))
           : null
       );
     }));
   
     // Two badges so an outstanding udhaar is visible without opening the tab.
     const badges = [];
     if (u.receive > 0) {
       badges.push(h('span', { class: 'u-badge u-badge-in' },
         h('span', { class: 'u-badge-amount' }, formatMoney(u.receive, { signed: true })),
         h('span', { class: 'u-badge-label' }, 'owed to you')
       ));
     }
     if (u.pay > 0) {
       badges.push(h('span', { class: 'u-badge u-badge-out' },
         h('span', { class: 'u-badge-amount' }, formatMoney(-u.pay)),
         h('span', { class: 'u-badge-label' }, 'you owe')
       ));
     }
   
     mount($('udhaarLine'), badges.length
       ? h('div', { class: 'u-badges' }, badges)
       : h('span', { class: 'udhaar-line muted' }, 'No outstanding udhaar'));
   }
   
   /* ---------- accounts tab ---------- */
   
   function renderAccounts() {
     const { rows, total } = allAccountBalances();
     const list = $('accountList');
     // Balances stay lifetime — money does not vanish at month end — but the
     // in/out flow underneath is scoped to the selected month, like everywhere
     // else. Last month's traffic next to this month's balance is what made the
     // tab unreadable.
     const per = validViewPeriod(viewAcctPeriod);
     viewAcctPeriod = per === currentPeriod() ? null : per;
     const perSel = $('acctPeriod');
     if (perSel) fillPeriodSelect(perSel, { selected: per });
     const b = periodBoundsOf(per);
   
     mount($('accountTotal'), h('span', { class: 'label' }, 'Total across ' + rows.length + ' account(s)'),
       h('span', { class: 'value' }, formatMoney(total)));
   
     if (!rows.length) {
       mount(list, h('div', { class: 'empty-state' }, 'No accounts. Add one below.'));
     } else {
       mount(list, rows.map((r) => {
         const act = accountActivity(r.account.id, b.start, b.end);
         const tint = accountTint(r.account.kind);
         return h('div', { class: 'acct-item' + (r.account.archived ? ' is-archived' : '') },
           h('div', { class: 'acct-head' },
             h('span', { class: 'acct-name' },
               h('span', { class: 'acct-kind', style: 'background:' + tint.bg + ';color:' + tint.ink }, r.account.kind),
               r.account.name),
             h('span', { class: 'acct-balance' + (r.balance < 0 ? ' neg' : '') }, formatMoney(r.balance))
           ),
           h('div', { class: 'acct-meta' },
             'in ' + formatMoney(act.income) + '  ·  out ' + formatMoney(act.expense) +
             (act.transferIn || act.transferOut
               ? '  ·  moved in ' + formatMoney(act.transferIn) + ' / out ' + formatMoney(act.transferOut)
               : '')),
           r.account.openingBalance
             ? h('div', { class: 'acct-meta' }, 'Opening balance ' + formatMoney(r.account.openingBalance))
             : null,
           h('div', { class: 'acct-actions' },
             button(r.account.archived ? 'Unarchive' : 'Archive', 'acct-archive', { id: r.account.id }),
             button('Rename', 'acct-rename', { id: r.account.id }),
             button('Opening balance', 'acct-opening', { id: r.account.id }),
             countTransactionsForAccount(r.account.id) === 0
               ? button('Delete', 'acct-delete', { id: r.account.id, class: 'btn-mini danger' })
               : null
           )
         );
       }));
     }
   
     const allTransfers = transferList();
     const transfers = allTransfers.filter((t) => inPeriod(t.date, per));
     mount($('transferList'),
       h('div', { class: 'tx-detail' }, 'Showing ' + periodLabel(per)),
       transfers.length
       ? transfers.slice(0, 20).map((t) => h('div', { class: 'transfer-item' },
           h('div', { class: 'transfer-head' },
             h('span', { class: 'transfer-route' },
               accountName(t.accountId) + '  →  ' + accountName(t.toAccountId)),
             h('span', { class: 'transfer-amount' }, formatMoney(t.amount))
           ),
           h('div', { class: 'tx-detail' },
             [t.comment, formatDate(t.date)].filter(Boolean).join(' · ')),
           h('div', { class: 'tx-actions' },
             button('Edit', 'tx-edit', { id: t.id }),
             button('Delete', 'tx-delete', { id: t.id, class: 'btn-mini danger' })
           )
         ))
       : h('div', { class: 'empty-state' }, allTransfers.length
           ? 'No transfers in ' + periodLabel(per) + '.'
           : 'No transfers yet. Use "Move between accounts" on the Home tab.'));
   }
   
   /** What is left after this month's budgets.
    *
    *  What is already spent comes out of its budget FIRST: a budget of 10,000
    *  with 3,000 spent still reserves only 7,000. The spent money already left
    *  the accounts, so reserving the full limit would count it twice — once gone
    *  from the balance, once more as "set aside". Hence:
    *  Remaining = balance − Σ max(0, limit − used).
    *  Overspending reserves nothing further (there is nothing left to reserve);
    *  it already shrank the balance, so it needs no extra subtraction — it is
    *  reported separately, purely as information. A pure function so the maths
    *  is testable without rendering. */
   function budgetSummary(period) {
     // Counted, not just spent: moved spending applies here exactly as on the
     // rows, so the summary and the list can never disagree.
     const limits = budgetsFor(period);
     let used = 0;
     let reserved = 0;
     let overExtra = 0;
     for (const cat of Object.keys(limits)) {
       const limit = limits[cat];
       const catUsed = budgetCounted(cat, period);
       used = round2(used + catUsed);
       reserved = round2(reserved + Math.max(0, round2(limit - catUsed)));
       overExtra = round2(overExtra + Math.max(0, round2(catUsed - limit)));
     }
     const available = allAccountBalances().total;
     return { available, used, reserved, overExtra, remaining: round2(available - reserved) };
   }
   
   function renderBudgets() {
     const period = activeBudgetPeriod();
     const periodPicker = $('budgetPeriod');
     if (periodPicker) fillPeriodSelect(periodPicker, { selected: period });
   
     const { start, end } = periodBoundsOf(period);
     const today = endOfToday();
     const windowEnd = end < today ? end : today;
     const live = start <= windowEnd;
   
     const monthSpend = live ? spendByCategory(start, windowEnd) : new Map();
     const monthIncome = live ? incomeByCategory(start, windowEnd) : new Map();
     const limits = budgetsFor(period);
   
     const head = h('div', { class: 'budget-period-head' },
       h('span', { class: 'pill pill-name' }, periodLabel(period)),
       isClosed(period) ? h('span', { class: 'pill pill-closed' }, 'Closed') : null,
       period === currentPeriod() ? h('span', { class: 'pill pill-now' }, 'This month') : null
     );
   
     const cats = Object.keys(limits);
     const body = !cats.length
       ? h('div', { class: 'empty-state' }, 'No budgets set for ' + periodLabel(period))
       : h('div', { class: 'budget-list' }, cats.map((cat) => {
           const limit = limits[cat];
           const gross = monthSpend.get(cat) || 0;
           const offset = offsetOn(cat);
           const inc = offset ? (monthIncome.get(cat) || 0) : 0;
           // Counted, not just spent: moves in and out of this budget apply here,
           // so the row, the summary and the fix dialog always show one number.
           const used = budgetCounted(cat, period);
           const pct = limit > 0 ? (used / limit) * 100 : 0;
           const over = used > limit;
           const level = pct >= 100 ? 'over' : pct >= 70 ? 'warn' : 'ok';
   
           return h('div', { class: 'budget-item' },
             h('div', { class: 'budget-header' },
               h('span', {}, cat),
               h('span', { class: 'budget-spent' },
                 formatMoney(used) + ' / ' + formatMoney(limit) + '  (' + Math.round(pct) + '%)')
             ),
             h('div', {
               class: 'progress-bar',
               role: 'progressbar',
               'aria-valuenow': String(Math.round(pct)),
               'aria-valuemin': '0',
               'aria-valuemax': '100',
               'aria-label': cat + ' budget'
             }, h('div', { class: 'progress-fill ' + level, style: 'width:' + Math.min(100, pct) + '%' })),
             over
               ? h('div', { class: 'budget-over' }, 'Over budget by ' + formatMoney(used - limit))
               : h('div', { class: 'budget-left' }, formatMoney(limit - used) + ' left this month'),
             liveBudgetMoves(period).filter((m) => m.from === cat).map((m) =>
               h('div', { class: 'budget-breakdown' },
                 formatMoney(m.amount) + ' counted under ' + m.to + ' ',
                 h('button', {
                   type: 'button', class: 'budget-undo',
                   dataset: { act: 'budget-move-undo', arg: m.id },
                   'aria-label': 'Stop counting ' + formatMoney(m.amount) + ' under ' + m.to
                 }, 'Undo'))),
             liveBudgetMoves(period).filter((m) => m.to === cat).map((m) =>
               h('div', { class: 'budget-breakdown' },
                 'Includes ' + formatMoney(m.amount) + ' counted from ' + m.from)),
             inc > 0
               ? h('div', { class: 'budget-breakdown' },
                   'Spent ' + formatMoney(gross) + ' − income ' + formatMoney(inc) + ' = ' + formatMoney(used) + ' counted')
               : null,
             h('label', { class: 'check budget-toggle' },
               h('input', { type: 'checkbox', checked: offset, dataset: { act: 'budget-offset', arg: cat } }),
               h('span', {}, 'Income in this category reduces the budget')
             ),
             over
               ? h('button', { type: 'button', class: 'budget-adjust', dataset: { act: 'budget-fix', arg: cat }, 'aria-label': 'Fix over-budget ' + cat + ' from another budget' }, 'Fix…')
               : null,
             h('button', { type: 'button', class: 'budget-remove', dataset: { act: 'budget-delete', arg: cat }, 'aria-label': 'Remove budget for ' + cat }, 'Remove budget')
           );
         }));
   
     mount($('budgetList'), head, body);
     const prevBudgetCat = $('budgetCategory') ? $('budgetCategory').value : '';
     fillCategorySelect($('budgetCategory'), { selected: prevBudgetCat });
   
     // What is left after this month's budgets. Only shown once at least one
     // budget exists — an empty month needs no summary.
     const sumBox = $('budgetSummary');
     if (sumBox) {
       if (!cats.length) {
         mount(sumBox);
       } else {
         const sum = budgetSummary(period);
         mount(sumBox,
           h('div', { class: 'budget-summary' },
             h('div', { class: 'budget-sum-row' },
               h('span', {}, 'Available total'),
               h('span', {}, formatMoney(sum.available))),
             // Informational only: this money already left the balance above, so
             // it carries no minus sign — subtracting it again is exactly the
             // double-count this box used to do.
             h('div', { class: 'budget-sum-row' },
               h('span', {}, 'Spent from budgets'),
               h('span', {}, formatMoney(sum.used))),
             h('div', { class: 'budget-sum-row' },
               h('span', {}, 'Still reserved in budgets'),
               h('span', {}, '− ' + formatMoney(sum.reserved))),
             sum.overExtra > 0
               ? h('div', { class: 'budget-sum-row over' },
                 h('span', {}, 'Over budget by'),
                 h('span', {}, formatMoney(sum.overExtra)))
               : null,
             h('div', { class: 'budget-sum-row remaining' },
               h('span', {}, 'Remaining (saving)'),
               h('span', {}, formatMoney(sum.remaining)))
           )
         );
       }
     }
   }
   
   function renderTransactions() {
     const input = $('txSearch');
     const search = String((input && input.value) || '').trim().toLowerCase();
     const list = $('txList');
     const per = validViewPeriod(viewTxPeriod);
     viewTxPeriod = per === currentPeriod() ? null : per;
     const perSel = $('txPeriod');
     if (perSel) fillPeriodSelect(perSel, { selected: per });
     // Account filter, re-validated like the month: rebuilt every render so a
     // renamed account never leaves a stale label, and a deleted one falls back
     // to all instead of a blank list under a stale selection.
     const acctSel = $('txAcctFilter');
     const acctId = activeTxAccount();
     viewTxAccount = acctId;
     if (acctSel) {
       mount(acctSel,
         h('option', { value: '' }, 'All transactions'),
         state.accounts.map((a) => h('option', { value: a.id },
           a.archived ? a.name + ' (archived)' : a.name)));
       acctSel.value = acctId;
     }
     // Category filter, same contract: rebuilt and re-validated every render.
     const catSel = $('txCatFilter');
     const catName = activeTxCategory();
     viewTxCategory = catName;
     if (catSel) {
       mount(catSel,
         h('option', { value: '' }, 'All categories'),
         state.categories.map((c) => h('option', { value: c }, c)));
       catSel.value = catName;
     }
   
     // Sorted here rather than with a locale-aware comparator so the order is
     // identical in every browser. The id tiebreak matters because several records
     // can share a minute: without it, Array.sort is not guaranteed stable across
     // engines and rows would jump around between renders.
     let rows = state.transactions.slice().sort((a, b) => {
       const diff = new Date(b.date) - new Date(a.date);
       return diff !== 0 ? diff : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
     });
   
     // The month comes first: searching "salary" in October must not drag in
     // September's salary as well, or the picker is decoration.
     rows = rows.filter((t) => inPeriod(t.date, per));
   
     // Then the account: either side of a transfer counts, so moving money
     // between wallets is found from both ends.
     if (acctId) rows = rows.filter((t) => t.accountId === acctId || t.toAccountId === acctId);
   
     // Then the category, by exact filing — a transfer has none, so an active
     // category filter hides transfers, which belong to no bucket by design.
     if (catName) rows = rows.filter((t) => t.category === catName);
   
     if (search) {
       rows = rows.filter((t) => {
         const cat = String(t.category || '').toLowerCase();
         const comment = String(t.comment || '').toLowerCase();
         const amount = String(t.amount);
         const grouped = amount.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
         // Account names count for every row, not just transfers: typing
         // "NayaPay" must find the salary that landed in NayaPay, or the search
         // is a trap — it looks like it covers everything and silently misses.
         const route = t.type === 'transfer'
           ? (accountName(t.accountId) + ' ' + accountName(t.toAccountId)).toLowerCase()
           : accountName(t.accountId).toLowerCase();
         return cat.includes(search) || comment.includes(search) || amount.includes(search) ||
           grouped.includes(search) || route.includes(search);
       });
     }
   
     if (!rows.length) {
       const scope = (acctId ? ' for ' + accountName(acctId) : '') + (catName ? ' in ' + catName : '');
       mount(list, h('div', { class: 'empty-state' }, search
         ? 'No transactions match "' + search + '"' + scope + ' in ' + periodLabel(per)
         : 'No transactions' + scope + ' in ' + periodLabel(per)));
       return;
     }
   
     mount(list, rows.map((t) => {
       if (t.type === 'transfer') {
         return h('div', { class: 'tx-item is-transfer' },
           h('div', { class: 'tx-header' },
             h('span', { class: 'tx-category' },
               h('span', { class: 'tx-kind' }, 'move'),
               accountName(t.accountId) + '  →  ' + accountName(t.toAccountId)),
             h('span', { class: 'tx-amount transfer' }, formatMoney(t.amount))
           ),
           t.comment ? h('div', { class: 'tx-detail' }, t.comment) : null,
           h('div', { class: 'tx-detail' }, formatDate(t.date) + ' · not counted as income or spending'),
           h('div', { class: 'tx-actions' },
             button('Edit', 'tx-edit', { id: t.id }),
             button('Delete', 'tx-delete', { id: t.id, class: 'btn-mini danger' })
           )
         );
       }
       const isIncome = t.type === 'income';
       return h('div', { class: 'tx-item' },
         h('div', { class: 'tx-header' },
           h('span', { class: 'tx-category' }, t.category,
             h('span', { class: 'tx-account' }, accountName(t.accountId))),
           h('span', { class: 'tx-amount ' + t.type }, (isIncome ? '+' : '−') + ' ' + formatMoney(t.amount))
         ),
         t.comment ? h('div', { class: 'tx-detail' }, t.comment) : null,
         t.source ? h('div', { class: 'tx-detail tx-linked' }, sourceLabel(t.source)) : null,
         h('div', { class: 'tx-detail' }, formatDate(t.date)),
         h('div', { class: 'tx-actions' },
           button('Edit', 'tx-edit', { id: t.id }),
           button('Delete', 'tx-delete', { id: t.id, class: 'btn-mini danger' })
         )
       );
     }));
   }
   
   function renderDebts() {
     const list = $('debtList');
     if (!state.debts.length) {
       mount(list, h('div', { class: 'empty-state' }, 'No udhaar entries yet'));
       return;
     }
   
     const u = udhaarTotals();
     const byDateDesc = (a, b) => {
       const diff = new Date(b.date) - new Date(a.date);
       return diff !== 0 ? diff : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
     };
     const open = state.debts.filter((d) => !d.settled).sort(byDateDesc);
     const done = state.debts.filter((d) => d.settled).sort(byDateDesc);
   
     const children = [
       h('div', { class: 'udhaar-summary' },
         h('div', { class: 'udhaar-box owed-to-me' },
           h('div', { class: 'udhaar-box-label' }, 'Owed to me'),
           h('div', { class: 'udhaar-box-value' }, formatMoney(u.receive))
         ),
         h('div', { class: 'udhaar-box i-owe' },
           h('div', { class: 'udhaar-box-label' }, 'I owe'),
           h('div', { class: 'udhaar-box-value' }, formatMoney(u.pay))
         )
       )
     ];
   
     if (!open.length) children.push(h('div', { class: 'empty-state' }, 'Nothing outstanding'));
   
     open.forEach((d) => children.push(
       h('div', { class: 'debt-item' },
         h('div', { class: 'debt-header' },
           h('span', { class: 'debt-person' }, d.person),
           h('span', { class: 'debt-amount ' + d.type }, (d.type === 'receive' ? '+' : '−') + ' ' + formatMoney(d.amount))
         ),
         h('div', { class: 'debt-detail' },
           d.type === 'receive' ? 'owes me' : 'I owe',
           d.note ? ' · ' + d.note : '',
           d.ledger ? '' : ' · not tracked in balance'
         ),
         h('div', { class: 'debt-detail' },
           debtCategory(d) + ' · ' + (d.accountId && findAccount(d.accountId) ? accountName(d.accountId) : 'no account movement')),
         h('div', { class: 'debt-detail' }, 'Added ' + formatDate(d.date)),
         h('div', { class: 'debt-actions' },
           button('Settle', 'debt-settle', { id: d.id, class: 'btn-mini settle' }),
           button('Return some', 'debt-return', { id: d.id }),
           button('Edit', 'debt-edit', { id: d.id }),
           button('Delete', 'debt-delete', { id: d.id, class: 'btn-mini danger' })
         )
       )
     ));
   
     if (done.length) {
       children.push(h('div', { class: 'debt-settled-head' }, 'Settled (' + done.length + ')'));
       done.forEach((d) => children.push(
         h('div', { class: 'debt-item is-settled' },
           h('div', { class: 'debt-header' },
             h('span', { class: 'debt-person' }, d.person),
             h('span', { class: 'debt-amount' },
               (d.type === 'receive' ? '+' : '−') + ' ' + formatMoney(d.amount) + ' · ' + (d.type === 'receive' ? 'received' : 'paid'))
           ),
           d.note ? h('div', { class: 'debt-detail' }, d.note) : null,
           h('div', { class: 'debt-detail' }, 'Settled ' + formatDate(d.settledAt || d.date)),
           h('div', { class: 'debt-actions' },
             button('Unsettle', 'debt-settle', { id: d.id, class: 'btn-mini settle' }),
             button('Edit', 'debt-edit', { id: d.id }),
             button('Delete', 'debt-delete', { id: d.id, class: 'btn-mini danger' })
           )
         )
       ));
     }
   
     mount(list, children);
   }
   
   function renderCategories() {
     const list = $('categoryList');
     if (!state.categories.length) {
       mount(list, h('div', { class: 'empty-state' }, 'No categories. Add one below.'));
     } else {
       const counts = new Map();
       for (const t of state.transactions) {
         const key = t.category.toLowerCase();
         counts.set(key, (counts.get(key) || 0) + 1);
       }
       // This month's counted spend per category, so every row shows where it
       // stands — management at a glance instead of a trip to Budget per row.
       const per = currentPeriod();
       const limits = budgetsFor(per);
       mount(list, state.categories.map((cat, i) => {
         // Counted, like the budget row: moved spending applies here too.
         const spent = budgetCounted(cat, per);
         const limit = Object.prototype.hasOwnProperty.call(limits, cat) ? limits[cat] : null;
         const pct = limit ? (spent / limit) * 100 : 0;
         const level = !limit ? '' : pct >= 100 ? 'over' : pct >= 70 ? 'warn' : 'ok';
         return h('div', {
           class: 'category-item', draggable: 'true',
           dataset: { catRow: cat },
           'aria-label': cat + ', position ' + (i + 1) + ' of ' + state.categories.length
         },
           h('div', { class: 'category-info' },
             h('span', { class: 'category-name' }, cat),
             h('span', { class: 'category-count' },
               (counts.get(cat.toLowerCase()) || 0) + ' transaction(s)' + (offsetOn(cat) ? ' · income offsets budget' : '')),
             (spent > 0 || limit !== null)
               ? h('div', { class: 'category-month' },
                 limit !== null
                   ? h('div', { class: 'progress-bar', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': cat + ' spending this month' },
                     h('div', { class: 'progress-fill ' + level, style: 'width:' + Math.min(100, pct) + '%' }))
                   : null,
                 h('span', { class: 'category-month-text' },
                   formatMoney(spent) + ' this month' + (limit !== null ? ' of ' + formatMoney(limit) : '')))
               : null
           ),
           h('div', { class: 'category-move' },
             iconButton('↑', 'cat-up', { arg: cat, title: 'Move ' + cat + ' up' }),
             iconButton('↓', 'cat-down', { arg: cat, title: 'Move ' + cat + ' down' }),
             iconButton('✕', 'category-delete', { arg: cat, title: 'Delete category ' + cat })
           )
         );
       }));
     }
     refreshSelects();
   }
   
   function renderShopping() {
     // A new month unticks the standing list (see maybeResetShopping). The reset
     // persists once via save(); the second pass finds nothing to do, so this
     // cannot loop — one extra render per month change, no more.
     if (maybeResetShopping()) { save(); return; }
     const list = $('itemList');
     const open = state.shopping.filter((s) => !s.checked);
     const done = state.shopping.filter((s) => s.checked);
   
     // The "save as expense" form lives in static markup below this container.
     // Hiding it when nothing is ticked keeps the panel from offering an action
     // that would only produce an error message.
     const buyForm = $('buyForm');
     if (buyForm) buyForm.hidden = done.length === 0;
   
     const head = h('div', { class: 'list-summary' },
       h('div', { class: 'list-count' }, open.length + ' to buy'),
       h('div', { class: 'list-count muted' }, done.length + ' bought')
     );
   
     if (!state.shopping.length) {
       mount(list, head, h('div', { class: 'empty-state' }, 'Your list is empty. Add what you need below.'));
       return;
     }
   
     const children = [head];
   
     if (open.length) {
       children.push(h('div', { class: 'list-section-head' }, 'To buy'));
       open.forEach((s) => children.push(
         h('div', { class: 'list-item' },
           h('button', {
             type: 'button', class: 'tick', 'aria-pressed': 'false',
             'aria-label': 'Tick ' + s.name, dataset: { act: 'item-toggle', id: s.id }
           }, ''),
           h('div', { class: 'list-info' },
             h('span', { class: 'list-name' }, s.name),
             h('span', { class: 'list-meta' }, [s.qty, s.note].filter(Boolean).join(' · ') || 'Added ' + formatDate(s.createdAt))
           ),
           iconButton('✕', 'item-delete', { id: s.id, title: 'Remove ' + s.name })
         )
       ));
     }
   
     if (done.length) {
       children.push(h('div', { class: 'list-section-head' }, 'Bought (' + done.length + ')'));
       done.forEach((s) => children.push(
         h('div', { class: 'list-item is-done' },
           h('button', {
             type: 'button', class: 'tick is-ticked', 'aria-pressed': 'true',
             'aria-label': 'Untick ' + s.name, dataset: { act: 'item-toggle', id: s.id }
           }, '✓'),
           h('div', { class: 'list-info' },
             h('span', { class: 'list-name' }, s.name),
             h('span', { class: 'list-meta' },
               'Bought ' + formatDate(s.checkedAt || s.createdAt) + (s.cost ? ' · ' + formatMoney(s.cost) : ''))
           ),
           iconButton('✕', 'item-delete', { id: s.id, title: 'Remove ' + s.name })
         )
       ));
       children.push(h('button', { type: 'button', class: 'btn btn-dark', dataset: { act: 'item-clear' } }, 'Clear bought items'));
     }
   
     mount(list, children);
   }
   
   /* ============================================================
      Sync panel
      ============================================================ */
   
   function relativeTime(ts) {
     if (!ts) return 'not yet';
     const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
     if (s < 10) return 'just now';
     if (s < 60) return s + 's ago';
     if (s < 3600) return Math.round(s / 60) + 'm ago';
     if (s < 86400) return Math.round(s / 3600) + 'h ago';
     return Math.round(s / 86400) + 'd ago';
   }
   
   function renderSyncPanel() {
     const S = window.CashFlowSync;
     const box = $('syncPanel');
     const dot = $('syncDot');
     if (!S || !box) return;
   
     const st = S.status;
     dot.hidden = !st.signedIn;
     if (st.signedIn) {
       dot.className = 'sync-dot ' + (st.syncing ? 'is-syncing' : st.error ? 'is-warn' : 'is-ok');
       dot.title = st.syncing ? 'Syncing…' : st.error ? st.error : 'Synced ' + relativeTime(st.lastSyncAt);
     }
   
     if (st.signedIn) {
       mount(box,
         h('div', { class: 'sync-line' },
           h('span', { class: 'sync-who' }, st.email),
           h('span', { class: 'sync-when' }, st.syncing ? 'syncing…' : 'synced ' + relativeTime(st.lastSyncAt))
         ),
         st.error ? h('p', { class: 'sync-error' }, st.error) : null,
         h('p', { class: 'field-hint' }, 'Any change you make on any device reaches the others within a minute.'),
         h('div', { class: 'btn-row mt-10' },
           button('Sync now', 'sync-now'),
           button('Sign out', 'sync-signout')
         ),
         h('details', { class: 'sync-repair' },
           h('summary', {}, 'Cloud copy looks wrong?'),
           h('p', { class: 'field-hint' },
             'If the cloud database was reset, emptied or rebuilt, this device still ' +
             'has your records but the app believes they were already sent, so nothing ' +
             'uploads and no error appears. This compares the two and re-sends whatever ' +
             'is missing.'),
           h('div', { class: 'btn-row' },
             button('Check and re-upload', 'sync-repair')
           ),
           repairReport ? h('pre', { class: 'sync-repair-out' }, repairReport) : null
         )
       );
       return;
     }
   
     /* The signed-out forms are rebuilt by every save() (renderAll reaches here),
        which threw away a half-typed email or password whenever anything else in
        the app was saved. Rebuild only when the mode actually changes or the form
        is gone — the first render still builds it, a sign-out rebuilds it, and a
        mid-reset step (code / new password) swaps it, but an unrelated save no
        longer wipes the fields. The delegated submit handlers in wireEvents()
        survive this because they listen on document, not on the element. */
     const formId = resetMode === 'newpw' ? 'newPwForm'
       : resetMode === 'code' ? 'resetCodeForm'
         : 'authForm';
     if (box.querySelector('form#' + formId)) return;
   
     mount(box, ...(resetMode === 'newpw'
       ? [newPasswordForm(S)]
       : resetMode === 'code'
         ? [resetCodeForm(S)]
         : [signInForm(S)]));
   }
   
   /* The signed-out panel has three states, in order of how far through the
      reset the user is. Kept as separate builders so each one is short enough to
      read, rather than one form with a dozen hidden fields. */
   
   function signInForm(S) {
     return h('form', { id: 'authForm', novalidate: true },
       h('div', { class: 'form-group' },
         h('label', { class: 'field-label', for: 'authEmail' }, 'Email'),
         // Pre-filled after a reset attempt, so going Back to this form does not
         // make the user retype an address they have already typed twice.
         h('input', {
           id: 'authEmail', type: 'email', inputmode: 'email',
           placeholder: 'you@example.com', autocomplete: 'username',
           value: resetEmail || ''
         })
       ),
       h('div', { class: 'form-group' },
         h('label', { class: 'field-label', for: 'authPassword' }, 'Password'),
         h('input', {
           id: 'authPassword', type: 'password',
           placeholder: 'At least ' + S.MIN_PASSWORD + ' characters',
           autocomplete: 'current-password'
         }),
         h('p', { class: 'field-hint' },
           'This app works offline without an account. Sign in only if you want your data on more than one device.')
       ),
       h('div', { class: 'btn-row' },
         h('button', { class: 'btn btn-primary', type: 'submit', dataset: { act: 'auth-in' } }, 'Sign in'),
         h('button', { class: 'btn btn-dark', type: 'button', dataset: { act: 'auth-up' } }, 'Create account')
       ),
       h('p', { class: 'auth-alt' },
         h('button', { class: 'linkish', type: 'button', dataset: { act: 'auth-forgot' } }, 'Forgot your password?')
       )
     );
   }
   
   /** Shown after the reset email was sent. The code is the only way through.
    *  Both ways in are offered, because which one is available depends on how the
    *  project is set up and the user cannot be expected to know which:
    *
    *    - The LINK works with no extra setup at all, as long as the project's
    *      redirect URL is configured. Clicking it opens this app with a token in
    *      the address, and pickRecoveryFromUrl() picks it up. It was briefly
    *      removed because a project with no redirect URL sends the link to
    *      localhost:3000 instead — a dead page saying "This site can't be
    *      reached", which looks like the app is broken. With the redirect URL set,
    *      the link is the simpler path and it is first.
    *
    *    - The CODE needs the email template edited, and Supabase only allows
    *      that once custom SMTP is configured. Until then the template is fixed and
    *      the email carries no code, so this box is a fallback rather than the
    *      main event. */
   function resetCodeForm(S) {
     return h('form', { id: 'resetCodeForm', novalidate: true },
       h('p', { class: 'sync-msg' },
         'If that email exists, a link is on its way to ',
         h('strong', {}, resetEmail || 'it'),
         '. It can take a minute or two, and it may land in spam.'),
       h('p', { class: 'field-hint' },
         'Open the link in the email on this device and it brings you straight back here to set a new password.'),
       h('details', { class: 'reset-code-alt' },
         h('summary', {}, 'My email shows a code instead of a link'),
         h('div', { class: 'form-group' },
           h('label', { class: 'field-label', for: 'resetCode' }, 'Code from the email'),
           h('input', {
             id: 'resetCode', type: 'text', inputmode: 'numeric',
             autocomplete: 'one-time-code', placeholder: '6-digit code'
           })
         ),
         h('div', { class: 'btn-row' },
           h('button', { class: 'btn btn-primary', type: 'submit' }, 'Continue')
         )
       ),
       h('div', { class: 'btn-row mt-10' },
         h('button', { class: 'btn btn-dark', type: 'button', dataset: { act: 'reset-cancel' } }, 'Back'),
         h('button', { class: 'btn btn-dark', type: 'button', dataset: { act: 'reset-resend' } }, 'Send it again')
       )
     );
   }
   
   /** Shown once a recovery token is in hand. */
   function newPasswordForm(S) {
     return h('form', { id: 'newPwForm', novalidate: true },
       h('p', { class: 'sync-msg' }, 'That code checked out. Choose a new password.'),
       h('div', { class: 'form-group' },
         h('label', { class: 'field-label', for: 'newPw1' }, 'New password'),
         h('input', {
           id: 'newPw1', type: 'password', autocomplete: 'new-password',
           placeholder: 'At least ' + S.MIN_PASSWORD + ' characters'
         })
       ),
       h('div', { class: 'form-group' },
         h('label', { class: 'field-label', for: 'newPw2' }, 'Type it again'),
         h('input', { id: 'newPw2', type: 'password', autocomplete: 'new-password', placeholder: 'Same password' })
       ),
       h('p', { class: 'auth-alt' },
         h('button', { class: 'linkish', type: 'button', dataset: { act: 'reset-cancel' } }, 'Start over')
       ),
       h('div', { class: 'btn-row' },
         h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save new password')
       )
     );
   }
   
   async function handleAuth(mode) {
     const S = window.CashFlowSync;
     if (!S) { toast('Sync is unavailable'); return; }
     const email = $('authEmail').value;
     const password = $('authPassword').value;
   
     const bad = S.validateCredentials(email, password);
     if (bad) { toast(bad); return; }
   
     // This browser may still hold another account's records: signing out keeps
     // them by design. Uploading them under the new address would hand one
     // person's whole ledger to the other account, so the takeover is made
     // explicit before a single row leaves.
     const owner = S.dataOwner;
     const target = String(email).trim().toLowerCase();
     if (owner && owner.email && String(owner.email).toLowerCase() !== target) {
       const holdsData = !!(state.transactions.length || state.debts.length || state.custody.length
         || state.shopping.length || (state.settings.notes && state.settings.notes.length)
         || state.accounts.length > 3);
       if (holdsData) {
         const go = confirm('This browser still holds records that belong to ' + owner.email
           + '.\n\nSigning in as ' + target + ' will UPLOAD all of them to that account'
           + (mode === 'up' ? ' (the new one you are creating)' : '')
           + '.\n\nContinue?');
         if (!go) {
           // The form is left exactly as it was: rebuilding it here would throw
           // away the password the user already typed, and make them retype it
           // just to change their mind about the address.
           toast('Cancelled — nothing was uploaded');
           return;
         }
       }
     }
   
     const btn = document.querySelector('[data-act="auth-' + (mode === 'up' ? 'up' : 'in') + '"]');
     if (btn) btn.disabled = true;
     $('authPassword').value = '';
     toast(mode === 'up' ? 'Creating your account…' : 'Signing in…');
   
     const res = mode === 'up' ? await S.signUp(email, password) : await S.signIn(email, password);
   
     if (btn) btn.disabled = false;
   
     if (res.error) { toast(res.error); renderSyncPanel(); return; }
     if (res.needsEmailConfirm) {
       toast('Check your email to confirm the account, then sign in');
       return;
     }
   
     // The debounced push needs a way to reach the live state, and the poll loop
     // has to start now that there is a session.
     S.setStateProvider(() => state);
     // A pull can deliver same-name accounts under different ids; fold them
     // before painting so the pair never reaches the screen.
     S.setPersist(() => { try { if (!mergeDuplicateAccounts({ silent: true })) save(); } catch (err) { save(); } });
     await S.cycle(state, { silent: true });
     S.start(() => state);
     renderAll();
     toast(mode === 'up' ? 'Account created — your data is now backed up' : 'Signed in — syncing');
   }
   
   /* ---------- forgot password ---------- */
   
   /* The reset flow lives in the same panel as sign-in, so it is a mode on that
      panel rather than a separate screen. `resetMode` is the only state: what the
      user is looking at is fully determined by it, so it cannot fall out of step
      with the DOM the way a pile of hidden inputs would. */
   let resetMode = null;   // null | 'code' | 'newpw'
   let resetEmail = null;
   
   async function beginPasswordReset() {
     const S = window.CashFlowSync;
     if (!S) return;
     /* Two ways in: the "Forgot your password?" link on the sign-in form, which
        has an email field, and "Send it again" on the code form, which does not —
        the panel only shows a code box at that point. Reading the field alone made
        resending dead on arrival with "type your email first", on a screen where
        there is nowhere to type one. */
     const field = $('authEmail');
     const email = (field && field.value.trim()) || resetEmail || '';
     if (!email) { toast('Type your email first, then press Forgot'); return; }
     // Only clear the password if it is on screen. Resending starts from the code
     // panel, which has no password field, and reading it blindly threw and killed
     // the resend outright.
     const pw = $('authPassword');
     if (pw) pw.value = '';
     toast('Sending…');
     const res = await S.requestPasswordReset(email);
     if (res.error) { toast(res.error); return; }
     resetEmail = res.email;
     resetMode = 'code';
     renderSyncPanel();
     toast('If that address has an account, a code is on its way');
   }
   
   async function submitResetCode() {
     const S = window.CashFlowSync;
     if (!S) return;
     const code = $('resetCode').value;
     const email = resetEmail || S.resetEmail || '';
     const btn = $('resetCodeForm').querySelector('button[type="submit"]');
     if (btn) btn.disabled = true;
     const res = await S.verifyResetCode(email, code);
     if (btn) btn.disabled = false;
     if (res.error) { toast(res.error); return; }
     resetMode = 'newpw';
     renderSyncPanel();
     const first = $('newPw1');
     if (first) first.focus();
   }
   
   async function submitNewPassword() {
     const S = window.CashFlowSync;
     if (!S) return;
     const a = $('newPw1').value;
     const b = $('newPw2').value;
     // Checked here as well as server-side, so a typo does not cost a round trip.
     if (a !== b) { toast('The two passwords are not the same'); return; }
     const btn = $('newPwForm').querySelector('button[type="submit"]');
     if (btn) btn.disabled = true;
     const res = await S.setNewPassword(a);
     if (btn) btn.disabled = false;
     if (res.error) { toast(res.error); renderSyncPanel(); return; }
   
     resetMode = null;
     resetEmail = null;
     $('newPw1').value = '';
     $('newPw2').value = '';
     renderSyncPanel();
     /* The password is already changed by this point, so the sign-in that follows
        is a convenience. If the address could not be recovered, saying "enter a
        valid email address" is both wrong and alarming — the user did nothing
        wrong, and their new password works. Say what actually happened instead. */
     if (!res.email) {
       toast('Password changed. Sign in with your email address.');
       renderSyncPanel();
       const f = $('authEmail');
       if (f) f.focus();
       return;
     }
     // Signed in automatically: the recovery token proves who they are, and
     // making them type the new password a second time helps nobody.
     $('authEmail').value = res.email;
     $('authPassword').value = a;
     await handleAuth('in');
   }
   
   /** Abandon the reset and go back to the sign-in form.
    *
    *  resetEmail is deliberately kept. The address is the one thing the user has
    *  already typed and does not want to type a third time, and throwing it away
    *  here is what made "Send it again" fail on a panel with no email field. It is
    *  cleared once the password is actually changed, and typing a different
    *  address always wins over it. */
   function cancelPasswordReset() {
     resetMode = null;
     renderSyncPanel();
   }
   
   function signOut() {
     const S = window.CashFlowSync;
     if (!S) return;
     if (!confirm('Sign out of this device?\n\nYour data stays in this browser and keeps working. It will just stop syncing to the cloud.')) return;
     S.signOut();
     renderAll();
     toast('Signed out. Everything still works here.');
   }
   
   /* Compare what the cloud actually holds against what this device holds, and
      re-send anything the cloud is missing. The push cursor is local state, so it
      can claim records were uploaded when the server was wiped or rebuilt — and
      then the app uploads nothing, forever, while cheerfully reporting "synced". */
   async function repairCloud() {
     const S = window.CashFlowSync;
     if (!S) { toast('Sync is unavailable'); return; }
     toast('Checking…');
     let res;
     try {
       res = await S.repairCloudCopy(state);
     } catch (err) {
       repairReport = 'Could not check: ' + (err && err.message ? err.message : 'unknown error');
       renderAll();
       return;
     }
     if (res.error) { toast(res.error); return; }
   
     // Plain sentences, not table slugs and counts: the report is shown verbatim,
     // so it must read as an answer — what was compared, what was missing, and
     // what happened about it.
     const lines = ['Cloud check · just now'];
     for (const e of res.report || []) {
       if (!e || typeof e !== 'object') continue;
       if (e.state === 'ok') {
         lines.push(e.label + ': ' + e.local + ' here, ' + e.remote + ' on the cloud — in step ✓');
       } else if (e.state === 'reupload') {
         const missing = e.local - e.remote;
         lines.push(e.label + ': ' + e.local + ' here, ' + e.remote + ' on the cloud — ' +
           missing + ' missing there, re-uploaded ↑');
       } else {
         lines.push(e.label + ': could not be checked (' + (e.detail || 'failed') + ')');
       }
     }
     repairReport = lines.join('\n');
     renderAll();
   
     if (res.reset) {
       renderSyncPanel();
       toast('Re-uploaded ' + res.totalRows + ' record(s) from this device');
     } else {
       toast('Everything is already in step');
     }
   }
   
   function renderAll() {
     renderBalance();
     renderHomeExtras();
     renderAccounts();
     renderBudgets();
     renderChallenges();
     renderTransactions();
     renderRecurring();
     renderDebts();
     renderTimers();
     renderNotes();
     renderCategories();
     renderShopping();
     renderReport();
     renderSyncPanel();
     renderThemeButtons();
     renderAccentSwatches();
     if ($('storageWarning')) $('storageWarning').hidden = storageUsable;
   }
   
   /* ============================================================
      Events
      ============================================================ */
   
   const ACTIONS = {
     'tab': (el) => showTab(el.dataset.tab),
     'tx-edit': (el) => openEditModal(el.dataset.id),
     'tx-delete': (el) => deleteTransaction(el.dataset.id),
     'debt-settle': (el) => settleDebt(el.dataset.id),
     'debt-return': (el) => returnDebtSome(el.dataset.id),
     'debt-edit': (el) => openDebtEditModal(el.dataset.id),
     'debt-delete': (el) => deleteDebt(el.dataset.id),
     'category-delete': (el) => removeCategory(el.dataset.arg),
     'cat-up': (el) => moveCategory(el.dataset.arg, -1),
     'cat-down': (el) => moveCategory(el.dataset.arg, 1),
     'budget-delete': (el) => removeBudget(el.dataset.arg),
     'budget-repeat': () => repeatLastMonthBudgets(),
     'budget-fix': (el) => openBudgetFix(el.dataset.arg),
     'budget-move-undo': (el) => undoBudgetMove(el.dataset.arg),
     'report': (el) => showReport(el.dataset.arg),
     'report-custom': applyCustomRange,
     'item-toggle': (el) => toggleListItem(el.dataset.id),
     'item-delete': (el) => deleteListItem(el.dataset.id),
     'item-clear': clearCheckedItems,
     'note-pin': (el) => toggleNotePin(el.dataset.id),
     'note-edit': (el) => openNoteEdit(el.dataset.id),
     'note-delete': (el) => deleteNote(el.dataset.id),
     'timer-reset': (el) => resetTimer(el.dataset.id),
     'timer-delete': (el) => deleteTimer(el.dataset.id),
     'acct-rename': (el) => renameAccount(el.dataset.id),
     'acct-opening': (el) => setOpeningBalance(el.dataset.id),
     'acct-archive': (el) => toggleArchiveAccount(el.dataset.id),
     'acct-delete': (el) => deleteAccount(el.dataset.id),
     'auth-in': () => handleAuth('in'),
     'auth-up': () => handleAuth('up'),
     'auth-forgot': () => beginPasswordReset(),
     'reset-cancel': () => cancelPasswordReset(),
     'reset-resend': () => beginPasswordReset(),
     'sync-now': () => { if (window.CashFlowSync) window.CashFlowSync.cycle(state).then(() => renderAll()); },
     'sync-signout': signOut,
     'sync-repair': repairCloud,
     'email-save': () => saveEmailRoute(),
     'email-remove': (el) => removeEmailRoute(el && el.dataset && el.dataset.id),
     'email-test': () => runEmailSelfTest(),
     'email-copy-url': () => copyEmailWebhookUrl(),
     'build-check': () => checkForNewerBuild(true),
     'theme-set': (el) => setTheme(el.dataset.arg),
     'accent-set': (el) => setAccent(el.dataset.arg),
     'undo': () => undoLast(),
     'tpl-use': (el) => useTemplate(el.dataset.id),
     'tpl-remove': (el) => removeTemplate(el.dataset.id),
     'goal-add': (el) => openGoalModal(el.dataset.id),
     'goal-remove': (el) => removeGoal(el.dataset.id),
     'rec-toggle': (el) => toggleRecurring(el.dataset.id),
     'rec-delete': (el) => deleteRecurring(el.dataset.id),
     'challenge-remove': (el) => removeChallenge(el.dataset.id),
     'export': () => exportBackup(),
     'import': importBackup,
     'reset': resetAll,
     'search-clear': clearTxSearch,
     'cloud-delete': deleteCloudData,
     'close-modal': (el) => closeModal(el.dataset.target),
     'approve-tx': (el) => approveTransaction(el.dataset.id),
     'reject-tx': (el) => rejectTransaction(el.dataset.id)
   };
   
   let eventsWired = false;
   
   /** Attach every listener exactly once. The app normally calls this from
    *  init(), which itself runs once, but a guarded flag keeps a second call
    *  (a re-init, a hot reload in dev) from double-firing every handler. */
   function wireEvents() {
     if (eventsWired) return;
     eventsWired = true;
   
     // one delegated listener for every data-act button in the app
     document.addEventListener('click', (e) => {
       if (!(e.target instanceof Element)) return;
       const el = e.target.closest('[data-act]');
       if (!el) return;
       const fn = ACTIONS[el.dataset.act];
       if (!fn) return;
       e.preventDefault();
       fn(el);
     });

     // Ctrl+Z backs out the last action — the Undo button's keyboard twin.
     // Inside a text field the browser's own editing-undo stays untouched.
     document.addEventListener('keydown', (e) => {
       if (!((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z'))) return;
       const tag = document.activeElement && document.activeElement.tagName;
       if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
       if (activeModalId) return;
       e.preventDefault();
       undoLast();
     });
   
     // change events (checkboxes, month pickers) need their own listener.
     // Order matters: a control with no data-act must not bail out early, or the
     // month picker would be ignored because it only carries an id.
     document.addEventListener('change', (e) => {
       if (!(e.target instanceof Element)) return;
   
       if (e.target.id === 'budgetPeriod') { changeBudgetPeriod(e.target.value); return; }
       if (e.target.id === 'txPeriod') { changeTxPeriod(e.target.value); return; }
       if (e.target.id === 'txAcctFilter') { changeTxAccount(e.target.value); return; }
       if (e.target.id === 'txCatFilter') { changeTxCategory(e.target.value); return; }
       if (e.target.id === 'acctPeriod') { changeAcctPeriod(e.target.value); return; }
       if (e.target.id === 'txType') { setTxTypeFields(); return; }
       if (e.target.id === 'editType') { setEditTypeFields(); return; }
       if (e.target.id === 'txSplitOn') {
         setHiddenSplit(!e.target.checked);
         return;
       }
       if (e.target.id === 'rolloverToggle') {
         state.settings.budgetRollover = e.target.checked;
         toast(e.target.checked
           ? 'On — the next new month keeps whatever is unused now'
           : 'Off — each month starts from the limits you set');
         save();
         return;
       }
   
       const el = e.target.closest('[data-act]');
       if (!el) return;
       if (el.dataset.act === 'budget-offset') {
         setOffset(el.dataset.arg, el.checked);
         save();
       }
     });
   
     // The sign-in and reset forms are built by renderSyncPanel(), which runs on
     // every save() and so replaces the element. A listener bound to the element
     // would be thrown away each time, and it could not be bound at all the first
     // time because the form does not exist yet when wireEvents() runs.
     // Delegating survives both problems. Pressing Enter in a field used to fall
     // through to an implicit form GET, which reloaded the page.
     const AUTH_FORMS = {
       authForm: () => handleAuth('in'),
       resetCodeForm: () => submitResetCode(),
       newPwForm: () => submitNewPassword()
     };
     document.addEventListener('submit', (e) => {
       if (!(e.target instanceof Element)) return;
       const fn = AUTH_FORMS[e.target.id];
       if (!fn) return;
       e.preventDefault();
       fn();
     });
   
     // forms give us Enter-to-submit for free
     const forms = [
       ['txForm', addTransaction],
       ['budgetForm', setBudget],
       ['debtForm', addDebt],
       ['rangeForm', applyCustomRange],
       ['categoryForm', (e) => addCategory($('newCategoryName'))],
       ['itemForm', addListItem],
       ['buyForm', saveListPurchase],
       ['accountForm', (e) => addAccount($('accountName'), $('accountKind'))],
       ['notesForm', addNote],
       ['timersForm', addTimer],
       ['editForm', saveEdit],
       ['editDebtForm', saveDebtEdit],
       ['noteEditForm', saveNoteEdit],
       ['budgetFixForm', saveBudgetFix],
       ['templateForm', addTemplate],
       ['goalForm', addGoal],
       ['recForm', addRecurring],
       ['challengeForm', addChallenge],
       ['goalModalForm', saveGoalPayment]
     ];
     forms.forEach(([id, handler]) => {
       const form = $(id);
       if (form) form.addEventListener('submit', (e) => { e.preventDefault(); handler(e); });
     });
   
     // debounced search
     let timer = null;
     const search = $('txSearch');
     if (search) {
       search.addEventListener('input', () => {
         clearTimeout(timer);
         timer = setTimeout(renderTransactions, 120);
       });
     }
     const noteSearch = $('notesSearch');
     if (noteSearch) {
       noteSearch.addEventListener('input', () => {
         clearTimeout(timer);
         timer = setTimeout(renderNotes, 120);
       });
     }
   
     // close modals on backdrop click
     ['editModal', 'editDebtModal', 'noteEditModal', 'budgetFixModal', 'choiceModal', 'goalModal'].forEach((id) => {
       const overlay = $(id);
       if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(id); });
     });
   
     // Drag-and-drop for the category list (desktop; touch uses the ↑ ↓ buttons).
     // Delegated like everything else, so re-renders cannot orphan the handlers.
     const catRowOf = (e) => {
       if (!(e.target instanceof Element) || !e.target.closest) return null;
       return e.target.closest('[data-cat-row]');
     };
     document.addEventListener('dragstart', (e) => {
       const row = catRowOf(e);
       if (!row || !row.dataset.catRow) return;
       dragCatName = row.dataset.catRow;
       try {
         e.dataTransfer.effectAllowed = 'move';
         e.dataTransfer.setData('text/plain', dragCatName);
       } catch (err) { /* some browsers restrict setData to specific types */ }
     });
     document.addEventListener('dragover', (e) => {
       const row = catRowOf(e);
       if (row && dragCatName) e.preventDefault();
     });
     document.addEventListener('drop', (e) => {
       const row = catRowOf(e);
       if (!row || !dragCatName) return;
       e.preventDefault();
       moveCategoryBefore(dragCatName, row.dataset.catRow);
       dragCatName = null;
     });
     document.addEventListener('dragend', () => { dragCatName = null; });
   
     document.addEventListener('keydown', handleModalKeys);
   
     // keep multiple open tabs in agreement
     window.addEventListener('storage', (e) => {
       if (e.key !== STORAGE_KEY && e.key !== null) return;
       const loaded = loadState();
       state = loaded.state;
       renderAll();
       toast(loaded.notice || 'Updated from another tab');
     });
   
     // back / forward between tabs
     window.addEventListener('hashchange', () => showTab(tabFromHash(), { silent: true }));
   
     // arrow-key walk along the tab bar
     const bar = $('tabBar');
     if (bar) {
       bar.addEventListener('keydown', (e) => {
         if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
         const i = TABS.findIndex((t) => t.id === activeTab);
         const next = e.key === 'ArrowRight'
           ? (i + 1) % TABS.length
           : (i - 1 + TABS.length) % TABS.length;
         e.preventDefault();
         showTab(TABS[next].id);
         const el = document.querySelector('[data-tab="' + TABS[next].id + '"]');
         if (el) el.focus();
       });
     }
   }
   
   /* ============================================================
      Boot
      ============================================================ */
   
   /* ============================================================
      Stale-asset guard
      ============================================================ */
   
   /* The service worker serves app files cache-first, so after a deploy the page
      can end up a mix of new HTML and an old script. The symptom is confusing:
      a tab that never appears, a dropdown that stays empty — each file is
      individually valid, they just disagree with each other. Two independent
      signals are checked here, and if either disagrees the caches are thrown away
      and the page reloaded once. */
   function staleAssetReason() {
     // 1. The build marker in the HTML against the one in the running script.
     const meta = document.querySelector('meta[name="app-build"]');
     const htmlBuild = meta ? meta.getAttribute('content') : null;
     const scriptBuild = (window.CASHFLOW_CONFIG && window.CASHFLOW_CONFIG.appBuild) || null;
     if (htmlBuild && scriptBuild && htmlBuild !== scriptBuild) {
       return 'the page is build ' + htmlBuild + ' but the script is build ' + scriptBuild;
     }
   
     // 2. The markup declares the tabs it provides; this script declares the tabs
     //    it knows how to build. A disagreement means the page is running an older
     //    script, which is what produced a missing tab and an empty dropdown.
     const metaTabs = document.querySelector('meta[name="app-tabs"]');
     if (metaTabs) {
       const promised = metaTabs.getAttribute('content').split(',').map((t) => t.trim()).filter(Boolean);
       const mine = TABS.map((t) => t.id);
       const unknown = promised.filter((id) => mine.indexOf(id) === -1);
       const missing = mine.filter((id) => promised.indexOf(id) === -1);
       if (unknown.length) return 'this page has tabs this script does not know: ' + unknown.join(', ');
       if (missing.length) return 'this script has tabs this page does not show: ' + missing.join(', ');
     }
   
     // 3. Every tab this script knows must have a panel in this HTML.
     const absent = TABS.filter((t) => !document.getElementById('panel-' + t.id));
     if (absent.length) {
       return 'this build of the page has no panel for: ' + absent.map((t) => t.label).join(', ');
     }
     return null;
   }
   
   let reloading = false;
   const RECOVERY_KEY = 'cashflow:stale-reload';
   
   /** Has a cache purge already been tried for this page load? */
   function alreadyTriedRecovery() {
     try { return !!sessionStorage.getItem(RECOVERY_KEY); } catch (err) { return false; }
   }
   
   function clearRecoveryFlag() {
     try { sessionStorage.removeItem(RECOVERY_KEY); } catch (err) { /* ignore */ }
   }
   
   async function recoverFromStaleAssets(reason) {
     if (reloading) return;
     reloading = true;
   
     // Say something, because a blank reload gives no clue what is happening.
     const banner = h('div', { class: 'stale-banner' },
       'Updating the app to the latest version… this page will reload once.');
     document.body.insertBefore(banner, document.body.firstChild);
   
     try {
       if (window.caches && window.caches.keys) {
         const keys = await window.caches.keys();
         await Promise.all(keys
           .filter((k) => k.indexOf('cashflow-os-') === 0 || k.indexOf('salary-manager-') === 0)
           .map((k) => window.caches.delete(k)));
       }
     } catch (err) { /* nothing more we can do */ }
   
     try {
       if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
         const regs = await navigator.serviceWorker.getRegistrations();
         await Promise.all(regs.map((r) => r.unregister()));
       }
     } catch (err) { /* ignore */ }
   
     clearRecoveryFlag();
     location.reload();
   }
   
   function init() {
     /* A password-reset link carries its token in the URL fragment, and this app
        routes tabs through that same fragment. showTab() overwrites the fragment
        on the first render, which would destroy the token before it was read, so
        it has to be picked up here — before anything touches the hash. */
     let recovered = null;
     if (window.CashFlowSync && typeof window.CashFlowSync.pickRecoveryFromUrl === 'function') {
       try { recovered = window.CashFlowSync.pickRecoveryFromUrl(); } catch (err) { /* ignore */ }
     }
   
     // Checked first: nothing should render until we know the files agree.
     // Offline, a cache wipe + reload would leave the app dead (nothing to fetch),
     // so a mismatch detected while offline is logged and tolerated instead.
     const stale = (typeof navigator !== 'undefined' && navigator.onLine === false) ? null : staleAssetReason();
     if (stale) {
       // If a purge was already tried and the files STILL disagree, the service
       // worker is not the cause — reloading again would just loop on a blank
       // page. In that case say so in the console and run anyway; the app may be
       // partly degraded, which beats being blank.
       if (!alreadyTriedRecovery()) {
         try { sessionStorage.setItem(RECOVERY_KEY, String(Date.now())); } catch (err) { /* ignore */ }
         recoverFromStaleAssets(stale);
         return;
       }
       clearRecoveryFlag();
       console.warn('App files still disagree after clearing the cache:', stale);
     }
   
     const loaded = loadState();
     state = loaded.state;
   
     // A second device can arrive with same-name accounts under different ids
     // (its factory rows plus the server's real ones). Fold them before the first
     // paint so the user never sees the pair. Silent: the repair notice already
     // covers "we fixed something on load".
     try { mergeDuplicateAccounts({ silent: true }); } catch (err) { /* never block boot */ }
   
     // A new month unticks the standing shopping list (see maybeResetShopping).
     // Persisted quietly when it fires: it is a calendar rollover, not an edit.
     try {
       if (maybeResetShopping()) {
         try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
       }
     } catch (err) { /* never block boot */ }

     // Month rollovers: budgets carry first (if the toggle is on), then any
     // recurring plans whose day has come file themselves. Also calendar work
     // — persisted here, announced with undo, never blocking the boot.
     try {
       const rolled = maybeRolloverBudgets();
       const filedCount = maybeFileRecurring();
       if (rolled || filedCount) {
         try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
       }
       if (filedCount) {
         toast(filedCount === 1
           ? '1 recurring entry filed'
           : filedCount + ' recurring entries filed', { label: 'Undo', fn: undoLast });
       }
     } catch (err) { /* never block boot */ }
   
     wireEvents();
     setupVoice();
   
     /* Decide what the sync panel should show, before the first render paints it.
        Two ways to arrive here with a valid recovery token: a link the user just
        clicked, or a reload in the middle of the flow. Both mean "show the new
        password form", and both must land the user on the panel that has it. */
     if (recovered && recovered.ok && window.CashFlowSync && window.CashFlowSync.hasResetToken) {
       resetMode = 'newpw';
       resetEmail = window.CashFlowSync.resetEmail;
     } else if (recovered && recovered.error) {
       /* Only reachable if a link was clicked. Two quite different causes, and
          they want different actions, so they are named apart rather than folded
          into "invalid or expired" — which sends people looking for a security
          problem that is not there.
   
          otp_expired is almost always the second request's fault: asking for a
          reset again invalidates the link already sitting in the inbox, and a
          mail scanner that opens links to check them can do the same. The token
          being single-use is the point, so the fix is a new email, not a retry. */
       const expired = /otp_expired|expired|invalid/i.test(String(recovered.error));
       toast(expired
         ? 'That email link has already been used — asking for a reset again makes a new one and kills the old. Use the newest email, and open it once.'
         : 'That link could not be opened. Press Forgot your password? to have a new one sent.');
     } else if (resetMode === null && window.CashFlowSync && window.CashFlowSync.hasResetToken) {
       // Reloaded part-way through: the token survived in storage.
       resetMode = 'newpw';
       resetEmail = window.CashFlowSync.resetEmail;
     }
   
     // Default the date fields to now, so a new entry is "right now" until changed.
     // Prefilled (never left blank): blank date controls render collapsed on
     // mobile browsers, which is why they looked empty and congested.
     if ($('txDate')) $('txDate').value = stampToInput(nowStamp());
     if ($('timerStart') && !$('timerStart').value) $('timerStart').value = stampToInput(nowStamp());
     if ($('reportFrom') && !$('reportFrom').value) $('reportFrom').value = currentPeriod() + '-01';
     if ($('reportTo') && !$('reportTo').value) $('reportTo').value = localDateStamp();
   
     // Show only the fields that apply to the selected transaction type.
     if ($('txType')) setTxTypeFields();
     refreshAccountSelects();
   
     // Note timers tick live while the app is open (see tickTimers).
     startTimerTicker();
   
     // Paint the device's own theme before anything renders, so the first paint
     // is already the right brightness at night.
     applyTheme();
   
     /* Show which build is running straight away, then look for a newer one.
        Passive: no data is touched, so it is safe on every load, and it turns
        "my fix did nothing" from a mystery into a glance at the badge. */
     renderBuildBadge();
     setTimeout(function () {
       checkForNewerBuild(false).then(function (latest) {
         if (typeof latest === 'string' && latest) announceNewBuildOnce(latest);
       });
     }, 1200);
   
     // Build the tab bar from TABS so markup and logic cannot drift apart.
     const bar = $('tabBar');
     if (bar) {
       mount(bar, TABS.map((t) =>
         h('button', {
           type: 'button',
           class: 'tab',
           role: 'tab',
           id: 'tab-' + t.id,
           dataset: { act: 'tab', tab: t.id },
           'aria-selected': 'false',
           'aria-controls': 'panel-' + t.id,
           tabindex: '-1'
         }, h('span', { class: 'tab-glyph', 'aria-hidden': 'true' }, t.glyph), h('span', { class: 'tab-label' }, t.label))
       ));
     }
   
     // Someone arriving from a reset link wants the form, not the dashboard. The
     // link's fragment is not a tab route, so tabFromHash() would send them home.
     showTab(resetMode ? 'settings' : tabFromHash(), { silent: true });
   
     // If anything had to be repaired, write the clean state straight back so the
     // bad data does not linger on disk (and does not re-report itself next load).
     if (loaded.broken || loaded.repaired) {
       try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
     }
     if (loaded.notice) toast(loaded.notice);
   
     // Hook up the cloud sync, if it is available. The app is fully usable
     // without it, so a failure here must never block startup.
     if (window.CashFlowSync) {
       window.CashFlowSync.seedClock(state);
       window.CashFlowSync.setStateProvider(() => state);
       // A pull changes the state without going through save(), so the engine
       // needs a way to write it down and repaint. Merged first: a pull can
       // deliver same-name accounts under different ids, and painting the pair
       // is exactly the bug being fixed.
       window.CashFlowSync.setPersist(() => {
         try { if (!mergeDuplicateAccounts({ silent: true })) save(); }
         catch (err) { save(); }
       });
       window.CashFlowSync.setAccountCollisionHandler(remapCollidingAccountIds);
       window.CashFlowSync.onChange(renderSyncPanel);
       if (window.CashFlowSync.isSignedIn) window.CashFlowSync.start(() => state);
     }
   
     if ('serviceWorker' in navigator && window.isSecureContext) {
       navigator.serviceWorker.register('service-worker.js').catch((err) => console.warn('Service worker registration failed:', err));
     }
   
     // The email tabs fetch their data when they are first opened (see showTab),
     // not here, so an ordinary page load makes no email requests at all.
     renderEmailConnectStatus();
     renderPendingQueue();
   }
   
   /* ============================================================
      Email Connect & Pending Queue
      ------------------------------------------------------------
      Uses the same plain-fetch REST approach as sync.js — no
      Supabase SDK. The session token comes from CashFlowSync.
      ============================================================ */
   
   let pendingTransactions = [];
   let emailConnected = false;
   let pendingQueueError = null;
   /* True when the forwarding-address read failed for one reason only: the login
      token was stale or refused. The addresses are saved on the server in that
      case, so saying "not working yet" would send the user redoing a setup that
      is fine — the one thing wrong is the session. */
   let emailAuthExpired = false;
   /* True when there is no session at all. The addresses and the webhook belong
      to the account, so there is nothing to show and nothing to redo without a
      login — including the case where an expired token was the only problem. */
   let emailNeedsSignIn = false;
   // Every active forwarding address on this account. There is deliberately more
   // than one: Gmail forwarding keeps the original To header, so a forwarded mail
   // arrives addressed to the Gmail account, not to the AgentMail inbox — both
   // have to be registered or the server refuses the message with a 422.
   let emailRoutes = [];
   
   /** Build Supabase REST headers using the current session token. */
   function sbHeaders() {
     const cfg = window.CASHFLOW_CONFIG || {};
     // Named `headers`, not `h`: h() is this file's element builder, and shadowing
     // it inside a helper is the kind of thing that gets "fixed" wrongly later.
     const headers = {
       'apikey': cfg.publishableKey,
       'Content-Type': 'application/json'
     };
     // The live session in sync.js is the source of truth: it is the copy that a
     // refresh just rewrote. localStorage is only a fallback for the window where
     // this file is running without sync.js loaded — reading storage first meant a
     // token refreshed a second ago could be shadowed by the stale one on disk.
     const S = window.CashFlowSync;
     const token = (S && S.accessToken) || null;
     if (token) {
       headers['Authorization'] = 'Bearer ' + token;
       return headers;
     }
     try {
       const raw = localStorage.getItem('cashflow:session');
       if (raw) {
         const session = JSON.parse(raw);
         if (session && session.accessToken) {
           headers['Authorization'] = 'Bearer ' + session.accessToken;
         }
       }
     } catch (err) { /* ignore */ }
     return headers;
   }
   
   /** Make a Supabase REST API call using plain fetch.
    *
    *  The session token is refreshed first, not read blindly from localStorage.
    *  An access token lives an hour; a call made after that without a refresh is
    *  answered by PostgREST with "JWT expired", which reads to the user as "my
    *  transactions are gone" rather than "your login is stale". The sync loop
    *  refreshes on its own schedule, but the Pending queue and the email routes
    *  are read the moment their tab opens, which can be any time after the last
    *  cycle — so every read asks for a fresh token here. */
   async function sbFetch(path, opts) {
     const cfg = window.CASHFLOW_CONFIG || {};
     const url = cfg.url + '/rest/v1/' + path;
     const S = window.CashFlowSync;
     let retried = false;
   
     const askFresh = async function () {
       if (!S || typeof S.ensureFreshToken !== 'function') return;
       try {
         await S.ensureFreshToken();
       } catch (err) {
         // Not signed in, or the refresh was refused (password changed, account
         // gone). Let the request go out anyway: the headers may still carry a
         // token that works, and if they do not the 401 below names the reason.
         const msg = (err && err.message) || '';
         if (/not signed in|session expired/i.test(msg)) throw new Error(msg);
       }
     };
   
     const once = async function () {
       const res = await fetch(url, Object.assign({ headers: sbHeaders() }, opts || {}));
       const text = await res.text();
       let body = null;
       if (text) { try { body = JSON.parse(text); } catch (err) { body = text; } }
       if (!res.ok) {
         const msg = (body && (body.msg || body.message || body.error_description)) ||
           (body && body.error) || ('HTTP ' + res.status);
         // A token that expired between the refresh above and this response (a
         // slow network, a clock jump) is retried once with a brand-new one.
         // Only once: an endless retry loop would hide a real auth problem.
         if (!retried && res.status === 401 &&
             /jwt expired|token.*expired|invalid.*jwt/i.test(String(msg))) {
           retried = true;
           await askFresh();
           return once();
         }
         throw new Error(msg);
       }
       return body;
     };
   
     // Refresh first, not read blindly from localStorage. An access token lives
     // an hour; a call made after that without a refresh is answered by
     // PostgREST with "JWT expired", which reads to the user as "my transactions
     // are gone" rather than "your login is stale". The sync loop refreshes on
     // its own schedule, but the Pending queue and the email routes are read the
     // moment their tab opens — which can be any time after the last cycle.
     await askFresh();
     return once();
   }
   
   /** Get current user ID from the session. sync.js holds the live copy; storage
    *  is only the fallback for a page running without it. */
   function getCurrentUserId() {
     const S = window.CashFlowSync;
     if (S && S.userId) return S.userId;
     try {
       const raw = localStorage.getItem('cashflow:session');
       if (raw) {
         const session = JSON.parse(raw);
         if (session && session.userId) return session.userId;
       }
     } catch (err) { /* ignore */ }
     return null;
   }
   
   /* This app deliberately collects no email credentials. An earlier version
      posted a base64 "encrypted" password to `user_email_credentials`, where the
      signed-in user could read it straight back. The forwarding model needs no
      secret from the mail account at all, so the whole path was removed rather
      than merely hidden. The status panel below only reports whether a forwarding
      route is registered for this account. */
   
   async function loadEmailRouteStatus() {
     const userId = getCurrentUserId();
     restoreEmailSetup();
     wireEmailSetupFields();
     if (!userId) {
       // Signed out (including a session cleared by a refused refresh): the
       // addresses and the webhook live in the account, so the honest answer is
       // to sign in — not to walk through a setup that may well be complete.
       emailNeedsSignIn = true;
       emailAuthExpired = false;
       emailConnected = false;
       emailRoutes = [];
       renderEmailConnectStatus();
       renderEmailRouteList();
       return;
     }
     emailNeedsSignIn = false;
   
     try {
       const data = await sbFetch('email_routes?user_id=eq.' + encodeURIComponent(userId) + '&is_active=eq.true');
       emailAuthExpired = false;
       emailRoutes = Array.isArray(data) ? data : [];
       if (emailRoutes.length) {
         emailConnected = true;
         const known = emailRoutes[0].address || '';
         const box = $('emailForwardAddress');
         if (box && !box.value) box.value = known;
       } else {
         emailConnected = false;
       }
     } catch (err) {
       // A missing table or a policy gap must not break the app; the panel just
       // reports that forwarding is not confirmed.
       console.warn('Could not read the forwarding route:', err && err.message);
       emailConnected = false;
       emailRoutes = [];
       emailAuthExpired = /jwt expired|token.*expired|not signed in|session expired/i
         .test((err && err.message) || '');
     }
     renderEmailConnectStatus();
     renderEmailRouteList();
   }
   
   /* The webhook URL carries the shared secret, so it is held in this browser and
      nowhere else — never in the repository, never in the database. It is not a
      credential of the mail account, so losing it costs nothing but the ability to
      run the test and paste the URL again. */
   const EMAIL_SETUP_KEY = 'cashflow:emailSetup';
   
   /** Fill in everything about the webhook URL that is already known.
    *
    *  Only the secret is left blank. Asking someone to assemble a URL from a
    *  function name and a project reference in a dashboard is a step that
    *  produces a wrong URL, and a wrong URL fails silently — no error anywhere,
    *  just no transactions, which is the failure mode that gets a feature
    *  abandoned rather than fixed. */
   function prefillWebhookUrl() {
     const box = $('emailWebhookUrl');
     if (!box) return;
     if (box.value && box.value.indexOf('?k=') !== -1) return;   // already done
     const base = (window.CASHFLOW_CONFIG || {}).emailWebhookBase;
     if (!base) return;
     box.value = base + '?k=';
     box.setAttribute('placeholder', base + '?k= then your secret');
   }
   
   function restoreEmailSetup() {
     prefillWebhookUrl();
     try {
       const saved = JSON.parse(localStorage.getItem(EMAIL_SETUP_KEY) || '{}');
       const urlBox = $('emailWebhookUrl');
       if (urlBox && saved.webhookUrl) urlBox.value = saved.webhookUrl;
       const addrBox = $('emailForwardAddress');
       if (addrBox && saved.address && !addrBox.value) addrBox.value = saved.address;
     } catch (err) { /* a corrupt value is not worth reporting */ }
   }
   
   function rememberEmailSetup(patch) {
     let saved = {};
     try { saved = JSON.parse(localStorage.getItem(EMAIL_SETUP_KEY) || '{}'); } catch (err) { saved = {}; }
     try { localStorage.setItem(EMAIL_SETUP_KEY, JSON.stringify(Object.assign(saved, patch))); } catch (err) { /* ignore */ }
   }
   
   /* Keep both fields as they are typed.
    *
    *  They were only written to storage when a button was pressed, so pasting the
    *  secret and then reloading the page — which a service worker update does on
    *  its own — silently emptied the field. The user then copied a half-finished
    *  URL somewhere, and the symptom was the provider rejecting a URL that had
    *  been correct a moment earlier. */
   let emailSetupWired = false;
   
   function wireEmailSetupFields() {
     // loadEmailRouteStatus() runs on every visit to the Email tab, so without
     // this guard each visit would stack another pair of listeners and every
     // keystroke would write storage N times.
     if (emailSetupWired) return;
     emailSetupWired = true;
     const url = $('emailWebhookUrl');
     if (url) {
       // 'input', not 'change': a paste followed by a reload without blurring the
       // field never fires 'change', and the secret was lost exactly that way.
       url.addEventListener('input', function () {
         rememberEmailSetup({ webhookUrl: url.value.trim() });
       });
     }
     const addr = $('emailForwardAddress');
     if (addr) {
       addr.addEventListener('input', function () {
         rememberEmailSetup({ address: addr.value.trim().toLowerCase() });
       });
     }
   }
   
   /** Register a forwarding address against the signed-in account.
    *
    *  This used to be a manual SQL insert, and that is a step that looks optional
    *  and is not: without it the function has nobody to file messages against, and
    *  the app says "not set up" with nothing the user can act on.
    *
    *  One account holds several addresses at once — the AgentMail inbox AND the
    *  Gmail account, because forwarding preserves the original To header. An
    *  earlier version retired every other row on save, which silently unregistered
    *  the Gmail address and stopped all mail with a 422 the moment a second route
    *  existed anywhere. */
   async function saveEmailRoute() {
     const userId = getCurrentUserId();
     if (!userId) { toast('Sign in first'); return; }
     const box = $('emailForwardAddress');
     const address = box ? box.value.trim().toLowerCase() : '';
     if (!address || address.indexOf('@') === -1 || address.indexOf('.') === -1) {
       toast('Type the forwarding address, like cashflow@agentmail.to');
       return;
     }
     try {
       const q = 'email_routes?user_id=eq.' + encodeURIComponent(userId);
       const existing = await sbFetch(q + '&select=id,address,is_active');
   
       /* Add, never replace. The address column is unique, so saving the same
          address twice — the normal thing to do while setting this up — must
          reactivate rather than insert, or it fails on the constraint with a
          problem the user cannot act on. Other addresses stay exactly as they
          are: each one is a live route, not a superseded draft. */
       const same = (existing || []).filter((r) => r.address === address)[0];
       if (same) {
         if (!same.is_active) {
           await sbFetch(q + '&id=eq.' + encodeURIComponent(same.id), {
             method: 'PATCH',
             body: JSON.stringify({ is_active: true }),
           });
         }
       } else {
         await sbFetch('email_routes', {
           method: 'POST',
           body: JSON.stringify({ user_id: userId, address, is_active: true }),
         });
       }
       emailConnected = true;
       rememberEmailSetup({ address });
       await loadEmailRouteStatus();
       showEmailTest('ok', 'Saved. Messages sent to ' + address + ' will be filed for this account.');
     } catch (err) {
       const msg = (err && err.message) || 'failed';
       showEmailTest('bad', /duplicate|unique/i.test(msg)
         ? 'That address is already registered to another account. Each address can belong to only one.'
         : 'Could not save: ' + msg);
     }
   }
   
   /** Retire one of this account's addresses. The row is deactivated, not
    *  deleted, so a re-add is a reactivation rather than a fight with the unique
    *  constraint. */
   async function removeEmailRoute(id) {
     const userId = getCurrentUserId();
     if (!userId || !id) return;
     try {
       await sbFetch('email_routes?user_id=eq.' + encodeURIComponent(userId) +
         '&id=eq.' + encodeURIComponent(id), {
         method: 'PATCH', body: JSON.stringify({ is_active: false }),
       });
       await loadEmailRouteStatus();
     } catch (err) {
       toast('Could not remove: ' + ((err && err.message) || 'failed'));
     }
   }
   
   /** The saved addresses, each removable. Rendered from the server rows — never
    *  from the input box — so what is shown is what the server will match. */
   function renderEmailRouteList() {
     const container = $('emailRouteList');
     if (!container) return;
     mount(container);
     if (!emailRoutes.length) return;
     container.appendChild(h('div', { class: 'field-label' }, 'Saved addresses'));
     for (const r of emailRoutes) {
       container.appendChild(h('div', { class: 'email-route-row' },
         h('span', { class: 'email-route-addr' }, String(r.address || '')),
         h('button', {
           class: 'btn btn-dark btn-sm', type: 'button',
           dataset: { act: 'email-remove', id: r.id },
         }, 'Remove')
       ));
     }
   }
   
   function emailWebhookUrl() {
     const box = $('emailWebhookUrl');
     return box ? box.value.trim() : '';
   }
   
   /** Does the function exist, and is its secret set?
    *
    *  The secret travels with the request. Stripping the query string to make a
    *  "harmless" check sent an unauthenticated GET at a function that refuses
    *  every unauthenticated request, so the check answered 401 — indistinguishable
    *  from a wrong secret, which is the one thing the user needed to be told.
    *  The whole point of this button is to distinguish those cases, so it has to
    *  send the credential it is checking. */
   /* Supabase's gateway rejects a call to a function that carries no `apikey`
      before the function's own code runs at all, so every request from here needs
      the publishable key. It is public by design — it ships in this file — and
      knowing it grants nothing, because the function's shared secret is a separate
      thing. Two different credentials, two different jobs:
      the apikey gets past the gateway, the secret proves the caller is the mail
      provider. */
   /* Supabase's gateway refuses a function call that carries no apikey before the
      function's own code runs, so one has to be sent. Sending it as a header is
      what introduced a second failure: a header the browser did not expect makes it
      preflight, and if the function's allowed-headers list is even slightly out of
      date the browser refuses the call without sending it — "Failed to fetch", with
      no status code and nothing in the function's logs because it was never
      dialled. The CORS list was fixed, and the app still could not reach the
      function, which is the part that made this so hard to see.
   
      Putting the key in the query string, and sending the body as text/plain,
      makes both requests "simple" by the browser's definition: no custom header, no
      non-safelisted content type, therefore no preflight at all. The function reads
      its body with json() either way, so the content type is only ever a label.
   
      This is deliberately not a workaround for a missing CORS entry — the function
      still declares a full set. It is so that a stale list, a cached preflight, or
      a proxy in between cannot stop the one request the user is relying on to tell
      them whether the feature works. */
   function emailRequestUrl(url) {
     const cfg = window.CASHFLOW_CONFIG || {};
     if (!cfg.publishableKey) return url;
     return url + (url.indexOf('?') === -1 ? '?' : '&') + 'apikey=' + encodeURIComponent(cfg.publishableKey);
   }
   
   /* Deliberately not application/json: that is not a CORS-safelisted content type
      and would bring the preflight back. The body is still JSON; nothing reads this
      header. */
   function emailFetchHeaders(extra) {
     return Object.assign({ 'Content-Type': 'text/plain;charset=UTF-8' }, extra || {});
   }
   
   /* Fetch with one automatic retry. The failure this exists for is a lost
      response: the request reaches the server (a test row gets filed) but the
      reply never comes back, and the browser reports "Failed to fetch". The
      server-side effect already happened, so reporting failure without retrying
      is wrong — and retrying a POST is safe here because every attempt reuses the
      same body, so the same message_id hits the unique constraint and the second
      attempt can only ever come back "duplicate", never a second row. */
   async function fetchEmailOnce(url, opts, delayMs) {
     try {
       return await fetch(url, opts);
     } catch (err) {
       await new Promise((r) => setTimeout(r, delayMs || 2000));
       return await fetch(url, opts);
     }
   }
   
   /** No HTTP status arrived at all — the browser threw instead of answering.
    *
    *  This deliberately does NOT blame CORS or the deployment any more: both were
    *  verified live (the preflight answers, the function answers), and naming them
    *  sent the owner redeploying a working function. What is actually known is
    *  only that no response came back, which on a lossy connection happens after
    *  the server already did the work. So for the POST the message says where to
    *  look instead of what to rebuild — and the real error detail goes to the
    *  console, where it belongs, rather than being swallowed into a guess. */
   function describeUnreachable(err, isPost) {
     let detail = 'no reply';
     try {
       if (err) detail = (err.name ? err.name + ': ' : '') + (err.message || String(err));
       console.error('[email setup] request failed without a response:', err);
     } catch (e) { /* logging must never break the panel */ }
     return 'No response was received (' + detail + '). ' +
       (isPost
         ? 'The test may still have reached the server — check the Pending tab (and the function’s Invocations) before pressing again, or you may file a duplicate.'
         : 'Check your connection, VPN or ad-blocker, then try again.');
   }
   
   /** Turn a gateway refusal into something the user can act on.
    *
    *  A 401 from Supabase's own gateway and a 401 from the function's secret check
    *  are the same status with completely different causes, and the second one
    *  sends people off to re-copy a secret that was correct all along. The gateway
    *  names itself in the body, so read it. */
   function describeGatewayProblem(status, body) {
     const code = (body && (body.code || body.error_code)) || '';
     if (/NO_AUTH_HEADER|MISSING_AUTH/i.test(code) || /Missing authorization header/i.test(body && body.message || '')) {
       return 'The request never reached the function — Supabase refused it first. ' +
         'The apikey header is missing from this app’s request, which is a bug here rather than a setting on your side. ' +
         'Reopen the app to pull the newest version.';
     }
     if (/INVALID_JWT|INVALID_TOKEN|JWT_EXPIRED|jwt expired|token expired|exp claim/i.test(code + ' ' + String((body && (body.message || body.error_description || body.error)) || ''))) {
       return 'Supabase refused the request before it reached the function — its JWT check is on. ' +
         'Open Edge Functions → poll-emails → Settings and turn OFF "Verify JWT", then Save. ' +
         'A webhook from a mail provider cannot present a Supabase login token, so while that setting is on, ' +
         'no bank email can ever reach the function and nothing will appear under Pending.';
     }
     if (/403|forbidden/i.test(String(status))) {
       return 'Supabase refused the request. Turn OFF "Verify JWT" in the function’s Settings — a third-party webhook cannot send a login token.';
     }
     return 'The server answered ' + status + '. Check the function is deployed from the code in the repository, ' +
       'and that the value after ?k= matches WEBHOOK_SECRET.';
   }
   
   /** Run a sample alert through the entire chain and report which step it reached.
    *
    *  Without this, "no transactions are arriving" has four possible causes —
    *  wrong URL, missing secret, no registered address, and a parser that does not
    *  understand the bank's wording — and the app cannot tell them apart. Each of
    *  those produces the same silence, which is the reason a feature like this
    *  usually gets abandoned rather than fixed. */
   async function runEmailSelfTest() {
     const url = emailWebhookUrl();
     if (!url) { showEmailTest('bad', 'The webhook URL is empty above.'); return; }
     if (/[?&#]k=$/.test(url)) {
       showEmailTest('bad', 'Paste your WEBHOOK_SECRET after ?k= at the end of the URL.');
       return;
     }
     const userId = getCurrentUserId();
     if (!userId) { showEmailTest('bad', 'Sign in first.'); return; }
   
     showEmailTest('busy', 'Sending a test transaction…');
     const when = new Date();
     const stamp = String(when.getDate()).padStart(2, '0') + '/' +
       String(when.getMonth() + 1).padStart(2, '0') + '/' + when.getFullYear();
   
     // One id per press, reused by the retry inside fetchEmailOnce: if the first
     // attempt filed the row and only its reply was lost, the second attempt hits
     // the unique constraint and comes back "duplicate" instead of filing twice.
     const messageId = 'self-test-' + Date.now();
     try {
       const target = emailRequestUrl(url) + '&test=1';
       const res = await fetchEmailOnce(target, {
         method: 'POST',
         headers: emailFetchHeaders(),
         body: JSON.stringify({
           event_type: 'message.received',
           message: {
             from_: 'no-reply@nayapay.com',
             to: [($('emailForwardAddress') || {}).value || 'test@agentmail.to'],
             subject: 'NayaPay: You have received Rs. 1,234 on ' + stamp,
             text: 'Dear customer, you have received Rs. 1,234 from CashFlow OS test on ' + stamp +
                   '. This is a test message and can be rejected.',
             message_id: messageId,
           },
         }),
       });
       const body = await res.json().catch(function () { return null; });
   
       if (res.status === 401) {
         /* A 401 here is ambiguous: the gateway refuses a missing apikey and the
            function refuses a wrong secret, with the same status. The gateway
            names itself in the body, so read it before blaming the secret. */
         const fromGateway = body && (body.code || body.error_code);
         showEmailTest('bad', fromGateway
           ? describeGatewayProblem(res.status, body)
           : 'The server rejected the secret. The value after ?k= must exactly match WEBHOOK_SECRET.');
         return;
       }
       if (res.status === 500 && body && /not configured/i.test(body.error || '')) {
         showEmailTest('bad', 'WEBHOOK_SECRET is not set on the server. Add it under Edge Functions → Secrets.');
         return;
       }
       if (res.status === 422 && body && /routing|route/i.test(body.reason || body.error || '')) {
         showEmailTest('bad', 'No account is registered for the forwarding address. Press "Save address" first.');
         return;
       }
       if (body && body.status === 'failed') {
         showEmailTest('bad', 'The test reached the server but failed at ' + (body.stage || '?') + ': ' + (body.reason || 'unknown'));
         return;
       }
       if (body && body.status === 'filed') {
         showEmailTest('ok', 'Please check the Pending Transactions tab — if a transaction of + Rs ' +
           body.amount + ' is appearing there, then all things are set and you will get all the bank notifications from now on.');
         loadPendingTransactions();
         return;
       }
       if (body && body.status === 'duplicate') {
         // The earlier attempt got through and only its reply was lost — this is
         // the retry succeeding, not a problem. There is exactly one row.
         showEmailTest('ok', 'Already filed — an earlier attempt got through and only its reply was lost. Check the Pending tab.');
         loadPendingTransactions();
         return;
       }
       if (!res.ok) {
         showEmailTest('bad', describeGatewayProblem(res.status, body));
         return;
       }
       showEmailTest('bad', 'Unexpected answer: ' + JSON.stringify(body || {}).slice(0, 200));
     } catch (err) {
       showEmailTest('bad', describeUnreachable(err, true));
     }
   }
   
   function showEmailTest(kind, message) {
     const box = $('emailTestResult');
     if (!box) return;
     const cls = kind === 'ok' ? 'email-test ok' : (kind === 'busy' ? 'email-test busy' : 'email-test bad');
     const mark = kind === 'ok' ? '✓' : (kind === 'busy' ? '…' : '✕');
     mount(box, h('div', { class: cls }, h('span', { class: 'email-test-icon' }, mark), h('span', {}, message)));
   }
   
   /** Put the webhook URL on the clipboard, so it can be pasted into the mail
    *  provider without being retyped — a mistyped secret fails in a way that looks
    *  like the provider is at fault. */
   async function copyEmailWebhookUrl() {
     const box = $('emailWebhookUrl');
     const url = box ? box.value.trim() : '';
     if (!url) { showEmailTest('bad', 'There is no URL to copy yet.'); return; }
     try {
       if (navigator.clipboard && navigator.clipboard.writeText) {
         await navigator.clipboard.writeText(url);
       } else {
         // Older browsers, and any context where clipboard access is refused.
         box.select();
         document.execCommand('copy');
       }
       rememberEmailSetup({ webhookUrl: url });
       showEmailTest('ok', 'Copied. Paste it into AgentMail → Settings → Webhooks.');
     } catch (err) {
       box.select();
       showEmailTest('bad', 'Copying was blocked — the URL is selected, press Ctrl+C.');
     }
   }
   
   function renderEmailConnectStatus() {
     const statusEl = $('emailConnectStatus');
     if (!statusEl) return;
   
     if (emailConnected) {
       mount(statusEl, h('div', { class: 'email-status connected' },
         h('span', { class: 'email-status-icon' }, '✓'),
         h('span', {}, 'Addresses saved. Bank emails sent to them will appear under Pending once the test below passes.')
       ));
     } else if (emailNeedsSignIn) {
       mount(statusEl, h('div', { class: 'email-status disconnected' },
         h('span', { class: 'email-status-icon' }, '○'),
         h('span', {}, 'Sign in to see this setup — your forwarding addresses and webhook live in your account.')
       ));
     } else if (emailAuthExpired) {
       // Setup is fine — only the session is stale. Redoing the steps would change
       // nothing, so this says the one action that does.
       mount(statusEl, h('div', { class: 'email-status disconnected' },
         h('span', { class: 'email-status-icon' }, '○'),
         h('span', {}, 'Your sign-in has expired. Sign in again from Settings — your addresses are already saved, and bank emails resume as soon as the session is back.')
       ));
     } else {
       mount(statusEl, h('div', { class: 'email-status disconnected' },
         h('span', { class: 'email-status-icon' }, '○'),
         h('span', {}, 'Not working yet. Follow the steps below, then press "Send a test transaction" — until that passes, nothing will arrive.')
       ));
     }
     // The setup steps hide once they have done their job; the saved addresses
     // above stay visible. If the setup ever breaks, the status flips back and
     // the steps reappear on their own — but a missing or expired login is not
     // the setup breaking, so those stay hidden while it is only the session.
     const det = $('emailSetupDetails');
     if (det) det.hidden = emailConnected || emailAuthExpired || emailNeedsSignIn;
   }
   
   async function loadPendingTransactions() {
     const userId = getCurrentUserId();
     if (!userId) {
       // No session means the queue cannot be read, and an empty list here would
       // look exactly like "no bank emails arrived". Say which it is.
       pendingTransactions = [];
       pendingQueueError = 'Not signed in — sign in again from Settings and the queue loads immediately. Nothing was lost.';    renderPendingQueue();
       return;
     }
   
     try {
       const data = await sbFetch(
         'pending_transactions?user_id=eq.' + encodeURIComponent(userId) +
         '&status=eq.pending&order=created_at.desc&limit=50');
       pendingTransactions = Array.isArray(data) ? data : [];
     } catch (err) {
       // A missing table or a policy gap must not break the app. Report it in the
       // panel rather than only the console, because otherwise the user just sees
       // an empty queue and concludes no transactions arrived.
       console.warn('Could not read the pending queue:', err && err.message);
       pendingTransactions = [];
       const raw = (err && err.message) || 'Could not load';
       // A stale or refused login reads as "JWT expired" at the API — the reason
       // behind the reported bug. Say what to do instead of passing the raw
       // server wording through: nothing is lost, the rows are on the server.
       pendingQueueError = /jwt expired|token.*expired|not signed in|session expired/i.test(raw)
         ? 'Your sign-in has expired — sign in again from Settings and this queue loads immediately. The transactions are safe on the server.'
         : (/failed to fetch|networkerror|network request failed/i.test(raw)
           ? 'You are offline — the queue loads as soon as you reconnect. Nothing was lost.'
           : raw);
     }
     renderPendingQueue();
   }
   
   function renderPendingQueue() {
     const container = $('pendingQueueList');
     if (!container) return;
   
     // mount(), not innerHTML — the app builds every node through h().
     mount(container);
   
     if (pendingQueueError) {
       container.appendChild(h('div', { class: 'pending-empty' },
         'Could not load the pending queue: ' + pendingQueueError));
       return;
     }
     if (pendingTransactions.length === 0) {
       container.appendChild(h('div', { class: 'pending-empty' },
         'Nothing waiting. Transactions parsed from your bank emails land here for approval.'));
       return;
     }
   
     for (const tx of pendingTransactions) {
       // Every one of these comes from the server, so none of it is trusted to be
       // present or well-typed. It all lands as text, never as markup.
       const amount = toPositiveNumber(tx.amount);
       const when = parseDate(tx.transaction_date);
       const item = h('div', { class: 'pending-item' },
         h('div', { class: 'pending-info' },
           h('div', { class: 'pending-amount ' + (tx.type === 'income' ? 'income' : 'expense') },
             /* formatMoney already puts the currency symbol on, so only the sign
                is added here. Adding CURRENCY as well made every pending row read
                "Rs Rs 1,234" — the only row in the app a user reads before
                approving money into their ledger. */
             (tx.type === 'income' ? '+ ' : '− ') + formatMoney(amount === null ? 0 : amount)),
           h('div', { class: 'pending-desc' }, cleanText(tx.description, COMMENT_LIMIT) || '(no description)'),
           h('div', { class: 'pending-meta' },
             cleanText(tx.bank_name, NAME_LIMIT) || 'Bank',
             /* Date only. A bank alert carries a calendar day and no time, so any
                clock here would be an artefact of how the value was stored — and
                it read as 05:00, which looked like the payment happened before
                dawn. The day is what a person checks; the time of day is not
                information that exists. */
             when ? ' • ' + formatDayOnly(when) : ' • date unknown'),
           pendingCategorySelect(tx),
           pendingMoreOptions(tx)
         ),
         h('div', { class: 'pending-actions' },
           h('button', {
             class: 'btn btn-primary btn-sm',
             type: 'button',
             disabled: amount === null,
             title: amount === null ? 'This row has no usable amount' : null,
             dataset: { act: 'approve-tx', id: tx.id }
           }, 'Approve'),
           h('button', {
             class: 'btn btn-cancel btn-sm',
             type: 'button',
             dataset: { act: 'reject-tx', id: tx.id }
           }, 'Reject')
         )
       );
       container.appendChild(item);
     }
   }
   
   /** The category picker on a pending row. It opens on what was remembered for
    *  this bank + wording, so repeat mail files itself correctly with zero taps —
    *  changing it teaches a new memory. */
   function pendingCategorySelect(tx) {
     const sel = h('select', {
       class: 'pending-category',
       'aria-label': 'Category for this transaction',
       dataset: { pendingCat: tx.id }
     });
     fillCategorySelect(sel, { selected: pendingRememberedCategory(tx) || 'Other' });
     return h('div', { class: 'form-group pending-cat-row' },
       h('label', { class: 'field-label' }, 'Category'),
       sel);
   }
   
   /** Which category an approval files under: the picker's choice, else what was
    *  remembered for this bank + wording, else "Other" when the picker is gone
    *  or names something deleted since. Never Salary by default — that claim
    *  belongs to the user, not the parser. */
   function pendingChosenCategory(txId, type) {
     // An explicit non-Other pick always wins. 'Other' is also the untouched
     // default, so it defers to memory — and memory never stores 'Other', which
     // means a deliberate Other lands back on Other through emailCategory.
     const el = pendingControl(txId, 'pending-cat');
     const picked = el && typeof el.value === 'string' ? el.value : '';
     if (picked && picked.toLowerCase() !== 'other' && findCategory(picked)) return findCategory(picked);
     const tx = (pendingTransactions || []).find((t) => t.id === txId);
     const remembered = tx && pendingRememberedCategory(tx);
     if (remembered) return remembered;
     return emailCategory(type);
   }
   
   /** The memory key for a pending row: bank plus the first telling word of the
    *  description ("nayapay|coffee"). Scoped to the bank so the same word at two
    *  banks learns separately; amount-like tokens are skipped so every distinct
    *  figure does not become its own rule. */
   function catMemoryKey(tx) {
     const bank = cleanText(tx && tx.bank_name, NAME_LIMIT).toLowerCase();
     const words = cleanText(tx && tx.description, COMMENT_LIMIT).toLowerCase()
       .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && /[a-z]/.test(w));
     if (!bank || !words.length) return null;
     return (bank + '|' + words[0]).slice(0, 80);
   }
   
   /** What was last picked for this bank + wording, if that category still
    *  exists. A deleted category never resurfaces from memory. */
   function pendingRememberedCategory(tx) {
     const key = catMemoryKey(tx);
     const mem = state.settings && state.settings.catMemory;
     const name = key && mem ? mem[key] : null;
     return (typeof name === 'string' && findCategory(name)) ? findCategory(name) : null;
   }
   
   /** Remember a pick: next time this bank + wording arrives, the picker starts
    *  there instead of "Other". Deliberate "Other" picks are not stored — Other
    *  is already the default, so storing it would only spend the budget. */
   function learnCategory(tx, category) {
     if (!tx || !category || category.toLowerCase() === 'other') return;
     if (!findCategory(category)) return;
     const key = catMemoryKey(tx);
     if (!key) return;
     if (!state.settings.catMemory || typeof state.settings.catMemory !== 'object') {
       state.settings.catMemory = Object.create(null);
     }
     const mem = state.settings.catMemory;
     if (mem[key]) delete mem[key];
     mem[key] = category;
     const keys = Object.keys(mem);
     while (keys.length > CAT_MEMORY_LIMIT) delete mem[keys.shift()];
   }
   
   /** Read one per-row Pending control. Every control carries the row id in a
    *  data attribute, so a re-render between opening the row and pressing
    *  Approve cannot mix two rows' choices. */
   function pendingControl(txId, attr) {
     try { return document.querySelector('[data-' + attr + '="' + txId + '"]'); }
     catch (err) { return null; }
   }
   
   /** The deep-manage block under each pending row. The row itself stays a plain
    *  Approve — but an ATM withdrawal is really a transfer to Cash, a repayment
    *  belongs on an udhaar entry, and a grocery payment ticks list items. Those
    *  choices live here, read at the moment Approve is pressed. */
   function pendingMoreOptions(tx) {
     const isExpense = tx.type !== 'income';
     const fromId = pendingAccountId(tx);
   
     const acctSel = h('select', {
       class: 'pending-account',
       'aria-label': 'Account for this transaction',
       dataset: { pendingAcct: tx.id }
     });
     fillAccountSelect(acctSel, { selected: fromId });
   
     const toSel = h('select', {
       class: 'pending-account',
       'aria-label': 'To account (only for transfers)',
       dataset: { pendingTo: tx.id }
     });
     const cashId = cashAccountId();
     fillAccountSelect(toSel, { selected: (cashId && cashId !== fromId) ? cashId : fromId });
   
     const kindSel = h('select', {
       class: 'pending-kind',
       'aria-label': 'How to file this transaction',
       dataset: { pendingKind: tx.id }
     });
     mount(kindSel,
       h('option', { value: 'normal' }, isExpense ? 'File as expense' : 'File as income'),
       isExpense ? h('option', { value: 'transfer' }, 'File as transfer to my own account') : null);
   
     const openDebts = (state.debts || []).filter((d) => !d.settled);
     const debtSel = h('select', {
       class: 'pending-debt',
       'aria-label': 'Link to an udhaar entry',
       dataset: { pendingDebt: tx.id }
     });
     mount(debtSel,
       h('option', { value: '' }, 'No udhaar link'),
       openDebts.map((d) => h('option', { value: d.id },
         d.person + ' — ' + formatMoney(d.amount) + (d.type === 'receive' ? ' owes me' : ' I owe'))));
   
     const openItems = (state.shopping || []).filter((s) => !s.checked);
   
     /* One labelled group per concern, instead of a single flat pile of
        dropdowns. The section titles carry the "what does this do" that used to
        live in long option text, and the two-column grid on wider screens keeps
        the row from growing tall enough to push Approve below the fold. The
        details/summary still collapses it all, so a plain Approve stays one tap
        away. */
     const section = (title, hint, ...kids) => h('div', { class: 'pending-section' },
       h('div', { class: 'pending-section-head' },
         h('span', { class: 'pending-section-title' }, title),
         hint ? h('span', { class: 'pending-section-hint' }, hint) : null),
       h('div', { class: 'pending-section-body' }, ...kids));
   
     return h('details', { class: 'pending-more' },
       h('summary', { class: 'pending-more-title' }, 'More options'),
       section('How to file', 'Expense, income, or a transfer between your own accounts',
         h('div', { class: 'form-group' },
           h('label', { class: 'field-label' }, 'Type'),
           kindSel)),
       section('Which account', isExpense ? 'Where the money left from' : 'Where the money landed',
         h('div', { class: 'form-group' },
           h('label', { class: 'field-label' }, isExpense ? 'From account' : 'To account'),
           acctSel),
         isExpense
           ? h('div', { class: 'form-group' },
             h('label', { class: 'field-label' }, 'To account (transfers only)'),
             toSel)
           : null),
       openDebts.length
         ? section('Udhaar link', 'Settles part of an open debt instead of filing a new record',
           h('div', { class: 'form-group' },
             h('label', { class: 'field-label' }, 'Link to entry'),
             debtSel))
         : null,
       openItems.length
         ? section('Bought items', 'Tick what this payment covered — the amount is split across them',
           openItems.map((s) => h('label', { class: 'check pending-item-check' },
             h('input', { type: 'checkbox', dataset: { pendingItem: tx.id }, value: s.id }),
             h('span', {}, s.name + (s.qty ? ' × ' + s.qty : '')))))
         : null
     );
   }
   
   /** Which open udhaar entry an approval is linked to, if any. */
   function pendingLinkedDebt(txId) {
     const el = pendingControl(txId, 'pending-debt');
     const id = el && typeof el.value === 'string' ? el.value : '';
     if (!id) return null;
     const d = (state.debts || []).find((x) => x.id === id && !x.settled);
     return d || null;
   }
   
   /** Which account an approval files into: what its picker says, falling back
    *  to the automatic match when the picker is gone. */
   function pendingPickedAccount(txId, tx) {
     const el = pendingControl(txId, 'pending-acct');
     const id = el && typeof el.value === 'string' ? el.value : '';
     if (id && findAccount(id)) return id;
     return pendingAccountId(tx);
   }
   
   /** Which shopping items the approval ticks. Only open items that still exist
    *  count — anything bought or deleted since renders nothing. */
   function pendingPickedItems(txId) {
     let boxes = [];
     try { boxes = Array.from(document.querySelectorAll('[data-pending-item="' + txId + '"]')); }
     catch (err) { return []; }
     return boxes
       .filter((b) => b.checked)
       .map((b) => (state.shopping || []).find((s) => s.id === b.value && !s.checked))
       .filter(Boolean);
   }
   
   async function approveTransaction(txId) {
     const userId = getCurrentUserId();
     if (!userId) return;
   
     const tx = pendingTransactions.find(t => t.id === txId);
     if (!tx) return;
   
     // The row came from the server, so its amount is not trusted to be a number.
     // Approving a NaN would write a poisoned row straight into the ledger.
     const amount = toPositiveNumber(tx.amount);
     if (amount === null) { toast('This row has no usable amount, so it cannot be approved'); return; }
   
     // Two devices, one queue: if this same row was already approved or rejected
     // on the other device, filing it here would write it a second time — and a
     // second copy appearing by itself looks exactly like an "auto" approval. So
     // the server is asked first, and a row that is no longer pending is dropped
     // locally instead of filed. An offline device cannot ask, so it files as
     // before; the worst case there is unchanged, not new.
     try {
       const fresh = await sbFetch('pending_transactions?id=eq.' + encodeURIComponent(txId) + '&select=status');
       const rowState = Array.isArray(fresh)
         ? (fresh[0] && fresh[0].status)
         : (fresh && fresh.status);
       if (rowState && rowState !== 'pending') {
         pendingTransactions = pendingTransactions.filter(t => t.id !== txId);
         renderPendingQueue();
         toast(rowState === 'approved'
           ? 'Already approved — probably on your other device. Nothing filed twice.'
           : 'Already handled on your other device. Nothing filed.');
         return;
       }
     } catch (err) { /* offline: fall through and file locally, as before */ }
   
     // Shared tail: tell the server AFTER the local save, so a failed call leaves
     // the money safely filed and the row simply stays pending.
     const finishApproval = async () => {
       try {
         // Encoded, like every other id that reaches the query string: a pending
         // row whose id carries a reserved character would otherwise build a
         // malformed filter, the PATCH would match nothing, and the row would sit
         // in the queue forever looking un-approved.
         await sbFetch('pending_transactions?id=eq.' + encodeURIComponent(txId), {
           method: 'PATCH',
           body: JSON.stringify({ status: 'approved', approved_at: new Date().toISOString() })
         });
       } catch (err) {
         console.warn('Saved locally, but the pending row could not be marked approved:', err && err.message);
       }
       pendingTransactions = pendingTransactions.filter(t => t.id !== txId);
       renderPendingQueue();
     };
   
     // Jump Records to where an entry landed. Approvals file under the email's
     // month (or right now, for udhaar links) while Records shows one month at a
     // time — without this the approval looks vanished.
     const jumpToStamp = (s) => {
       const per = String(s).slice(0, 7);
       viewTxPeriod = (PERIOD_RE.test(per) && per !== currentPeriod()) ? per : null;
     };
   
     try {
       const accId = pendingPickedAccount(txId, tx);
       const stamp = pendingDateStamp(tx);
       const comment = cleanText(tx.description, COMMENT_LIMIT);
       const kindEl = pendingControl(txId, 'pending-kind');
       const kind = (kindEl && kindEl.value === 'transfer' && tx.type !== 'income') ? 'transfer' : 'normal';
       const debt = pendingLinkedDebt(txId);
   
       if (debt) {
         const debtAmount = debt.amount;
         const chosenCat = pendingChosenCategory(txId, tx.type);
   
         // Amount fits the outstanding debt: one meaning, one entry.
         if (amount <= debtAmount) {
           const res = applyDebtPayment(debt, amount, accId, chosenCat);
           if (!res) { toast('That udhaar entry is already settled'); return; }
           state.settings.lastAccountId = accId;
           viewTxPeriod = null;
           save();
           await finishApproval();
           toast(res === 'settled'
             ? 'Settled with ' + debt.person + ' — ' + formatMoney(amount) + ' into ' + accountName(accId)
             : 'Recorded ' + formatMoney(amount) + ' from ' + debt.person + '. ' + formatMoney(debt.amount) + ' still outstanding.');
           return;
         }
   
         // Amount is larger than the outstanding debt: settle the udhaar in full,
         // then file the remainder as an ordinary income/expense, so no money is
         // silently dropped and the two meanings stay separate.
         const res = applyDebtPayment(debt, debtAmount, accId, chosenCat);
         if (!res) { toast('That udhaar entry is already settled'); return; }
         const remainder = round2(amount - debtAmount);
         const built = buildTransaction(
           tx.type === 'income' ? 'income' : 'expense',
           remainder,
           chosenCat,
           comment,
           stamp,
           accId,
           null
         );
         if (built.error) { toast(built.error); return; }
         learnCategory(tx, built.value.category);
         built.value.source = 'email:' + tx.id;
         touch(built.value);
         state.transactions.unshift(built.value);
         state.settings.lastAccountId = accId;
   
         const items = pendingPickedItems(txId);
         if (items.length) {
           const share = round2(remainder / items.length);
           const now = nowStamp();
           for (const s of items) {
             s.checked = true;
             s.checkedAt = now;
             s.boughtTxId = built.value.id;
             s.cost = share;
           }
         }
   
         jumpToStamp(stamp);
         save();
         await finishApproval();
         toast('Settled ' + formatMoney(debtAmount) + ' with ' + debt.person +
           ' and filed ' + formatMoney(remainder) + ' as ' + (tx.type === 'income' ? 'income' : 'expense'));
         return;
       }
   
       if (kind === 'transfer') {
         // An ATM withdrawal and its friends: the money never left your hands,
         // it only changed pockets — so it must never count as spending.
         const toEl = pendingControl(txId, 'pending-to');
         const toId = toEl && typeof toEl.value === 'string' && findAccount(toEl.value) ? toEl.value : null;
         if (!toId || toId === accId) { toast('Pick a different to-account for the transfer'); return; }
         const built = buildTransaction('transfer', amount, '', comment, stamp, accId, toId);
         if (built.error) { toast(built.error); return; }
         built.value.source = 'email:' + tx.id;
         touch(built.value);
         state.transactions.unshift(built.value);
         state.settings.lastAccountId = accId;
         jumpToStamp(stamp);
         save();
         await finishApproval();
         toast('Moved ' + formatMoney(amount) + ' from ' + accountName(accId) + ' to ' + accountName(toId));
         return;
       }
   
       // Built through the same helper the manual form uses, so the record has the
       // app's field names (date / accountId) rather than the database's column
       // names. Getting this wrong means accountBalance() never matches the row,
       // the balance stays wrong, and the push fails on a NOT NULL column.
       const built = buildTransaction(
         tx.type === 'income' ? 'income' : 'expense',
         amount,
         pendingChosenCategory(txId, tx.type),
         comment,
         stamp,
         accId,
         null
       );
       if (built.error) { toast(built.error); return; }
       // Teach the memory: next time this bank + wording arrives, the picker
       // starts on this category. Only the normal path learns — transfers and
       // udhaar links have no category to teach.
       learnCategory(tx, built.value.category);
   
       built.value.source = 'email:' + tx.id;
       touch(built.value);
   
       // unshift, so an approved transaction appears at the top of the ledger like
       // every other new entry.
       state.transactions.unshift(built.value);
       state.settings.lastAccountId = accId;
   
       // Grocery flow: the ticked items are marked bought against this exact
       // payment, splitting it the way the list's own save does — one tap files
       // the ledger AND clears the list, so the two can never disagree.
       const items = pendingPickedItems(txId);
       if (items.length) {
         const share = round2(amount / items.length);
         const now = nowStamp();
         for (const s of items) {
           s.checked = true;
           s.checkedAt = now;
           s.boughtTxId = built.value.id;
           s.cost = share;
         }
       }
   
       jumpToStamp(stamp);
       save();
       await finishApproval();
   
       toast('Added ' + formatMoney(amount) + ' to ' + accountName(accId) + ' — dated ' + formatDate(stamp) +
         (items.length ? ' — ' + items.length + ' list item(s) ticked' : ''));
     } catch (err) {
       console.error('Approve transaction error:', err);
       toast('Failed to approve: ' + err.message);
     }
   }
   
   /** Where an approved email transaction is filed: the account whose name matches
    *  the bank the email came from, then the account the user last used, then cash.
    *  Never a hard-coded id, which would dangle the moment an account is renamed. */
   function pendingAccountId(tx) {
     // Match the bank named on the row against the user's own account names, so
     // this works for any bank rather than one hard-coded favourite. findAccount()
     // takes an ID, not a name — passing a name returns null and used to send every
     // approved transaction silently to Cash.
     const bank = cleanText(tx && tx.bank_name, NAME_LIMIT).toLowerCase();
     if (bank) {
       const hit = state.accounts.find(
         (a) => !a.archived && String(a.name).toLowerCase() === bank);
       if (hit) return hit.id;
       const loose = state.accounts.find(
         (a) => !a.archived && String(a.name).toLowerCase().indexOf(bank) !== -1);
       if (loose) return loose.id;
     }
     const last = state.settings && state.settings.lastAccountId;
     if (last && findAccount(last)) return last;
     return cashAccountId();
   }
   
   /** Use the date from the EMAIL. Falling back to today would file an old
    *  payment as a new one, which is the whole point of reading the email.
    *
    *  The *time* of day is taken from now, not from the stored value. A bank alert
    *  carries a date and nothing else, so whatever time arrives with the row is an
    *  artefact: the function writes midnight UTC, which in Pakistan reads as 05:00
    *  and in New York as 19:00 the previous day. Keeping it put a 5 a.m. payment on
    *  a record and, west of UTC, could move the entry to the wrong day entirely.
    *  The date is what matters for a budget; the time only orders the list. */
   function pendingDateStamp(tx) {
     const raw = tx.transaction_date || tx.transactionDate || '';
     const parsed = parseDate(raw);
     if (parsed) {
       const now = new Date();
       return toLocalStamp(new Date(
         parsed.getFullYear(), parsed.getMonth(), parsed.getDate(),
         now.getHours(), now.getMinutes()
       ));
     }
     return nowStamp();
   }
   
   /** A category that certainly exists, so an approved email never lands in a
    *  name the user has to repair later. */
   /** A category that certainly exists, so an approved email never lands in a
    *  name the user has to repair later.
    *
    *  "Other" for both directions, deliberately. The previous version filed income
    *  under "Salary", which is a claim about the money rather than a place to put
    *  it: someone being repaid Rs 50 was recorded as having earned a salary, and
    *  every budget that groups by category inherited the claim. The pending list
    *  already shows the amount and the name, so the category only has to be a
    *  bucket — the user can move it in one tap afterwards, and until they do it is
    *  at least not wrong. */
   function emailCategory(type) {
     if (findCategory('Other')) return 'Other';
     return state.categories[0] || 'Other';
   }
   
   async function rejectTransaction(txId) {
     // Drop it from the list first. Rejecting is about not wanting to see it, so
     // the row should disappear immediately; if the PATCH then fails, the worst
     // case is that the same email reappears in the queue and can be rejected
     // again. The reverse order left the button looking broken on a slow network.
     pendingTransactions = pendingTransactions.filter(t => t.id !== txId);
     renderPendingQueue();
   
     try {
       await sbFetch('pending_transactions?id=eq.' + encodeURIComponent(txId), {
         method: 'PATCH',
         body: JSON.stringify({ status: 'rejected' })
       });
       toast('Rejected');
     } catch (err) {
       console.warn('Removed from the list, but the server was not told:', err && err.message);
       toast('Removed here, but it may reappear. Check your connection.');
     }
   }
   
   // NOTE: there is deliberately no second formatDate here, and no second
   // formatAmount. An earlier version of this file declared a formatDate for the
   // email code; because function declarations hoist, it silently replaced the
   // real one near the top of the file and every date in the UI quietly lost its
   // time component. The email code now uses formatMoney, which already existed.
   // A test asserts no function name is declared twice in this file.
   
   if (document.readyState === 'loading') {
     document.addEventListener('DOMContentLoaded', init, { once: true });
   } else {
     init();
   }
   //test