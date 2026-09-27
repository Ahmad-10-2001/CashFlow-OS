# CashFlow OS

A personal money manager that works with no account, no network and no build step.
Open the page and it runs.

---

## What it does

Track where your money is, what came in, what went out, and who owes whom.

| Tab | What it is for |
|---|---|
| **Home** | Total balance, per-account boxes, and the add-transaction form |
| **Accounts** | Cash, NayaPay, Easypaisa and anything you add. Opening balances, rename, archive |
| **Records** | Every transaction, searchable, editable |
| **Budget** | Monthly spending limits per category, with an optional income offset |
| **Udhaar** | Money lent and borrowed, with settle tracking |
| **Amanat** | Money held for someone else — deliberately kept out of your balance |
| **Reports** | Donut and bar charts over any date range |
| **List** | Shopping list; tick items, then save them as one expense |
| **Categories** | Add or remove spending categories |
| **Backup** | Cloud sync, month archiving, and JSON export/import |

---

## Design decisions worth knowing

### Money never sits in only one place

Your balance is **always the sum of the account boxes** shown on the Home screen.
The headline figure is computed from those boxes rather than separately, so the
two can never drift apart.

Moving money between your own accounts — Cash to NayaPay, say — is recorded as a
**transfer**, which is deliberately excluded from income, from expenses, and from
category budgets. Treating a transfer as income would inflate your income figure
and burn your Food budget for no reason. This is the single easiest mistake in
this kind of app, so it is excluded in the calculation and covered by tests.

### Amanat is not yours

Money you gave a relative to keep, or that someone left with you, is tracked in
its own collection and **never touches the balance**. It cannot inflate your
total even by accident, because the balance calculation only ever reads
transactions. Partial returns are supported, because that is how it happens in
real life.

### Budgets belong to a month, not to the app

Each month keeps its own limits. Looking back at last month shows *last* month's
limit, not whatever it happens to be today. Closing a month is non-destructive —
its budgets and reports stay readable and new entries flow to the new month.

### Local first, cloud second

Every edit is written to `localStorage` immediately. The app never waits on the
network, so it behaves identically with the aeroplane mode on. The cloud copy is
a background nicety, and signing in is entirely optional.

### Storage key, not display name

The app was renamed from *Salary Manager* to *CashFlow OS*. The `localStorage` key
is **deliberately still** `salaryManager:state` — renaming it would orphan every
existing user's records. Nothing user-facing depends on the key, and there is a
test asserting it stays put. Backups written under either name are accepted on
import.

---

## Technology

Deliberately minimal. There is no framework, no bundler, and no `node_modules`.

| Layer | What it is | Why |
|---|---|---|
| Markup | Plain HTML5 | No build step; the page is the artifact |
| Logic | Vanilla ES2020, ~2,900 lines in `script.js` | Readable end to end, no toolchain to learn |
| Styling | Plain CSS with custom properties | Same reason |
| Charts | Hand-rolled SVG in `script.js` | No 200 KB chart library, stays offline-capable |
| Database | Supabase (Postgres) over plain REST via `fetch` | No 120 KB SDK, so the service worker precache stays small |
| Auth | Supabase Auth, email + PIN | Recovery by email, quick entry by PIN |
| Offline | Service worker + web app manifest | Installs as an app, opens with no network |
| PWA | `manifest.json`, maskable icons | Add to home screen |

**No `supabase-js`.** Supabase is reached with `fetch` against its REST and GoTrue
endpoints. That was a real decision: the SDK would have been roughly 120 KB that
the service worker then had to cache, in an app whose entire character is being
small and dependency-free. 

### A stale cache must never half-update the page

This one cost a real bug report, so it is worth writing down.

The service worker originally served app files **cache-first**
(stale-while-revalidate), which is the right default for assets. It is the wrong
default for `index.html`, `script.js` and `style.css` when they are *not*
content-hashed, and a deploy produced this: a fresh `index.html` next to an old
`script.js`. Both files were individually valid. Together they produced a page
with **no Amanat tab** and an **account dropdown that stayed empty** — because
the new markup expects a script that fills it, and the old script did not know
the field existed. Nothing in the app was wrong; the page was simply half
updated, with no clue why.

Two changes prevent it:

1. **The app's own files are network-first.** Fresh when online, cached copy
   only when offline. Other assets keep stale-while-revalidate, which really is
   instant for things like icons.
2. **A self-healing guard on every boot.** The HTML declares its build number
   and its tab list; the script declares the same. If they disagree, or if a tab
   has no panel, the app knows it is running against mismatched files. It then
   clears the caches, unregisters the service worker, shows *"Updating the app…
   this will reload once"*, and reloads. If the files still disagree after that
   — meaning the service worker was never the cause — it stops trying and runs
   anyway, rather than looping on a blank page.

**When you deploy, bump all three:** `appBuild` in `config.js`, the
`app-build` meta tag in `index.html`, and `CACHE_VERSION` in
`service-worker.js`. A test asserts the first two match, so they cannot drift.

### No innerHTML, anywhere

All DOM is built with `h()` and `hs()` (the SVG variant), which set `textContent`
and attributes — never markup. A category named `<img src=x onerror=...>` is
rendered as literal text. There is a test that injects hostile strings into a
category, a comment, a person name and a list item, then asserts zero elements
were created.

### Prototype-pollution guards

User-controlled map keys — category names, budget keys, account names — go into
null-prototype objects (`Object.create(null)`) and `Map`s. A category named
`__proto__` or `toString` is a real, harmless key and can never reach
`Object.prototype`.

---

## Data model

Everything lives under one `localStorage` key as a single JSON document, written
atomically. A single key means a write can never be observed half-finished.

```
version          4
transactions[]   id, type, amount, category, comment, date, accountId, toAccountId, source, updatedAt
debts[]          id, type, person, amount, note, date, settled, settledAt, ledger
custody[]        id, person, direction, amount, returned, note, date, returnedDate
accounts[]       id, name, kind, openingBalance, archived
shopping[]       id, name, qty, note, checked, createdAt, checkedAt, boughtTxId, cost
budgets          { "2026-09": { Food: 10000 } }      per month
categories[]     user-editable strings
settings         { budgetOffset: { Food: true }, lastAccountId }
closedPeriods[]  archived "YYYY-MM" months
```

### Schema history

| Version | Change | Migration |
|---|---|---|
| 1 | Four separate `localStorage` keys | Migrated into the single key |
| 2 | Added shopping list, per-category budget offset, month close | Read as flat `budgets`, re-filed into the current month |
| 3 | Dates changed from UTC ISO to local wall-clock stamps; budgets keyed by month | Rewritten as `YYYY-MM-DDTHH:mm`, preserving the exact instant |
| 4 | Accounts, transfers, Amanat | Old transactions had no `accountId`; they are filed under **Cash** and you are told |

`did you know the user is told` — a corrupted or repaired file produces a plain
toast naming what was changed, and the clean version is written straight back.

### Why dates are stored as text

Transactions store `"2026-09-26T14:35"` — the local wall-clock time the user
typed, with no timezone. A `timestamptz` would reinterpret it in the server's
zone and shift the value, which would put a 23:50 entry on the wrong day. Text
guarantees an exact round-trip. All date maths is done client-side.

---

## Cloud sync

Optional. Sign in under **Backup → Sync Across Devices** and your data starts
reaching the cloud. Sign out and everything keeps working locally.

### How it works

```
edit  →  localStorage  →  [background]  →  Supabase
         (instant)        (debounced)
```

- **Offline-first.** Nothing waits on the network.
- **Outbox.** A record is dirty when its `updatedAt` is newer than the last thing
  successfully pushed. After a successful push the cursor advances to the newest
  stamp actually sent — not to "now" — so an edit made *during* the request still
  looks dirty and goes out next round instead of being silently dropped.
- **Pull before push.** A local edit made against a stale view is never
  overwritten by a version it never saw.
- **Last-write-wins per record.** Each record carries a client-assigned
  `updatedAt`; the newer one wins. For one person across two or three devices
  this is the right trade. CRDTs would be a lot of machinery for a problem this
  app does not have.
- **Tombstones.** Deleting a record pushes `deleted = true` rather than removing
  the row, so a delete on one device cannot come back on another.
- **Monotonic clock.** If the device clock jumps backwards, an edit could land
  before the sync cursor and never be sent. Every stamp is therefore forced
  strictly greater than the previous one, so that cannot happen.
- **Change detection in one place.** `reconcile()` diffs the live state against a
  shadow of the last seen state. It is called from `save()`, the single point
  every mutation already passes through — so a new feature cannot forget to sync.
- **Pull first on a new device** fetches the full history, then merges.

### Honest limitation

If a device is offline, an edit **cannot** reach the server yet. It is queued and
retried, and the status line says so. No design makes an offline write arrive
immediately; anything that claims otherwise is not telling you the truth.

### When the cloud copy goes missing

The push cursor — "everything up to T is already uploaded" — lives in each
browser's `localStorage`, not on the server. That makes it a claim about the
server that nothing on the server can correct. Drop the tables, restore a
backup, or rebuild the database, and the app carries on believing it: every
record on the device is older than T, so it uploads nothing, and the status
line says **synced** throughout.

This is not detectable from inside the app, so it is a button rather than a
guess: **Backup → Cloud copy looks wrong? → Check and re-upload** asks the server
how many rows it actually holds, compares that with this device, and where the
server is short it forgets the cursor and re-sends. The device holding the data
wins, because it is the only copy that is demonstrably complete.

Press it after any deliberate change to the database, and whenever the cloud
feels wrong. It is safe to press when nothing is wrong — it reports "in step"
and uploads nothing.

### Auth: email + password

The password is sent over TLS and Supabase stores only a bcrypt hash, so the
plain value is never written down anywhere we control.

**The password must be at least 8 characters.** That is a floor, not a
suggestion. The publishable key is baked into the app and readable by anyone who
opens it, so the password is the only thing between an attacker and someone's
ledger. Rate limiting helps; length helps more.

The password is not trimmed, so a leading or trailing space is a real character
rather than something silently swallowed — trimming would change the password
without telling anyone.

Email is not decoration: it identifies the account, it is what Row Level
Security keys off, and it is the only way back in if the password is lost.
Several people can use one Supabase project; each sees only their own rows.

### Forgot password

`Backup → Forgot your password?` asks only for the email, sends a code, and only
then reveals the new-password fields. Two ways in, both ending in the same place:

- **Type the code.** Needs the *Magic Link* email template edited once in
  Supabase (**Authentication → Emails → Magic Link**) to include `{{ .Token }}`.
- **Click the link in the email.** No template change needed — Supabase puts the
  token in the URL fragment and the app reads it on the next load.

Either way the user ends up holding a short-lived *recovery token*, and only that
token can set a new password. It is kept deliberately separate from the session: a
recovery token can change the password and nothing else, so a leaked reset link
cannot read or write your ledger.

**The request answers the same way whether or not the address has an account.**
Echoing "no such user" would turn the form into a way to discover who is
registered. Only failures of the *project* are reported — rate limiting, and
"no email provider configured".

Two things to set up on the Supabase side, or the email never arrives:

1. **An email provider.** Supabase's built-in SMTP is rate-limited to a couple of
   messages per hour and only goes to team members. Add a real one (Resend,
   SendGrid, Mailjet all have free tiers) under **Authentication → Emails**.
2. **The redirect URL**, if you use the link path. Add your app's address to
   **Authentication → URL Configuration → Redirect URLs**, otherwise Supabase
   refuses to send.

### Security

- The **publishable** key (`sb_publishable_…`) is in `config.js` and is *designed*
  to be public. What protects the data is Row Level Security, not the key's
  secrecy.
- The **service_role / secret** key is never in the repository and must never be.
  It would grant full read/write on every row.
- Every table has RLS on, with policies of the form
  `using (auth.uid() = user_id) with check (auth.uid() = user_id)`. A test and a
  SQL verification query both confirm this.
- `anon` is granted no privileges at all, so an unauthenticated request cannot
  reach the tables.

---

## Security posture

| Concern | How it is handled |
|---|---|
| XSS | No `innerHTML`; DOM built with `textContent`; hostile input tested |
| CSRF | Not applicable — no cookies, token held in `localStorage` |
| Injection | No SQL is built by hand; all queries go through PostgREST parameters |
| Another user reading your data | RLS on every table, `auth.uid()` scoped |
| Secret key leaking | Never written to any file; a test asserts `config.js` has none |
| Storage quota | `QuotaExceededError` is reported, not swallowed; the write is declared failed |
| Corrupt data | Every load goes through `sanitizeState()`, which never throws |
| Prototype pollution | Null-prototype objects and `Map`s for user-controlled keys |
| Your email password | Never asked for, never stored, never transmitted. Transactions arrive by forwarding, which needs no secret from your mail account |
| The email webhook being called by a stranger | Shared secret in a header, compared in constant time, checked before any work; the request is rejected outright if no secret is configured |
| A forwarded email being filed twice | Each row carries the provider's message id behind a `unique (user_id, source_key)` constraint, so a re-delivery is a no-op |
| Bank email leaking into the database | The message body is not stored — it routinely contains the account number and balance. It is logged to the function's own logs instead, for debugging the parser |
| Learning who has an account | The password-reset form answers identically for a known and an unknown address |
| A reset link being used to read your data | The recovery token is stored apart from the session and can only change a password; it is discarded the moment the password is set, and scrubbed out of the URL |
| A reset link being replayed | The token is removed from the address bar on arrival, so a reload cannot re-present it |

---

## Files

```
index.html            the app: markup for every tab
style.css             all styling
script.js             application logic, SVG charts, rendering, stale-asset guard
sync.js               auth, outbox, pull/push, last-write-wins merge
config.js             Supabase URL, publishable key, and the build number
service-worker.js     offline cache
manifest.json         PWA metadata
db/schema.sql         tables, indexes, RLS policies, grants
db/email-schema.sql   optional: forwarding routes and the approval queue
supabase/functions/poll-emails/index.ts
                      optional: the webhook that parses forwarded bank emails
README.md             this file
```

`config.js` and `db/schema.sql` are the two files worth reading first if you are
picking this up.

The last two are optional. Without them the app works exactly as before; nothing
else depends on them.

---

## Setup

The app runs by opening `index.html`. For cloud sync:

1. Create a Supabase project.
2. In **SQL Editor → New query**, run `db/schema.sql` once. The last statement
   prints a verification table; every row must show `rls_enabled = true`.
3. In **Authentication → Sign In / Providers**, turn **Confirm email** off.
4. Put your project URL and publishable key in `config.js`.
5. Sign in from **Backup → Sync Across Devices**.

### Optional: automatic transactions from bank email

This is **off by default** and not needed for anything else in the app.

The app never asks for your email password. That is not a policy decision — an
earlier version collected one, base64-encoded it into a column, and the signed-in
user could read their own password back out. Forwarding needs no secret from
your mail account at all, so the credential path was removed rather than
hardened.

How it works instead: NayaPay emails are forwarded to an address you control; a
mail provider POSTs each message to a Supabase Edge Function with a shared
secret; the function parses amount, direction and date and writes one row to
`pending_transactions`; the app lists it under **Pending** and you approve it.
Nothing reaches your balance without your approval.

1. Run `db/email-schema.sql` once. It creates `email_routes` and
   `pending_transactions`, both with the same ownership policy as the rest.
2. Deploy the function: `supabase functions deploy poll-emails`.
3. Set its secret: `supabase secrets set WEBHOOK_SECRET=<long random string>`.
4. Point your mail provider's inbound route at the function URL, sending that
   secret in the `X-Webhook-Secret` header.
5. Add one row to `email_routes` linking the forwarding address to your user id.
6. In Gmail, forward NayaPay mail to that address (keep a copy).

**The amount and date patterns in the function are a starting point, not a
guarantee.** NayaPay's wording may not match. When that happens nothing is
written and nothing is lost — the failure is a silent no-op, and the raw message
is logged to the function's own logs so the pattern can be corrected against a
real sample. That is the safe direction to fail in, but it does mean "no pending
transactions" is ambiguous until you have seen one arrive.

---

## Testing

894 assertions across seven suites, all of which run without a browser or a
network. They are not in this repository; they live beside it, and are run with
`node <suite>` from that directory (the `.mjs` suites need `npm i jsdom`).

| Suite | Covers |
|---|---|
| `test.js` | Schema migration, balance arithmetic, transfer invariants, custody rules, chart maths, prototype-pollution guards |
| `markup-test.js` | Every referenced id exists, every `data-act` has a handler, accessibility attributes, the rename did not touch the storage key |
| `integration-test.mjs` | The real page in a real DOM: clicks, typing, form submits, and assertions on what a user would actually see — including corruption recovery and XSS |
| `sync-test.mjs` | Auth, token refresh, outbox, tombstones, last-write-wins merge, offline retry, backwards clock |
| `app-sync-test.mjs` | The seam between app and sync: two windows against a fake Supabase, checking that a sign-in uploads history, a second device receives it, an edit travels back, and a delete propagates |
| `stale-test.mjs` | The mismatched-file guard, replaying the reported bug in both directions and asserting no reload loop |
| `guards-test.mjs` | Structural rules that are cheap to break and expensive to find: no duplicate function declarations, no `innerHTML`, no email-password handling, every state collection initialised, sync stamps preserved, the three build markers agreeing, a bad row not wedging sync, the schema and webhook refusing what they should, and the reset flow not revealing who has an account |
| `e2e.mjs` | One pass through the whole app: every tab opened, sign in and out, a forgotten password recovered end to end, an email transaction approved, and the per-account boxes asserted to sum to the headline balance |

The last two exist because of specific defects that shipped. Each of their
assertions names the failure it prevents.

These tests are not decoration. They caught real bugs during development, among
them: a month picker that never fired, a settled udhaar leaving a phantom
transaction behind, budgets silently resetting to zero after a corrupt file,
records shuffling order between renders, a debounced push calling a function
that no longer existed, a device that received data but never wrote it to disk,
and — most usefully — the stale-cache mismatch above, which is now replayed as
a test so it cannot come back.

---

## Not built yet

Stated plainly so nothing here is mistaken for finished:

- **The email parser is unverified against a real NayaPay email.** The
  forwarding pipeline is built and tested, but the amount and date patterns are
  inferred, not confirmed against a live sample. Until one real message has been
  parsed successfully, treat automatic import as untested. Easypaisa is
  deliberately out of scope.
- **Real-time push.** Sync is on a one-minute timer plus on-focus. Live updates
  would need Supabase Realtime, which is more machinery than this needs yet.
- **Cloud backup history.** The database is the live copy; a corrupt row is not
  protected by a point-in-time snapshot. Export a JSON file for that.
