/* ============================================================
   Salary Manager — application script
   ------------------------------------------------------------
   Design notes
   • All persistent state lives in ONE namespaced, versioned
     localStorage key. A single key means a write can never be
     observed half-finished the way four separate keys can.
   • Every value that comes from disk or from a user file goes
     through sanitizeState() before it is trusted.
   • The UI is built with real DOM nodes (h()) and delegated
     events (data-act). There is no innerHTML and no inline
     onclick, so user-supplied strings can never become markup
     or code.
   ============================================================ */

'use strict';

/* ---------- constants ---------- */

const STORAGE_KEY = 'salaryManager:state';
const SCHEMA_VERSION = 2;
const LEGACY_KEYS = ['transactions', 'debts', 'budgets', 'categories'];
const CURRENCY = '₨';
const MAX_AMOUNT = 1e12;
const NAME_LIMIT = 40;
const COMMENT_LIMIT = 300;

const DEFAULT_CATEGORIES = ['Salary', 'Food', 'Bike/Fuel', 'Groceries', 'Bills', 'Shopping', 'Health', 'Travel', 'Family', 'Other'];
const DEFAULT_BUDGETS = { Food: 10000, 'Bike/Fuel': 10000, Groceries: 8000, Bills: 5000 };

/* ---------- state ---------- */

/** @type {{version:number, transactions:Array, debts:Array, budgets:Object, categories:string[]}} */
let state = blankState();
let storageUsable = true;
let reportPeriod = null;

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

function blankState() {
  const budgets = Object.create(null);
  for (const k of Object.keys(DEFAULT_BUDGETS)) budgets[k] = DEFAULT_BUDGETS[k];
  return {
    version: SCHEMA_VERSION,
    transactions: [],
    debts: [],
    budgets,
    categories: [...DEFAULT_CATEGORIES]
  };
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

  // ── budgets ─────────────────────────────────────────────────
  // Null-prototype so a category named "toString" or "__proto__"
  // can never collide with Object.prototype.
  const budgets = Object.create(null);
  const rawBudgets = isObject(raw.budgets) ? raw.budgets : {};
  for (const key of Object.keys(rawBudgets)) {
    const amount = toPositiveNumber(rawBudgets[key]);
    if (amount === null) { note('dropped an invalid budget for "' + key + '"'); continue; }
    budgets[key] = amount;
  }

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
      date: (date || new Date()).toISOString(),
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
    const settledAt = settled ? (parseDate(d.settledAt) || date || new Date()).toISOString() : null;

    debts.push({
      id,
      type: d.type === 'pay' ? 'pay' : 'receive',
      person,
      amount,
      note: cleanText(d.note, COMMENT_LIMIT),
      date: (date || new Date()).toISOString(),
      settled,
      settledAt,
      ledger: d.ledger !== false
    });
  }

  return {
    state: { version: SCHEMA_VERSION, transactions, debts, budgets, categories },
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
  if (!confirm('Delete ALL transactions, udhaar, budgets and categories from this browser? This cannot be undone. Export a backup first if you might want the data back.')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
  state = blankState();
  reportPeriod = null;
  renderAll();
  toast('All local data cleared.');
}

/* ============================================================
   Derived figures
   ============================================================ */

function endOfToday() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59, 999);
}

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

function periodBounds(period) {
  const now = new Date();
  const end = endOfToday();
  if (period === 'week') {
    // Today plus the six days before it = seven days in total.
    return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6), end, label: 'Last 7 days' };
  }
  if (period === 'month') {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end,
      label: now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
    };
  }
  return { start: null, end, label: 'All time' };
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
  const hasBudget = Object.prototype.hasOwnProperty.call(state.budgets, match);

  let msg = 'Delete the category "' + match + '"?';
  if (used > 0) {
    msg += '\n\n' + used + ' transaction(s) are filed under it. They will KEEP "' + match + '" — it will just no longer appear in dropdowns, and editing one will offer it back as a removed category.';
  }
  if (hasBudget) msg += '\n\nIts monthly budget will also be deleted.';
  if (!confirm(msg)) return;

  state.categories = state.categories.filter((c) => c.toLowerCase() !== match.toLowerCase());
  delete state.budgets[match];
  save();
  toast('Deleted "' + match + '"');
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
    date: new Date().toISOString()
  });

  $('txAmount').value = '';
  $('txComment').value = '';
  $('txType').value = 'expense';
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
    date: new Date().toISOString(),
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
  d.settledAt = d.settled ? new Date().toISOString() : null;
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
    date: d.settledAt || new Date().toISOString(),
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
   Budgets
   ============================================================ */

function setBudget() {
  const cat = $('budgetCategory').value;
  if (!cat) { toast('Choose a category first'); return; }
  const amount = readAmountField($('budgetAmount'), 'Budget');
  if (amount.error) { toast(amount.error); return; }

  state.budgets[cat] = amount.value;
  $('budgetAmount').value = '';
  if (save()) toast('Budget set for ' + cat);
}

function removeBudget(cat) {
  if (!Object.prototype.hasOwnProperty.call(state.budgets, cat)) return;
  if (!confirm('Remove the monthly budget for "' + cat + '"?')) return;
  delete state.budgets[cat];
  if (save()) toast('Budget removed for ' + cat);
}

/* ============================================================
   Backup
   ============================================================ */

function localDateStamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function exportBackup() {
  const payload = {
    app: 'salary-manager',
    version: SCHEMA_VERSION,
    exportDate: new Date().toISOString(),
    transactions: state.transactions,
    debts: state.debts,
    budgets: state.budgets,
    categories: state.categories
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: 'salary_backup_' + localDateStamp() + '.json' });
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('Backup exported');
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

  if (!confirm(
    'Replace everything in this browser with the contents of "' + file.name + '"?\n\n' +
    'Incoming: ' + nTx + ' transaction(s), ' + nDebt + ' udhaar entr(y/ies), ' +
    Object.keys(incoming.budgets).length + ' budget(s), ' + incoming.categories.length + ' categor(y/ies).\n\n' +
    'Current: ' + state.transactions.length + ' transaction(s), ' + state.debts.length + ' udhaar entr(y/ies).\n\n' +
    'This cannot be undone.'
  )) return;

  state = incoming;
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

  const parts = [];
  if (u.receive > 0) parts.push(formatMoney(u.receive, { signed: true }) + ' owed to you');
  if (u.pay > 0) parts.push(formatMoney(-u.pay) + ' you owe');
  mount($('udhaarLine'), parts.length
    ? h('span', { class: 'udhaar-line' }, 'Udhaar: ' + parts.join('  ·  ') + '   Net ' + formatMoney(u.net, { signed: true }))
    : h('span', { class: 'udhaar-line muted' }, 'No outstanding udhaar'));
}

function renderBudgets() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthSpend = spendByCategory(start, endOfToday());

  const cats = Object.keys(state.budgets);
  if (!cats.length) {
    mount($('budgetList'), h('div', { class: 'empty-state' }, 'No budgets set yet'));
    return;
  }

  mount($('budgetList'), cats.map((cat) => {
    const limit = state.budgets[cat];
    const spent = monthSpend.get(cat) || 0;
    const pct = limit > 0 ? (spent / limit) * 100 : 0;
    const over = spent > limit;
    const level = pct >= 100 ? 'over' : pct >= 70 ? 'warn' : 'ok';

    return h('div', { class: 'budget-item' },
      h('div', { class: 'budget-header' },
        h('span', {}, cat),
        h('span', { class: 'budget-spent' },
          formatMoney(spent) + ' / ' + formatMoney(limit),
          '  (' + Math.round(pct) + '%)')
      ),
      h('div', {
        class: 'progress-bar',
        role: 'progressbar',
        'aria-valuenow': String(Math.round(pct)),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': cat + ' monthly budget'
      }, h('div', { class: 'progress-fill ' + level, style: 'width:' + Math.min(100, pct) + '%' })),
      over
        ? h('div', { class: 'budget-over' }, 'Over budget by ' + formatMoney(spent - limit))
        : h('div', { class: 'budget-left' }, formatMoney(limit - spent) + ' left this month'),
      h('button', { type: 'button', class: 'budget-remove', 'data-act': 'budget-delete', 'data-arg': cat, 'aria-label': 'Remove budget for ' + cat }, 'Remove budget')
    );
  }));
}

function renderTransactions() {
  const input = $('txSearch');
  const search = String((input && input.value) || '').trim().toLowerCase();
  const list = $('txList');

  let rows = state.transactions.slice().sort((a, b) => new Date(b.date) - new Date(a.date));

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
      t.source ? h('div', { class: 'tx-detail tx-linked' }, 'linked to an udhaar entry') : null,
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
  const byDateDesc = (a, b) => new Date(b.date) - new Date(a.date);
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
          h('span', { class: 'category-count' }, (counts.get(cat.toLowerCase()) || 0) + ' transaction(s)')
        ),
        iconButton('✕', 'category-delete', { arg: cat, title: 'Delete category ' + cat })
      )
    ));
  }
  refreshSelects();
}

function showReport(period) {
  reportPeriod = period;
  renderReport();
}

function renderReport() {
  const out = $('reportOutput');
  if (!reportPeriod) { mount(out); return; }

  const { start, end, label } = periodBounds(reportPeriod);
  const totals = ledgerTotals(start, end);
  const byCat = spendByCategory(start, end);
  const ranked = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1]);
  const count = state.transactions.filter((t) => {
    const d = new Date(t.date);
    return (!start || d >= start) && (!end || d <= end);
  }).length;

  const section = h('div', { class: 'report-section' },
    h('div', { class: 'report-period' }, label + ' · ' + count + ' transaction(s)'),
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

function renderAll() {
  renderBalance();
  renderBudgets();
  renderTransactions();
  renderDebts();
  renderCategories();
  renderReport();   // keep the report in step with the data
  $('storageWarning').hidden = storageUsable;
}

/* ============================================================
   Events
   ============================================================ */

const ACTIONS = {
  'tx-edit': (el) => openEditModal(el.dataset.id),
  'tx-delete': (el) => deleteTransaction(el.dataset.id),
  'debt-settle': (el) => settleDebt(el.dataset.id),
  'debt-edit': (el) => openDebtEditModal(el.dataset.id),
  'debt-delete': (el) => deleteDebt(el.dataset.id),
  'category-delete': (el) => removeCategory(el.dataset.arg),
  'budget-delete': (el) => removeBudget(el.dataset.arg),
  'report': (el) => showReport(el.dataset.arg),
  'export': exportBackup,
  'import': importBackup,
  'reset': resetAll,
  'close-modal': (el) => closeModal(el.dataset.target)
};

function wireEvents() {
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

  // forms give us Enter-to-submit for free
  const forms = [
    ['txForm', addTransaction],
    ['budgetForm', setBudget],
    ['debtForm', addDebt],
    ['categoryForm', (e) => addCategory($('newCategoryName'))],
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
}

/* ============================================================
   Boot
   ============================================================ */

function init() {
  const loaded = loadState();
  state = loaded.state;

  wireEvents();
  renderAll();

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
