/* ============================================================
   Salary Manager — application script
   ------------------------------------------------------------
   Design notes
   • All persistent state lives in ONE namespaced, versioned
     localStorage key. A single key means a write can never be
     observed half-finished the way four separate keys can.
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
const SCHEMA_VERSION = 3;
const LEGACY_KEYS = ['transactions', 'debts', 'budgets', 'categories'];
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

/* Tabs, in menu order. Keep in sync with the markup. */
const TABS = [
  { id: 'home',         label: 'Home',        glyph: '◈' },
  { id: 'transactions', label: 'Records',     glyph: '≡' },
  { id: 'budget',       label: 'Budget',      glyph: '◎' },
  { id: 'udhaar',       label: 'Udhaar',      glyph: '⇄' },
  { id: 'reports',      label: 'Reports',     glyph: '◔' },
  { id: 'list',         label: 'List',        glyph: '☑' },
  { id: 'categories',   label: 'Categories',  glyph: '❑' },
  { id: 'settings',     label: 'Backup',      glyph: '⚙' }
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
 *           categories:string[], shopping:Array, settings:Object, closedPeriods:string[]}} */
let state = blankState();
let storageUsable = true;
let activeTab = 'home';
let reportRange = { mode: 'month' };
let budgetPeriod = null;   // null = follow the current calendar month

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
    else if (key === 'dataset') Object.assign(node.dataset, val);
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
    settings: { budgetOffset: Object.create(null) },
    closedPeriods: []
  };
}

function isClosed(period) { return state.closedPeriods.indexOf(period) !== -1; }

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
  if (!Object.prototype.hasOwnProperty.call(budgets, thisPeriod)) budgets[thisPeriod] = Object.create(null);

  // ── settings.budgetOffset: category name → true ─────────────
  const budgetOffset = Object.create(null);
  const rawSettings = isObject(raw.settings) ? raw.settings : {};
  const rawOffset = isObject(rawSettings.budgetOffset) ? rawSettings.budgetOffset : {};
  for (const key of Object.keys(rawOffset)) {
    if (rawOffset[key] === true) budgetOffset[key.toLowerCase()] = true;
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

    transactions.push({
      id,
      type: t.type === 'income' ? 'income' : 'expense',
      amount,
      category: cleanText(t.category, NAME_LIMIT) || fallbackCategory,
      comment: cleanText(t.comment, COMMENT_LIMIT),
      // Rewritten as a local stamp. A stored UTC instant is preserved exactly:
      // parseDate() resolves it, then toLocalStamp writes the local equivalent.
      date: toLocalStamp(date || new Date()),
      source: typeof t.source === 'string' ? t.source : undefined
    });
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
      ledger: d.ledger !== false
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
      cost: toPositiveNumber(s.cost)
    });
  }

  return {
    state: { version: SCHEMA_VERSION, transactions, debts, budgets, categories, shopping, settings: { budgetOffset }, closedPeriods },
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

/** Totals over an optional window. Future-dated records are never counted. */
function ledgerTotals(start, end) {
  let income = 0;
  let expense = 0;
  for (const t of state.transactions) {
    const d = new Date(t.date);
    if (start && d < start) continue;
    if (end && d > end) continue;
    if (t.type === 'income') income += t.amount;
    else expense += t.amount;
  }
  return { income: round2(income), expense: round2(expense), net: round2(income - expense) };
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

function readAmountField(input, label) {
  const raw = String(input.value == null ? '' : input.value).trim().replace(/,/g, '');
  if (raw === '') return { error: label + ' is required' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: label + ' must be a number' };
  if (n <= 0) return { error: label + ' must be more than zero' };
  if (n > MAX_AMOUNT) return { error: label + ' is too large' };
  return { value: round2(n) };
}

function addTransaction() {
  const amount = readAmountField($('txAmount'), 'Amount');
  if (amount.error) { toast(amount.error); return; }

  state.transactions.unshift({
    id: newId(),
    type: $('txType').value === 'income' ? 'income' : 'expense',
    amount: amount.value,
    category: $('txCategory').value,
    comment: cleanText($('txComment').value, COMMENT_LIMIT),
    date: inputToStamp($('txDate').value)
  });

  $('txAmount').value = '';
  $('txComment').value = '';
  $('txType').value = 'expense';
  $('txDate').value = stampToInput(nowStamp());
  $('txAmount').focus();

  if (save()) toast('Transaction saved');
}

function deleteTransaction(id) {
  const tx = state.transactions.find((t) => t.id === id);
  if (!tx) { toast('That transaction is already gone'); return; }
  if (!confirm('Delete this ' + tx.type + ' of ' + formatMoney(tx.amount) + '?')) return;
  state.transactions = state.transactions.filter((t) => t.id !== id);
  if (save()) toast('Transaction deleted');
}

/* ---------- transaction edit modal ---------- */

function openEditModal(id) {
  const tx = state.transactions.find((t) => t.id === id);
  if (!tx) { toast('That transaction no longer exists'); return; }
  $('editId').value = tx.id;
  $('editType').value = tx.type;
  $('editAmount').value = tx.amount;
  // Keep the original category selectable even if it was deleted, so saving
  // cannot silently re-file the record under a different category.
  fillCategorySelect($('editCategory'), { selected: tx.category, orphans: [tx.category] });
  $('editComment').value = tx.comment || '';
  $('editDate').value = stampToInput(tx.date);
  openModal('editModal');
}

function saveEdit() {
  const id = $('editId').value;
  const tx = state.transactions.find((t) => t.id === id);
  if (!tx) { closeModal('editModal'); toast('That transaction no longer exists'); return; }

  const amount = readAmountField($('editAmount'), 'Amount');
  if (amount.error) { toast(amount.error); return; }

  tx.type = $('editType').value === 'income' ? 'income' : 'expense';
  tx.amount = amount.value;
  tx.category = $('editCategory').value;
  tx.comment = cleanText($('editComment').value, COMMENT_LIMIT);
  tx.date = inputToStamp($('editDate').value);

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
  state.debts = state.debts.filter((x) => x.id !== id);
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
  state.transactions = state.transactions.filter((t) => t.source !== marker);
  if (opts && opts.forceRemove) return;
  if (!d.settled || !d.ledger) return;
  state.transactions.unshift({
    id: newId(),
    type: d.type === 'receive' ? 'income' : 'expense',
    amount: d.amount,
    category: findCategory('Other') ? 'Other' : state.categories[0],
    comment: ('Udhaar settled — ' + (d.type === 'receive' ? d.person + ' paid me back' : 'I paid ' + d.person)).slice(0, COMMENT_LIMIT),
    date: d.settledAt || nowStamp(),
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
  state.shopping = state.shopping.filter((s) => s.id !== id);
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
  const tx = {
    id: newId(),
    type: 'expense',
    amount: cost.value,
    category: cat,
    comment: ('List: ' + names.join(', ')).slice(0, COMMENT_LIMIT),
    date: nowStamp(),
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
  state.shopping = state.shopping.filter((s) => !s.checked);
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
    app: 'salary-manager',
    version: SCHEMA_VERSION,
    exportDate: new Date().toISOString(),
    transactions: state.transactions,
    debts: state.debts,
    budgets: state.budgets,
    categories: state.categories,
    shopping: state.shopping,
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
  if (!isObject(parsed)) { toast('That is not a Salary Manager backup'); return; }

  const { state: incoming, problems } = sanitizeState(parsed);
  const nTx = incoming.transactions.length;
  const nDebt = incoming.debts.length;
  const nItem = incoming.shopping.length;

  if (!confirm(
    'Replace everything in this browser with the contents of "' + file.name + '"?\n\n' +
    'Incoming: ' + nTx + ' transaction(s), ' + nDebt + ' udhaar entr(y/ies), ' +
    nItem + ' list item(s), ' + Object.keys(incoming.budgets).length + ' month(s) of budgets, ' +
    incoming.categories.length + ' categor(y/ies).\n\n' +
    'Current: ' + state.transactions.length + ' transaction(s), ' + state.debts.length + ' udhaar entr(y/ies).\n\n' +
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

  const el = $('balanceDisplay');
  el.textContent = formatMoney(all.net);
  el.classList.toggle('negative', all.net < 0);
  el.classList.toggle('positive', all.net >= 0);

  $('totalIncome').textContent = formatMoney(all.income);
  $('totalExpense').textContent = formatMoney(all.expense);

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
      return cat.includes(search) || comment.includes(search) || amount.includes(search) || grouped.includes(search);
    });
  }

  if (!rows.length) {
    mount(list, h('div', { class: 'empty-state' }, search ? 'No transactions match "' + search + '"' : 'No transactions yet'));
    return;
  }

  mount(list, rows.map((t) => {
    const isIncome = t.type === 'income';
    return h('div', { class: 'tx-item' },
      h('div', { class: 'tx-header' },
        h('span', { class: 'tx-category' }, t.category),
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

function renderAll() {
  renderBalance();
  renderBudgets();
  renderTransactions();
  renderDebts();
  renderCategories();
  renderShopping();
  renderMonths();
  renderReport();
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
  'month-close': closePeriod,
  'month-reopen': (el) => reopenPeriod(el.dataset.arg),
  'month-report': (el) => showReport('custom', {
    from: el.dataset.arg + '-01',
    to: lastDayOf(el.dataset.arg)
  }),
  'export': () => exportBackup(),
  'import': importBackup,
  'reset': resetAll,
  'close-modal': (el) => closeModal(el.dataset.target)
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

    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'budget-offset') {
      setOffset(el.dataset.arg, el.checked);
      save();
    }
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

function init() {
  const loaded = loadState();
  state = loaded.state;

  wireEvents();

  // Default the date field to now, so a new entry is "right now" until changed.
  if ($('txDate')) $('txDate').value = stampToInput(nowStamp());

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

  showTab(tabFromHash(), { silent: true });

  // If anything had to be repaired, write the clean state straight back so the
  // bad data does not linger on disk (and does not re-report itself next load).
  if (loaded.broken || loaded.repaired) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
  }
  if (loaded.notice) toast(loaded.notice);

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('service-worker.js').catch((err) => console.warn('Service worker registration failed:', err));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
