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
| Logic | Vanilla ES2020, ~4,400 lines in `script.js` | Readable end to end, no toolchain to learn |
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

`Backup → Forgot your password?` asks only for the email, then offers two ways
in, both ending in the same place.

- **Click the link in the email.** This is the main route and it needs nothing
  beyond the redirect URL. Supabase puts the token in the URL fragment and the
  app reads it on the next load, opening straight on the new-password fields.
- **Type the code.** A fallback, in a collapsed box. It needs the *Magic Link*
  email template edited once to include `{{ .Token }}`, and **Supabase will not
  let the template be edited until custom SMTP is configured** — the template
  fields are visibly disabled with a "Set up custom SMTP to edit templates"
  banner. So on a project still using the default SMTP there is no code in the
  email, and the link is the only way in.

Either way the user ends up holding a short-lived *recovery token*, and only that
token can set a new password. It is kept deliberately separate from the session: a
recovery token can change the password and nothing else, so a leaked reset link
cannot read or write your ledger.

**The link does not carry the email address.** Supabase's fragment is
`#access_token=…&expires_in=…&refresh_token=…&token_type=bearer&type=recovery` —
there is no `email` in it. The address is recovered from the token's own claims,
and failing that from the response to the password change. Without that, setting
the new password succeeded and the automatic sign-in that followed failed with
"Enter a valid email address", which is both wrong and alarming: the user had
just chosen a working password. The claim is read without verifying the
signature, which is deliberate and safe — it only prefills a field, every
request is still made with the token, and the server verifies that token on each
one. A forged claim changes nothing except which address appears in a box the
user can edit.

**The request answers the same way whether or not the address has an account.**
Echoing "no such user" would turn the form into a way to discover who is
registered. Only failures of the *project* are reported — rate limiting, and
"no email provider configured".

Two things to set up on the Supabase side, or the email never arrives:

1. **A forwarding page at the account root.** Supabase builds the reset link
   itself and decides where it points. With the project's Site URL, the redirect
   allow-list and the app all correct, it still sent links to
   `https://<user>.github.io/` — the account root — while the app is served from
   `https://<user>.github.io/CashFlow-OS/`. That is a step in Supabase's own
   service, and it is not something this app can correct from its own side.

   The fix is to stop relying on it: GitHub serves a repository named
   `<user>.github.io` at exactly that root, so a one-file page there forwards
   the visitor to the app, **carrying the URL fragment across**. `#
   access_token=…` is never sent to a server, which is precisely why this cannot
   be done with a server redirect — and why a valid token arriving at a dead
   address is so confusing: the page 404s, the one-time token dies with the
   click, and the next attempt reports it expired.

   The file is [`site-root-redirect.html`](site-root-redirect.html) in this
   repository. Publish it as `index.html` in a repository named
   `Ahmad-10-2001.github.io`. Once that exists the link works whatever Supabase
   puts in it, and the app stops depending on the Site URL staying correct.

   **The name has to be exactly `index.html`.** Getting this wrong is quiet: the
   repository looks correct, Pages reports the site as live, and the root still
   404s, because there is no `index.html` for it to serve. A misspelling such as
   `index.httml` is enough.

   It forwards on `load` rather than on parse, so a link-preview scanner that
   fetches the page without running its script cannot spend the token before its
   owner opens it.

2. **The project's Site URL** and **Redirect URLs**, both the app's full address
   including its path:

   ```
   https://ahmad-10-2001.github.io/CashFlow-OS/
   ```

   Worth having right, but no longer the thing everything depends on.

   The request also states `type: 'recovery'`. Without it GoTrue defaults to
   `magiclink`, which is a sign-in link from the Magic Link template carrying a
   token scoped to opening a session rather than changing a password. It
   happened to work, which is the worst kind of fault: the right answer for the
   wrong reason, so nothing looked broken until something else was also wrong.

   **A link can only be used once.** Asking for a reset again deliberately
   invalidates the link already sitting in the inbox, and a mail scanner that
   opens links to check them can do the same. So a link reporting
   `otp_expired` is usually an older email, not a fault, and the app says so
   rather than "invalid or expired" — which sends people looking for a security
   problem that is not there, towards the one action that cannot work.
3. **An email provider**, for the email to be delivered at all. Supabase's
   built-in SMTP is rate-limited to a couple of messages per hour and only goes
   to team members — fine for one person's own address, not for more. A real one
   (Resend, SendGrid, Mailjet all have free tiers) goes under
   **Authentication → Emails**, and is also what unlocks editing the template so
   the code path works.

### Knowing which version you are looking at

A badge at the bottom of every tab reads `CashFlow OS` plus the running build number.

A service worker can serve a previous build after a deploy, so "I
deployed the fix and nothing happened" has an explanation that is invisible from
inside the page — the app looks identical either way. During development that was
the answer to more than one report, and the badge turns it into a glance.

Pressing it checks for a newer deploy: a `no-store` fetch of `index.html`, read
for the version marker and nothing else. It never touches your data, so it is
safe to run on every load, which it does — quietly, a second after start-up. A
newer build turns the badge amber and says which one. Each browser is told about
a new build once, not on every load.

### What an approved bank email becomes

Three things about it were wrong in ways that only showed up once a real payment
went through, and all three were claims about the money rather than the money:

- It said **"linked to an udhaar entry"**. There are three kinds of source and
  only one is an udhaar entry, so a two-way test labelled everything that was not
  a shopping list as one. A wrong claim about provenance sends someone looking
  for a record that does not exist, and hides the one thing that is true — this
  was read out of an email.
- Money arriving was filed under **"Salary"**. That is a claim that the money was
  earned, not a place to put it: someone being repaid Rs 50 was recorded as
  having earned a salary, and every budget grouped by category inherited the
  claim. Both directions now file under "Other", which is a bucket rather than
  an assertion, and the user can move it in one tap.
- The **time of day** was invented. A bank alert carries a calendar day and
  nothing else, so the 05:00 shown was midnight UTC rendered in Pakistan — and
  in New York the same value is 19:00 the *previous* day, which would file the
  payment on the wrong day. The function now anchors the parsed date at midday,
  which survives every timezone, and the app takes the time from the moment of
  approval rather than from the artefact. The pending list shows a day, not a
  clock reading, because the clock was never information that existed.

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
site-root-redirect.html
                      one-file forwarder published at the account root so
                      password-reset links land in the app, fragment and all
db/schema.sql         tables, indexes, RLS policies, grants
db/email-schema.sql   optional: forwarding routes and the approval queue
db/check-setup.sql    verification query covering every table
db/revoke-anon.sql    removes the anon role's default privileges
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

How it works: your bank's emails are forwarded to an address you control; a mail
provider POSTs each message to a Supabase Edge Function with a shared secret; the
function parses the amount, the direction and **the date from the message** and
writes one row to `pending_transactions`; the app lists it under **Pending** and
you approve it. Nothing reaches your balance without your approval.

#### Which provider, and why it is the only one

**AgentMail** (`agentmail.to`). Its free tier — 3 inboxes, 100 messages a day,
webhook endpoints — hands out `@agentmail.to` addresses with no domain to buy.

That matters more than the price. Every other provider that accepts mail and
posts it over HTTP — Mailgun, SendGrid Inbound Parse, Postmark — verifies a
domain before it will accept mail for it, and inbound routing runs on MX records,
which only exist for a domain you control. There is no free workaround. The
alternative, Google OAuth against the Gmail API, needs no domain but requires
authorising a Google app, and `gmail.readonly` is a restricted scope: an
unverified app in testing mode gets refresh tokens that expire after seven days,
and getting a verified one is a process measured in weeks. So AgentMail is not
simply the cheapest option here, it is the one that works at all.

#### Setting it up

1. Run `db/email-schema.sql` once. It creates `email_routes` and
   `pending_transactions`, both with the same ownership policy as the rest.
2. Set the function's shared secret, under **Edge Functions → Secrets**:
   ```
   WEBHOOK_SECRET = <a long random string>
   ```
   Without it the function refuses every request — that is deliberate, and the
   test in step 3 reports a missing secret instead of silence.

   Optional but recommended, as a second secret on the same screen:
   ```
   GEMINI_API_KEY = <a key from Google AI Studio, free tier is plenty>
   ```
   This enables the AI fallback described below. Without it the function uses
   the hand-written rules only, exactly as before — nothing else changes.
3. Open the **Email** tab, sign in, and press **Send a test transaction**. It
   posts a sample alert through the whole chain. When a row appears under
   **Pending**, everything is wired up.
4. Create an inbox at [agentmail.to](https://console.agentmail.to/sign-up?plan=free)
   and save its address in the app. The address is registered from the UI —
   previously this meant pasting SQL by hand, which is a step that looks optional
   and is not.
5. In the app, press **Copy webhook URL** and paste it into AgentMail under
   **Settings → Webhooks**, for the event `message.received`.
6. **Turn off "Verify JWT"** for the function: **Edge Functions → poll-emails →
   Settings**, and set *Verify JWT* to off.

   This is not optional and it is easy to miss. Supabase's gateway refuses a call
   to a function that carries no `Authorization` header *before the function's own
   code runs*, so with the setting left on, nothing from a mail provider can ever
   reach it — a third party has no Supabase login token to send. The app's own
   test calls carry the publishable key and get through, which makes it a
   particularly confusing failure: the test passes and the feature does not.

7. In Gmail, **Settings → Forwarding and POP/IMAP → Add a forwarding address**,
   and tick *Keep a copy* so nothing leaves your inbox.

The two credentials are separate and both are needed, which is easy to conflate:
the **apikey** gets past the gateway, and the **shared secret** proves the caller
is the mail provider. Neither replaces the other.

The webhook URL contains the shared secret, so it is kept in that browser only.
It is never written to the repository — the publishable key is already there for
everyone to read, and a secret beside it would be published with it.

#### Checking the deployment

`GET https://<project>.supabase.co/functions/v1/poll-emails` answers
`{"service":"poll-emails","ok":true,"secret_configured":true}`. It reveals
nothing else, and separates the two states that otherwise look identical from the
app: not deployed, and deployed with no secret set.

#### How the routing decides whose ledger a message belongs to

The recipient is matched against `email_routes`, tolerating the forms a provider
sends it in (`bank@x.com`, `<bank@x.com>`, `Bank <bank@x.com>`, or an array of
address objects). With **exactly one** active route it is used regardless — one
person, one address, and providers rewrite the recipient differently often
enough that a strict comparison would silently file nothing. With **two or
more**, an unrecognised recipient is refused rather than guessed: an earlier
version fell back to a single configured user, which meant a message forwarded
from any address at all would land in that one account's ledger. Someone else's
bank email must never reach someone's money records.

Register **both** addresses on an account: the AgentMail inbox *and* the Gmail
account. Gmail forwarding preserves the original To header, so the server sees
`you@gmail.com`, not the inbox — with only the inbox registered, nothing
matches and every message fails with a 422 the moment a second route exists
anywhere (with a single route the bypass hides this completely, which is why it
broke the day the second account was added, not the day forwarding was set up).

#### The parser, and the bug that would have made it silently useless

Bank alerts are written by marketers, and they do not agree on a word order. The
first version matched whole fixed sentences and dropped most real messages:
"payment of Rs. 900", "Rs. 250 received", "you received Rs. 5,000" with no
counterparty. It now works on the parts: a word saying which way the money moved,
the amount on either side of it, the date, and the counterparty as optional.

The subtler failure was in what the first version of that *refused*. It treated
more than one movement word as a summary and declined the message. But a bank
email states the same payment in the subject and again in the body —

```
NayaPay: You have sent Rs. 1,500 to Ali Khan on 27/09/2026
Dear customer, you have sent Rs. 1,500 to Ali Khan. Your balance is Rs. 8,500.
```

— which is one transaction said twice. So it rejected very nearly every real
alert, and the symptom was indistinguishable from a parser that does not
understand the bank at all. What is compared now is not how many times a word
appears but how many *distinct readings* the message gives: a repeat collapses to
one, while a message that really does describe two movements — an amount sent and
an amount received — is still refused.

**It has now seen real alerts**, which is worth recording because they broke it
in two ways that no amount of guessing would have found. A NayaPay message
arrives as

```
from:    NayaPay <no-reply@nayapay.com>
subject: You got Rs. 100 from Muhammad Ahmed 🎉 - Cha-Ching! Muhammad Ahmed easypaisa B...
```

and the bank's name is **only in the sender**. The "is this a bank email" check
read the subject and the body, found no bank in either, and dropped every
message — silently, and identically every time, so the feature looked broken
rather than misconfigured. The sender is now part of the text examined.

Second, and quieter: because the recipient has accounts at two wallets, the
subject names the *other* one. That one got past the check and was filed under
the wrong bank — a wrong balance rather than a missing one. The bank is now taken
from the sender first, which is the only place it is reliable.

The words themselves are as expected: `You sent Rs. X to <name>` and
`You got Rs. X from <name>`, both of which the verb-based parser reads. The date
is taken from the body, not the moment the message arrived.

When a pattern does not match, nothing is written and nothing is lost — the failure is a
silent no-op and the raw message is logged to the function's own logs so the
pattern can be corrected against a real sample. That is the safe direction to fail
in, but it does mean "no pending transactions" is ambiguous until you have seen
one arrive, which is what the self-test is for: it puts a sample message through
the same path and names the step that failed.

#### When the rules fail: one AI reading

Hand-written patterns end where a new bank's layout begins — every bank formats
its statements differently, and each new one used to mean a new pattern plus a
real sample to write it against. That loop never ends, so it is no longer the
only path.

When the rules cannot parse a message, the function asks Gemini Flash (or
whatever `GEMINI_MODEL` names) exactly one question, bounded to 200 output
tokens and 20 seconds: *is this one completed transaction, and if so, how much,
which way, who, when?* Anything else — marketing, OTP, bill reminder, a summary
of many transactions — is answered `{"confident": false}` and filed nowhere.

Three things keep this honest:

- **The answer is re-validated like any untrusted input.** Amount by the same
  `parseAmount` as the rules, direction by exact match, date by shape. Anything
  off is a null, which files nothing.
- **It costs nothing by default.** Rules run first and handle everything they
  understand; the AI is only asked about mail the rules failed on. Personal
  volume fits the free tier many times over.
- **The ledger is still human-approved.** An AI filing lands under **Pending**
  like any other, and the response says which engine filed it.

The tradeoff, stated plainly: the message text is sent to Google. The body is
never written to a table either way — but with the key set, it does leave the
project for the duration of one API call. Leave `GEMINI_API_KEY` unset and the
function is rules-only, with no third party involved at all.

#### Why the app sends no custom header

The app's two calls to the function put the apikey in the query string and send
the body as `text/plain`, which makes both "simple" by the browser's definition —
no custom header, no non-safelisted content type, therefore **no preflight at
all**.

That is not a substitute for declaring CORS headers, and the function does
declare a full set. It is so that a stale allowed-headers list, a cached
preflight, or a proxy in between cannot stop the one request a user relies on to
find out whether the feature works. Adding the apikey as a header had already
caused exactly that: a 401 became `Failed to fetch`, with no status code and
nothing in the function's logs, because the browser blocked the call without
sending it. The function reads its body with `json()` either way, so the content
type is only ever a label.

---

## Testing

1251 assertions across ten suites, all of which run without a browser or a
network. They are not in this repository; they live beside it, and are run with
`node <suite>` from that directory (the `.mjs` suites need `npm i jsdom`).

| Suite | Covers |
|---|---|
| `test.js` | Schema migration, balance arithmetic, transfer invariants, custody rules, chart maths, prototype-pollution guards |
| `markup-test.js` | Every referenced id exists, every `data-act` has a handler, accessibility attributes, the rename did not touch the storage key |
| `integration-test.mjs` | The real page in a real DOM: clicks, typing, form submits, and assertions on what a user would actually see — including corruption recovery and XSS |
| `sync-test.mjs` | Auth, password reset at the API level, token refresh, outbox, tombstones, last-write-wins merge, offline retry, backwards clock |
| `app-sync-test.mjs` | The seam between app and sync: two windows against a fake Supabase, checking that a sign-in uploads history, a second device receives it, an edit travels back, a delete propagates, and a cloud database wiped from under the app is detected and repaired |
| `stale-test.mjs` | The mismatched-file guard, replaying the reported bug in both directions and asserting no reload loop. Every line-ending assumption in it is written `\r?\n` rather than `\n`, because Git rewrites the working tree to CRLF on Windows and a test that assumes LF silently stops doctoring anything — the "old" file then equals the current one and the suite fails with no connection to the code it claims to test |
| `guards-test.mjs` | Structural rules that are cheap to break and expensive to find: no duplicate function declarations, no `innerHTML`, no email-password handling, every state collection initialised, sync stamps preserved, the three build markers agreeing, a bad row not wedging sync, the schema and webhook refusing what they should, the reset flow not revealing who has an account, and the email intake not losing its secret or being checked without one — both of which shipped and both of which were reported from a live setup as a configuration mistake |
| `reset-flow-test.mjs` | Forgot password driven through the UI step by step, including "Send it again" on a screen with no email field — which shipped broken — going Back without retyping, the whole emailed-link path including recovering the address from the token, and the root forwarding page run against a stub window |
| `parser-test.mjs` | The email parser against realistic phrasings, including the ones the first version silently dropped and the subject-repeats-the-body shape that would have made it reject nearly every real alert. Also the provider payload shapes. Runs the shipped TypeScript, with the type annotations stripped, so it tests the real code |
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

- **The email parser is verified against real NayaPay alerts** (`You sent Rs. X
  to <name>`, `You got Rs. X from <name>`), but other banks' wording is still
  inferred, not confirmed against live samples. Treat automatic import from any
  other bank as untested. New banks are added by name to the function — the
  amount/date parser itself is bank-agnostic.
- **Real-time push.** Sync is on a one-minute timer plus on-focus. Live updates
  would need Supabase Realtime, which is more machinery than this needs yet.
- **Cloud backup history.** The database is the live copy; a corrupt row is not
  protected by a point-in-time snapshot. Export a JSON file for that.
