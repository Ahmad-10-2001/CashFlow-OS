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
const QTY_LIMIT = 24;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;

const DEFAULT_CATEGORIES = ['Salary', 'Food', 'Bike/Fuel', 'Groceries', 'Bills', 'Shopping', 'Health', 'Travel', 'Family', 'Other'];
const DEFAULT_BUDGETS = { Food: 10000, 'Bike/Fuel': 10000, Groceries: 8000, Bills: 5000 };

/* Seeded accounts. These are only a starting point — every account can be
   renamed, added, archived or deleted from the Accounts tab, so nothing about
   the app is hard-wired to this list. The ids are fixed on purpose: a v3 file
   is migrated by pointing its transactions at CASH_ACCOUNT_ID, and a stable id
   means that mapping survives a re-import. */
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

/* Tabs, in menu order. Keep in sync with the markup. */
const TABS = [
  { id: 'home',         label: 'Home',       glyph: '◈' },
  { id: 'accounts',     label: 'Accounts',   glyph: '▣' },
  { id: 'transactions', label: 'Records',    glyph: '≡' },
  { id: 'budget',       label: 'Budget',     glyph: '◎' },
  { id: 'udhaar',       label: 'Udhaar',     glyph: '⇄' },
  { id: 'custody',      label: 'Amanat',     glyph: '⚿' },
  { id: 'reports',      label: 'Reports',    glyph: '◔' },
  { id: 'list',         label: 'List',       glyph: '☑' },
  { id: 'categories',   label: 'Categories', glyph: '❑' },
  { id: 'email',        label: 'Email',      glyph: '📧' },
  { id: 'pending',      label: 'Pending',    glyph: '🔔' },
  { id: 'settings',     label: 'Backup',     glyph: '⚙' }
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

/** Coerce anything into a usable positive amount, or null. Rejects NaN/Infinity/0/negatives. */
function toPositiveNumber(v) {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v.replace(/,/g, '').trim());
  else return null;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  return round2(n);
}

function cleanText(v, limit) {
  if (typeof v !== 'string') return '';
  // strip control characters that would corrupt display
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
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
    custody: [],
    accounts: blankAccounts(),
    settings: { budgetOffset: Object.create(null), lastAccountId: CASH_ACCOUNT_ID },
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

  const addAccount = (id, name, kind, opening, archived, a) => {
    const clean = cleanText(name, NAME_LIMIT);
    if (!clean) return null;
    const key = clean.toLowerCase();
    if (accountNames.has(key)) { note('merged a duplicate account named "' + clean + '"'); return null; }
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
    // whatever the user physically had, so it lands on Cash.
    let accountId = typeof t.accountId === 'string' && accountIdSet.has(t.accountId) ? t.accountId : null;
    if (!accountId) {
      if (typeof t.accountId === 'string' && t.accountId) note('re-filed a transaction whose account no longer exists, under Cash');
      accountId = cashId;
      defaultedToCash++;
    }

    let toAccountId = null;
    if (isTransfer) {
      toAccountId = typeof t.toAccountId === 'string' && accountIdSet.has(t.toAccountId) ? t.toAccountId : null;
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
      settings: { budgetOffset, lastAccountId },
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

function resetAll() {
  if (!confirm('Delete ALL transactions, udhaar, budgets, categories and list items from this browser? This cannot be undone. Export a backup first if you might want the data back.')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
  state = blankState();
  reportRange = { mode: 'month' };
  budgetPeriod = null;
  renderAll();
  toast('All local data cleared.');
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
  for (const t of state.transactions) {
    if (t.type === 'transfer') continue;
    const d = new Date(t.date);
    if (start && d < start) continue;
    if (end && d > end) continue;
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
  let income = 0;
  let expense = 0;
  let transferIn = 0;
  let transferOut = 0;
  for (const t of state.transactions) {
    const d = new Date(t.date);
    if (start && d < start) continue;
    if (end && d > end) continue;
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

/* ---------- custody (amanat) ---------- */

/** What is still held out for other people. Nothing here touches the balance. */
function custodyTotals() {
  let given = 0;
  let held = 0;
  for (const c of state.custody) {
    const out = round2(c.amount - c.returned);
    if (out <= 0) continue;
    if (c.direction === 'given') given += out;
    else held += out;
  }
  return { given: round2(given), held: round2(held) };
}

function custodyOutstanding(c) { return round2(c.amount - c.returned); }

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
  const map = new Map();
  for (const t of state.transactions) {
    if (t.type !== 'expense') continue;
    const d = new Date(t.date);
    if (start && d < start) continue;
    if (end && d > end) continue;
    map.set(t.category, round2((map.get(t.category) || 0) + t.amount));
  }
  return map;
}

/** Income per category inside a window — used to offset a budget when the
 *  category has that switch on. */
function incomeByCategory(start, end) {
  const map = new Map();
  for (const t of state.transactions) {
    if (t.type !== 'income') continue;
    const d = new Date(t.date);
    if (start && d < start) continue;
    if (end && d > end) continue;
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
function toast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  if (toastTimer) clearTimeout(toastTimer);
  const el = h('div', { class: 'toast show', role: 'status', 'aria-live': 'polite' }, msg);
  document.body.append(el);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/* ============================================================
   Tabs
   ============================================================ */

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

  // The email tabs are the only ones that need the network, and most sessions
  // never open them. Fetching on every page load spent two requests to fill
  // panels nobody looked at, on a connection that may not even exist.
  if (name === 'email') loadEmailRouteStatus();
  if (name === 'pending') loadPendingTransactions();

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

  mount(select, names.map((name) => {
    const isOrphan = !state.categories.some((c) => c.toLowerCase() === name.toLowerCase());
    return h('option', { value: name }, isOrphan ? name + ' (removed)' : name);
  }));

  if (o.selected) {
    const match = names.find((n) => n.toLowerCase() === String(o.selected).toLowerCase());
    if (match) { select.value = match; return; }
  }
  select.selectedIndex = 0;
}

function refreshSelects() {
  fillCategorySelect($('txCategory'));
  fillCategorySelect($('budgetCategory'));
  refreshAccountSelects();
}

/** Fill an account <select>. Archived accounts are omitted by default so new
 *  entries cannot land in a closed wallet, but a caller can ask for them by
 *  passing the id it needs to keep visible (used when editing a record). */
function fillAccountSelect(select, opts) {
  if (!select) return;
  const o = opts || {};
  const chosen = typeof o.selected === 'string' ? o.selected : (state.settings.lastAccountId || cashAccountId());
  const list = state.accounts.filter((a) => !a.archived || a.id === chosen);

  mount(select, list.map((a) => h('option', { value: a.id }, a.archived ? a.name + ' (archived)' : a.name)));
  if (list.some((a) => a.id === chosen)) select.value = chosen;
  else if (list.length) select.value = list[0].id;
}

function refreshAccountSelects() {
  fillAccountSelect($('txAccount'));
  fillAccountSelect($('txToAccount'));
  fillAccountSelect($('itemAccount'));
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
  if (n > 0) {
    toast('"' + acc.name + '" has ' + n + ' transaction(s). Archive it instead — deleting would lose them.');
    return;
  }
  if (!confirm('Delete "' + acc.name + '"? This cannot be undone.')) return;
  dropRecord('accounts', id);
  if (state.settings.lastAccountId === id) state.settings.lastAccountId = cashAccountId();
  save();
  toast('Deleted "' + acc.name + '"');
}

/* ============================================================
   Custody / Amanat
   ============================================================ */

function addCustody() {
  const person = cleanText($('custodyPerson').value, NAME_LIMIT);
  if (!person) { toast('Enter the person’s name'); return; }
  const amount = readAmountField($('custodyAmount'), 'Amount');
  if (amount.error) { toast(amount.error); return; }

  state.custody.push({
    id: newId(),
    person,
    direction: $('custodyDirection').value === 'held' ? 'held' : 'given',
    amount: amount.value,
    returned: 0,
    note: cleanText($('custodyNote').value, COMMENT_LIMIT),
    date: inputToStamp($('custodyDate').value),
    returnedDate: null
  });

  $('custodyPerson').value = '';
  $('custodyAmount').value = '';
  $('custodyNote').value = '';
  $('custodyPerson').focus();
  save();
  toast('Amanat saved. It stays out of your balance.');
}

function returnCustody(id) {
  const c = state.custody.find((x) => x.id === id);
  if (!c) { toast('That entry no longer exists'); return; }
  const out = custodyOutstanding(c);
  if (out <= 0) return;

  const input = window.prompt(
    c.direction === 'given'
      ? 'How much of the ' + formatMoney(out) + ' you gave ' + c.person + ' have come back?\n\nEnter the full amount to close it, or less to record a part return.'
      : 'How much of the ' + formatMoney(out) + ' ' + c.person + ' left with you has been returned?\n\nEnter the full amount to close it, or less to record a part return.',
    String(out)
  );
  if (input === null) return;

  let amount = toPositiveNumber(input);
  if (amount === null) amount = out;   // blank means "all of it"
  if (amount > out) { toast('That is more than the ' + formatMoney(out) + ' still outstanding'); return; }

  const before = c.returned;
  c.returned = round2(before + amount);
  c.returnedDate = c.returned >= c.amount ? nowStamp() : c.returnedDate;
  save();
  toast(c.returned >= c.amount
    ? c.person + ' settled — nothing outstanding'
    : 'Recorded ' + formatMoney(amount) + ' back. ' + formatMoney(custodyOutstanding(c)) + ' still out.');
}

function deleteCustody(id) {
  const c = state.custody.find((x) => x.id === id);
  if (!c) { toast('That entry is already gone'); return; }
  if (!confirm('Delete the amanat entry for ' + c.person + ' (' + formatMoney(c.amount) + ')?')) return;
  dropRecord('custody', id);
  if (save()) toast('Amanat entry deleted');
}

/* ============================================================
   Categories
   ============================================================ */

function findCategory(name) {
  const key = String(name).toLowerCase();
  return state.categories.find((c) => c.toLowerCase() === key);
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

  budgetsFor(period)[cat] = amount.value;
  $('budgetAmount').value = '';
  if (save()) toast('Budget set for ' + cat + ' in ' + periodLabel(period));
}

function removeBudget(cat) {
  const period = activeBudgetPeriod();
  if (!Object.prototype.hasOwnProperty.call(budgetsFor(period), cat)) return;
  if (!confirm('Remove the budget for "' + cat + '" in ' + periodLabel(period) + '?')) return;
  delete state.budgets[period][cat];
  if (save()) toast('Budget removed for ' + cat);
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
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: label + ' must be a number' };
  if (n <= 0) return { error: label + ' must be more than zero' };
  if (n > MAX_AMOUNT) return { error: label + ' is too large' };
  return { value: round2(n) };
}

/** Build a transaction from the Home form. Also used by the edit modal, so the
 *  validation lives in one place and a saved record can never be shaped
 *  differently depending on which form it came through. */
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

  state.transactions.unshift(built.value);
  state.settings.lastAccountId = fromId;

  $('txAmount').value = '';
  $('txComment').value = '';
  $('txType').value = 'expense';
  $('txDate').value = stampToInput(nowStamp());
  setTxTypeFields();
  $('txAmount').focus();

  if (!save()) return;
  toast(type === 'transfer'
    ? 'Moved ' + formatMoney(amount.value) + ' from ' + accountName(fromId) + ' to ' + accountName(toId)
    : 'Transaction saved');
}

/** Show only the fields that apply to the selected type. A transfer has no
 *  category, so showing an unused dropdown there would invite a wrong filing. */
function setTxTypeFields() {
  const isTransfer = $('txType').value === 'transfer';
  const setHidden = (id, hidden) => { const e = $(id); if (e) e.hidden = hidden; };

  setHidden('txCategoryGroup', isTransfer);
  setHidden('txToAccountGroup', !isTransfer);
  setHidden('txAccountGroup', false);
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
  dropRecord('transactions', id);
  if (save()) toast('Transaction deleted');
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

function addDebt() {
  const person = cleanText($('debtPerson').value, NAME_LIMIT);
  if (!person) { toast('Enter the person’s name'); return; }
  const amount = readAmountField($('debtAmount'), 'Amount');
  if (amount.error) { toast(amount.error); return; }

  state.debts.push({
    id: newId(),
    type: $('debtType').value === 'pay' ? 'pay' : 'receive',
    person,
    amount: amount.value,
    note: cleanText($('debtNote').value, COMMENT_LIMIT),
    date: nowStamp(),
    settled: false,
    settledAt: null,
    ledger: $('debtLedger').checked
  });

  $('debtPerson').value = '';
  $('debtAmount').value = '';
  $('debtNote').value = '';
  $('debtPerson').focus();

  if (save()) toast('Udhaar added');
}

function deleteDebt(id) {
  const d = state.debts.find((x) => x.id === id);
  if (!d) { toast('That entry is already gone'); return; }
  if (!confirm('Delete the udhaar entry for ' + d.person + '?')) return;
  dropRecord('debts', id);
  syncLedgerForDebt(d, { forceRemove: true });
  if (save()) toast('Udhaar deleted');
}

function settleDebt(id) {
  const d = state.debts.find((x) => x.id === id);
  if (!d) { toast('That entry is already gone'); return; }

  if (d.ledger) {
    const action = d.settled ? 'Un-settling' : 'Settling';
    const effect = d.settled
      ? 'remove the linked entry from'
      : 'record ' + formatMoney(d.amount) + ' in';
    const where = d.settled ? 'your balance' : 'your balance as ' + (d.type === 'receive' ? 'income' : 'an expense');
    if (!confirm(action + ' ' + d.person + ' will ' + effect + ' ' + where + '. Continue?')) return;
  }

  d.settled = !d.settled;
  d.settledAt = d.settled ? nowStamp() : null;
  syncLedgerForDebt(d);

  if (save()) toast(d.settled ? 'Marked as settled' : 'Marked as unsettled');
}

/**
 * Keep the ledger in step with a debt. Idempotent: any previously linked
 * transaction is removed first, so toggling settle twice cannot duplicate it.
 */
function syncLedgerForDebt(d, opts) {
  const marker = 'debt:' + d.id;
  // Drop the previously linked entry, leaving a tombstone so the removal
  // also reaches other devices rather than the old row reappearing.
  state.transactions.filter((t) => t.source === marker)
    .forEach((t) => dropRecord('transactions', t.id));
  if (opts && opts.forceRemove) return;
  if (!d.settled || !d.ledger) return;
  // A settlement is money that actually moved, so it belongs to whichever
  // account the user settles into — not silently to whatever was used last.
  const accId = state.settings.lastAccountId && findAccount(state.settings.lastAccountId)
    ? state.settings.lastAccountId
    : cashAccountId();
  state.transactions.unshift({
    id: newId(),
    type: d.type === 'receive' ? 'income' : 'expense',
    amount: d.amount,
    category: findCategory('Other') ? 'Other' : state.categories[0],
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
  // quantity or note.
  input.value = '';
  $('itemQty').value = '';
  $('itemNote').value = '';
  input.focus();
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

  mount(out, section);
}

/* ============================================================
   Month archive
   ============================================================ */

function closePeriod() {
  const period = currentPeriod();
  if (isClosed(period)) { toast(periodLabel(period) + ' is already closed'); return; }
  if (!confirm(
    'Close ' + periodLabel(period) + '?\n\n' +
    'Its budgets and reports are kept and stay readable. New entries go to the new month.\n\n' +
    'A backup file will be downloaded first.'
  )) return;

  exportBackup({ quiet: true });
  state.closedPeriods.push(period);
  state.closedPeriods.sort();
  save();
  toast(periodLabel(period) + ' closed. History is kept — reopen it any time from Backup.');
}

function reopenPeriod(period) {
  const i = state.closedPeriods.indexOf(period);
  if (i === -1) return;
  state.closedPeriods.splice(i, 1);
  save();
  toast(periodLabel(period) + ' reopened');
}

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
  const nTx = incoming.transactions.length;
  const nDebt = incoming.debts.length;
  const nItem = incoming.shopping.length;
  const nCust = incoming.custody.length;

  if (!confirm(
    'Replace everything in this browser with the contents of "' + file.name + '"?\n\n' +
    'Incoming: ' + nTx + ' transaction(s), ' + nDebt + ' udhaar entr(y/ies), ' +
    nItem + ' list item(s), ' + nCust + ' amanat entr(y/ies), ' +
    incoming.accounts.length + ' account(s), ' + Object.keys(incoming.budgets).length + ' month(s) of budgets, ' +
    incoming.categories.length + ' categor(y/ies).\n\n' +
    'Current: ' + state.transactions.length + ' transaction(s), ' + state.debts.length + ' udhaar entr(y/ies), ' +
    state.custody.length + ' amanat entr(y/ies), ' + state.accounts.length + ' account(s).\n\n' +
    'This cannot be undone.'
  )) return;

  state = incoming;
  reportRange = { mode: 'month' };
  budgetPeriod = null;
  const ok = save();
  if (!ok) return;
  toast(problems.length
    ? 'Backup imported — repaired ' + problems.length + ' issue(s): ' + problems[0]
    : 'Backup imported');
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
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  activeModalId = null;
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  lastFocused = null;
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
  const all = ledgerTotals(null, null);
  const u = udhaarTotals();
  const { rows, total } = allAccountBalances();

  // The headline is the sum of the account boxes below it, so the two can never
  // disagree — which is exactly why a transfer, which moves money between the
  // boxes without touching income or expense, leaves this number unchanged.
  const el = $('balanceDisplay');
  el.textContent = formatMoney(total);
  el.classList.toggle('negative', total < 0);
  el.classList.toggle('positive', total >= 0);

  $('totalIncome').textContent = formatMoney(all.income);
  $('totalExpense').textContent = formatMoney(all.expense);

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

  mount($('accountTotal'), h('span', { class: 'label' }, 'Total across ' + rows.length + ' account(s)'),
    h('span', { class: 'value' }, formatMoney(total)));

  if (!rows.length) {
    mount(list, h('div', { class: 'empty-state' }, 'No accounts. Add one below.'));
  } else {
    mount(list, rows.map((r) => {
      const act = accountActivity(r.account.id, null, null);
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

  const transfers = transferList();
  mount($('transferList'), transfers.length
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
    : h('div', { class: 'empty-state' }, 'No transfers yet. Use "Move between accounts" on the Home tab.'));
}

/* ---------- custody / amanat tab ---------- */

function renderCustody() {
  const t = custodyTotals();
  const list = $('custodyList');

  mount($('custodySummary'), h('div', { class: 'custody-box given' },
      h('div', { class: 'custody-box-label' }, 'Others are holding'),
      h('div', { class: 'custody-box-value' }, formatMoney(t.given)),
      h('div', { class: 'custody-box-hint' }, 'your money, in their hand')
    ),
    h('div', { class: 'custody-box held' },
      h('div', { class: 'custody-box-label' }, 'You are holding'),
      h('div', { class: 'custody-box-value' }, formatMoney(t.held)),
      h('div', { class: 'custody-box-hint' }, "other people's money, in your hand")
    )
  );

  if (!state.custody.length) {
    mount(list, h('div', { class: 'empty-state' }, 'Nothing on amanat. Money you give someone to hold — or hold for someone — goes here.'));
    return;
  }

  const byDateDesc = (a, b) => {
    const diff = new Date(b.date) - new Date(a.date);
    return diff !== 0 ? diff : (a.id < b.id ? -1 : 1);
  };
  const open = state.custody.filter((c) => custodyOutstanding(c) > 0).sort(byDateDesc);
  const done = state.custody.filter((c) => custodyOutstanding(c) <= 0).sort(byDateDesc);

  const children = [];
  if (open.length) {
    children.push(h('div', { class: 'list-section-head' }, 'Still out (' + open.length + ')'));
    open.forEach((c) => {
      const out = custodyOutstanding(c);
      children.push(h('div', { class: 'custody-item' },
        h('div', { class: 'custody-head' },
          h('span', { class: 'custody-person' }, c.person),
          h('span', { class: 'custody-amount ' + c.direction },
            (c.direction === 'given' ? '− ' : '+ ') + formatMoney(out))
        ),
        h('div', { class: 'custody-detail' },
          c.direction === 'given' ? 'you gave this, it is theirs' : 'they gave this, you are keeping it'),
        c.note ? h('div', { class: 'custody-detail' }, c.note) : null,
        h('div', { class: 'custody-detail' },
          'Given ' + formatDate(c.date) +
          (c.returned ? '  ·  ' + formatMoney(c.returned) + ' back' + (c.returnedDate ? ' on ' + formatDate(c.returnedDate) : '') : '')),
        h('div', { class: 'custody-actions' },
          button('Return some', 'custody-return', { id: c.id }),
          button('Delete', 'custody-delete', { id: c.id, class: 'btn-mini danger' })
        )
      ));
    });
  }

  if (done.length) {
    children.push(h('div', { class: 'list-section-head' }, 'Returned in full (' + done.length + ')'));
    done.forEach((c) => children.push(
      h('div', { class: 'custody-item is-done' },
        h('div', { class: 'custody-head' },
          h('span', { class: 'custody-person' }, c.person),
          h('span', { class: 'custody-amount' },
            (c.direction === 'given' ? '− ' : '+ ') + formatMoney(c.amount) + ' · returned')
        ),
        h('div', { class: 'custody-detail' }, 'Given ' + formatDate(c.date)),
        h('div', { class: 'custody-actions' },
          button('Delete', 'custody-delete', { id: c.id, class: 'btn-mini danger' })
        )
      )));
  }

  mount(list, children);
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
        const used = Math.max(0, round2(gross - inc));
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
          inc > 0
            ? h('div', { class: 'budget-breakdown' },
                'Spent ' + formatMoney(gross) + ' − income ' + formatMoney(inc) + ' = ' + formatMoney(used) + ' counted')
            : null,
          h('label', { class: 'check budget-toggle' },
            h('input', { type: 'checkbox', checked: offset, dataset: { act: 'budget-offset', arg: cat } }),
            h('span', {}, 'Income in this category reduces the budget')
          ),
          h('button', { type: 'button', class: 'budget-remove', dataset: { act: 'budget-delete', arg: cat }, 'aria-label': 'Remove budget for ' + cat }, 'Remove budget')
        );
      }));

  mount($('budgetList'), head, body);
  fillCategorySelect($('budgetCategory'));
}

function renderTransactions() {
  const input = $('txSearch');
  const search = String((input && input.value) || '').trim().toLowerCase();
  const list = $('txList');

  // Sorted here rather than with a locale-aware comparator so the order is
  // identical in every browser. The id tiebreak matters because several records
  // can share a minute: without it, Array.sort is not guaranteed stable across
  // engines and rows would jump around between renders.
  let rows = state.transactions.slice().sort((a, b) => {
    const diff = new Date(b.date) - new Date(a.date);
    return diff !== 0 ? diff : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  if (search) {
    rows = rows.filter((t) => {
      const cat = String(t.category || '').toLowerCase();
      const comment = String(t.comment || '').toLowerCase();
      const amount = String(t.amount);
      const grouped = amount.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      // Transfers carry no category, so the route is searched instead.
      const route = t.type === 'transfer'
        ? (accountName(t.accountId) + ' ' + accountName(t.toAccountId)).toLowerCase()
        : '';
      return cat.includes(search) || comment.includes(search) || amount.includes(search) ||
        grouped.includes(search) || route.includes(search);
    });
  }

  if (!rows.length) {
    mount(list, h('div', { class: 'empty-state' }, search ? 'No transactions match "' + search + '"' : 'No transactions yet'));
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
      t.source ? h('div', { class: 'tx-detail tx-linked' }, t.source.indexOf('list:') === 0 ? 'bought from your list' : 'linked to an udhaar entry') : null,
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
      h('div', { class: 'debt-detail' }, 'Added ' + formatDate(d.date)),
      h('div', { class: 'debt-actions' },
        button('Settle', 'debt-settle', { id: d.id, class: 'btn-mini settle' }),
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
    mount(list, state.categories.map((cat) =>
      h('div', { class: 'category-item' },
        h('div', { class: 'category-info' },
          h('span', { class: 'category-name' }, cat),
          h('span', { class: 'category-count' },
            (counts.get(cat.toLowerCase()) || 0) + ' transaction(s)' + (offsetOn(cat) ? ' · income offsets budget' : ''))
        ),
        iconButton('✕', 'category-delete', { arg: cat, title: 'Delete category ' + cat })
      )
    ));
  }
  refreshSelects();
}

function renderShopping() {
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

function renderMonths() {
  const list = $('monthList');
  const closed = state.closedPeriods.slice().reverse();
  const now = currentPeriod();

  const rows = [];
  rows.push(h('div', { class: 'month-item is-current' },
    h('div', { class: 'month-info' },
      h('span', { class: 'month-name' }, periodLabel(now)),
      h('span', { class: 'month-meta' }, 'Open — new entries land here')
    )
  ));
  closed.forEach((p) => {
    const counts = state.transactions.filter((t) => {
      const d = new Date(t.date);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) === p;
    }).length;
    rows.push(h('div', { class: 'month-item' },
      h('div', { class: 'month-info' },
        h('span', { class: 'month-name' }, periodLabel(p)),
        h('span', { class: 'month-meta' }, 'Closed · ' + counts + ' transaction(s) kept')
      ),
      h('div', { class: 'month-actions' },
        button('View', 'month-report', { arg: p, class: 'btn-mini' }),
        button('Reopen', 'month-reopen', { arg: p })
      )
    ));
  });

  mount(list, rows.length
    ? h('div', { class: 'month-list' }, rows)
    : h('div', { class: 'empty-state' }, 'No closed months yet'));
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
  S.setPersist(() => { save(); });
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

  repairReport = res.report.join('\n');
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
  renderAccounts();
  renderBudgets();
  renderTransactions();
  renderDebts();
  renderCustody();
  renderCategories();
  renderShopping();
  renderMonths();
  renderReport();
  renderSyncPanel();
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
  'debt-edit': (el) => openDebtEditModal(el.dataset.id),
  'debt-delete': (el) => deleteDebt(el.dataset.id),
  'category-delete': (el) => removeCategory(el.dataset.arg),
  'budget-delete': (el) => removeBudget(el.dataset.arg),
  'report': (el) => showReport(el.dataset.arg),
  'report-custom': applyCustomRange,
  'item-toggle': (el) => toggleListItem(el.dataset.id),
  'item-delete': (el) => deleteListItem(el.dataset.id),
  'item-clear': clearCheckedItems,
  'acct-rename': (el) => renameAccount(el.dataset.id),
  'acct-opening': (el) => setOpeningBalance(el.dataset.id),
  'acct-archive': (el) => toggleArchiveAccount(el.dataset.id),
  'acct-delete': (el) => deleteAccount(el.dataset.id),
  'custody-return': (el) => returnCustody(el.dataset.id),
  'custody-delete': (el) => deleteCustody(el.dataset.id),
  'auth-in': () => handleAuth('in'),
  'auth-up': () => handleAuth('up'),
  'auth-forgot': () => beginPasswordReset(),
  'reset-cancel': () => cancelPasswordReset(),
  'reset-resend': () => beginPasswordReset(),
  'sync-now': () => { if (window.CashFlowSync) window.CashFlowSync.cycle(state).then(() => renderAll()); },
  'sync-signout': signOut,
  'sync-repair': repairCloud,
  'month-close': closePeriod,
  'month-reopen': (el) => reopenPeriod(el.dataset.arg),
  'month-report': (el) => showReport('custom', {
    from: el.dataset.arg + '-01',
    to: lastDayOf(el.dataset.arg)
  }),
  'export': () => exportBackup(),
  'import': importBackup,
  'reset': resetAll,
  'close-modal': (el) => closeModal(el.dataset.target),
  'approve-tx': (el) => approveTransaction(el.dataset.id),
  'reject-tx': (el) => rejectTransaction(el.dataset.id)
};

function lastDayOf(period) {
  const parts = String(period).split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]), 0);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

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

  // change events (checkboxes, month pickers) need their own listener.
  // Order matters: a control with no data-act must not bail out early, or the
  // month picker would be ignored because it only carries an id.
  document.addEventListener('change', (e) => {
    if (!(e.target instanceof Element)) return;

    if (e.target.id === 'budgetPeriod') { changeBudgetPeriod(e.target.value); return; }
    if (e.target.id === 'txType') { setTxTypeFields(); return; }
    if (e.target.id === 'editType') { setEditTypeFields(); return; }

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
    ['custodyForm', addCustody],
    ['editForm', saveEdit],
    ['editDebtForm', saveDebtEdit]
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

  // close modals on backdrop click
  ['editModal', 'editDebtModal'].forEach((id) => {
    const overlay = $(id);
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(id); });
  });

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
  const stale = staleAssetReason();
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

  wireEvents();

  /* Decide what the sync panel should show, before the first render paints it.
     Two ways to arrive here with a valid recovery token: a link the user just
     clicked, or a reload in the middle of the flow. Both mean "show the new
     password form", and both must land the user on the panel that has it. */
  if (recovered && recovered.ok && window.CashFlowSync && window.CashFlowSync.hasResetToken) {
    resetMode = 'newpw';
    resetEmail = window.CashFlowSync.resetEmail;
  } else if (recovered && recovered.error) {
    // Only reachable if a link was clicked. The overwhelmingly common cause is
    // that the project has no redirect URL set, in which case the link never
    // gets this far — it lands on Supabase's own default page. Say so, because
    // "invalid or expired" on its own sends people looking in the wrong place.
    // A dead link is nearly always the project's redirect URL, not an expired
    // token. Saying "invalid or expired" sends people looking for a security
    // problem that is not there, so name the real cause instead.
    toast('That link no longer works. Each one can only be used once — press Forgot your password? to have another sent.');
  } else if (resetMode === null && window.CashFlowSync && window.CashFlowSync.hasResetToken) {
    // Reloaded part-way through: the token survived in storage.
    resetMode = 'newpw';
    resetEmail = window.CashFlowSync.resetEmail;
  }

  // Default the date fields to now, so a new entry is "right now" until changed.
  if ($('txDate')) $('txDate').value = stampToInput(nowStamp());
  if ($('custodyDate')) $('custodyDate').value = stampToInput(nowStamp());

  // Show only the fields that apply to the selected transaction type.
  if ($('txType')) setTxTypeFields();
  refreshAccountSelects();

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
    // needs a way to write it down and repaint.
    window.CashFlowSync.setPersist(() => { save(); });
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

/** Build Supabase REST headers using the current session token. */
function sbHeaders() {
  const cfg = window.CASHFLOW_CONFIG || {};
  // Named `headers`, not `h`: h() is this file's element builder, and shadowing
  // it inside a helper is the kind of thing that gets "fixed" wrongly later.
  const headers = {
    'apikey': cfg.publishableKey,
    'Content-Type': 'application/json'
  };
  // Reuse the session token from sync.js
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

/** Make a Supabase REST API call using plain fetch. */
async function sbFetch(path, opts) {
  const cfg = window.CASHFLOW_CONFIG || {};
  const url = cfg.url + '/rest/v1/' + path;
  const res = await fetch(url, Object.assign({
    headers: sbHeaders()
  }, opts || {}));
  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch (err) { body = text; } }
  if (!res.ok) {
    const msg = (body && (body.msg || body.message || body.error_description)) ||
      (body && body.error) || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return body;
}

/** Get current user ID from the session. */
function getCurrentUserId() {
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
  if (!userId) { renderEmailConnectStatus(); return; }

  try {
    const data = await sbFetch('email_routes?user_id=eq.' + userId + '&is_active=eq.true');
    emailConnected = !!(data && data.length);
  } catch (err) {
    // A missing table or a policy gap must not break the app; the panel just
    // reports that forwarding is not confirmed.
    console.warn('Could not read the forwarding route:', err && err.message);
    emailConnected = false;
  }
  renderEmailConnectStatus();
}

function renderEmailConnectStatus() {
  const statusEl = $('emailConnectStatus');
  if (!statusEl) return;

  if (emailConnected) {
    mount(statusEl, h('div', { class: 'email-status connected' },
      h('span', { class: 'email-status-icon' }, '✓'),
      h('span', {}, 'Forwarding is set up — new NayaPay emails will appear under Pending')
    ));
  } else {
    mount(statusEl, h('div', { class: 'email-status disconnected' },
      h('span', { class: 'email-status-icon' }, '○'),
      h('span', {}, 'Forwarding not set up yet — follow the steps below')
    ));
  }
}

async function loadPendingTransactions() {
  const userId = getCurrentUserId();
  if (!userId) { renderPendingQueue(); return; }

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
    pendingQueueError = (err && err.message) || 'Could not load';
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
          (tx.type === 'income' ? '+ ' : '− ') + CURRENCY + ' ' + formatMoney(amount === null ? 0 : amount)),
        h('div', { class: 'pending-desc' }, cleanText(tx.description, COMMENT_LIMIT) || '(no description)'),
        h('div', { class: 'pending-meta' },
          cleanText(tx.bank_name, NAME_LIMIT) || 'Bank',
          when ? ' • ' + formatDate(when.toISOString()) : ' • date unknown')
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

async function approveTransaction(txId) {
  const userId = getCurrentUserId();
  if (!userId) return;

  const tx = pendingTransactions.find(t => t.id === txId);
  if (!tx) return;

  // The row came from the server, so its amount is not trusted to be a number.
  // Approving a NaN would write a poisoned row straight into the ledger.
  const amount = toPositiveNumber(tx.amount);
  if (amount === null) { toast('This row has no usable amount, so it cannot be approved'); return; }

  try {
    // Built through the same helper the manual form uses, so the record has the
    // app's field names (date / accountId) rather than the database's column
    // names. Getting this wrong means accountBalance() never matches the row,
    // the balance stays wrong, and the push fails on a NOT NULL column.
    const accId = pendingAccountId(tx);
    const stamp = pendingDateStamp(tx);
    const built = buildTransaction(
      tx.type === 'income' ? 'income' : 'expense',
      amount,
      emailCategory(tx.type),
      cleanText(tx.description, COMMENT_LIMIT),
      stamp,
      accId,
      null
    );
    if (built.error) { toast(built.error); return; }

    built.value.source = 'email:' + tx.id;
    touch(built.value);

    // unshift, so an approved transaction appears at the top of the ledger like
    // every other new entry.
    state.transactions.unshift(built.value);
    save();

    // Mark as approved in Supabase. Done AFTER the local save: if this call
    // fails, the transaction is already safely in the ledger and the row will
    // simply stay pending, which is better than losing the money entry.
    try {
      await sbFetch('pending_transactions?id=eq.' + txId, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'approved', approved_at: new Date().toISOString() })
      });
    } catch (err) {
      console.warn('Saved locally, but the pending row could not be marked approved:', err && err.message);
    }

    pendingTransactions = pendingTransactions.filter(t => t.id !== txId);
    renderPendingQueue();

    toast('Added ' + formatMoney(amount) + ' to ' + accountName(accId) + ' — dated ' + formatDate(stamp));
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
 *  payment as a new one, which is the whole point of reading the email. */
function pendingDateStamp(tx) {
  const raw = tx.transaction_date || tx.transactionDate || '';
  const parsed = parseDate(raw);
  if (parsed) {
    // Keep the email's day, but a real time of day for ordering.
    return toLocalStamp(new Date(
      parsed.getFullYear(), parsed.getMonth(), parsed.getDate(),
      parsed.getHours() || 12, parsed.getMinutes()
    ));
  }
  return nowStamp();
}

/** A category that certainly exists, so an approved email never lands in a
 *  name the user has to repair later. */
function emailCategory(type) {
  const wanted = type === 'income' ? 'Salary' : 'Other';
  if (findCategory(wanted)) return wanted;
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
