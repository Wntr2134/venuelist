# Onboarding: getting a new collaborator's session up to speed

If you're a Claude Code session that's been asked to "get caught up" on this repo: read this file
and `CLAUDE.md`, run the checks under **Your first steps**, then give the person a short plain-English
summary (what the app is, how work gets in, what's off limits, what state it's in) and ask Will what
to work on first. Don't change any code until you've been given a task.

## What it is

Riderly Guest List is a guest list and door app for live music venues, live at
https://guestlist.riderly.com.au. Owner: Will. It's a paid add-on to Riderly's venue manager (the
"VMT", a separate repo you don't have access to). Real venues use it on show nights, so treat `main`
as production.

What it does today:
- **Shows and guest lists.** Staff add guests, plus-ones, VIPs, list types and notes. Contributor
  links let artists, tour managers and promoters add their own guests up to an allocation.
- **Door mode.** Search and check in or out, a shared door clicker (capacity, peak, in and out),
  a big-screen count, and taps that queue while offline and sync once.
- **Manager codes.** Breaking a rule (over capacity or allocation) or changing one needs a named
  manager's code. Every override is logged.
- **Venue admin** (`/v/<venue>/admin`). Manager codes, the staff password, venue defaults,
  privacy and retention, the banned list (venue-admin only), and the Riderly connection.
- **Reports.** A night report per show (door versus tickets versus guest list), a comps report
  across shows, and CSV export.
- **VIP alerts** to managers' phones by web push. The push is empty, so no names pass through
  push services.
- **Riderly API** (`/api/v1`, see `docs/riderly-api.md`). The VMT pushes shows in and reads totals
  back, never guest names. It also issues one-click sign-in links.
- **Owner admin** (`/admin`, Will only). Applications and approvals, venues, billing tracking,
  email and backup status.
- **Try the demo.** A throwaway sandbox venue, deleted after 3 hours.
- **Retention.** Guest names are purged a set number of days after each show. Counts stay.
- **Backups.** A nightly local snapshot, plus an encrypted copy off the server.

## How work gets in

GitHub enforces this, not just convention.

- Work on your own branch and open a pull request into `main`. `main` is protected: no direct
  pushes, and a PR needs Will's approval and a green `test` check.
- Every merge to `main` deploys to production automatically. Your pull requests wait for Will's
  approval; only sessions running under Will's own account merge their own.
- Never SSH to the server, deploy by hand, or read or ask for any secrets or keys. You don't have
  them and don't need them.
- Keep PRs small, one change each. Write the description in plain English for Will: what changed,
  why, and how you tested it. Add screenshots if it touches a page.
- Before starting, check the open PRs (https://github.com/Wntr2134/venuelist/pulls) so you don't
  overlap with work in progress. Will's own session owns the **ops status** endpoint and the
  "Admin console connection" card in `/admin`, both part of his suite health monitor. Leave
  those alone unless Will says otherwise.

## Stack and where things live

- **Runtime.** Node 22, no npm dependencies: built-in `node:sqlite`, `node:http` and
  `node:crypto`. Don't add packages without asking Will. CI runs `npm audit`.
- **`server.js`** boots **`src/app.js`**, which holds all routes. Each route is declared as
  `route(method, regex, handler, { auth })`, where `auth` is `'venue'` (the default), `'owner'`,
  `'vadmin'`, `'api'` or `'public'`.
- **`src/db.js`**: schema and migrations. Additive only (`ADD COLUMN`,
  `CREATE ... IF NOT EXISTS`); never drop or rename.
- **`src/auth.js`**: signed session cookies (`__Host-` prefixed over HTTPS) and login rate limits.
- **Other modules.** `mail.js` (SMTP), `backup.js` and `offsite.js` (encrypted backups),
  `demo.js`, `banned.js`, `push.js`.
- **Front end.** Plain JS in `public/js`, using the `h()` and `put()` helpers in `common.js`. The
  CSP forbids inline `<script>` and `style=""` attributes, so use classes. Styles live in
  `public/css/styles.css` (the Riderly palette).
- **`docs/riderly-api.md`** is the contract with the VMT. Don't break it; only add to it.
- **Tests** live in `test/api.test.js`. Each test starts the app in-process and calls it like a
  browser would.

## New features ship switched off

Will chooses which venues get anything new. Every new feature gets an entry in `src/features.js`
(key, name, plain-English `what`, `added` date) in the same PR as the code, and the new behaviour
is guarded with `feature(venue, KEY)` on the server and `hasFeature(KEY)` in the venue app. It's
off for every venue until Will switches it on in /admin: per venue, for venues with Early access
(the Toff has this, so it sees new things first), or for everyone. A test fails if code checks a
feature that isn't listed. Bug fixes, security fixes and wording tweaks don't need a flag.

## Testing: never on a real venue's guest list

Try things on your local copy (`npm run dev`), the **Try the demo** sandbox (made-up guests,
deleted after 3 hours), or **Riderly Test Room** on the live site if you need the Riderly sync.
Never use a real venue's guests, the Toff's included, to test or demo changes.

## Security rules already built in (keep them true)

- **Guest names are personal information.** Never put them in logs, emails to Riderly, the Riderly
  API, analytics or third parties. The banned list is venue-admin only, except that venues with the `banned-photos` feature let door
  staff see a matching entry's photo and a logged gallery. Never add automatic face matching.
- **Every mutation must be `Content-Type: application/json`.** This is a cross-site request guard.
- **Every new route must declare the right `auth`.** A test enumerates every route and fails if a
  non-public one answers an anonymous caller.
- **Retention covers every name.** If you add a new place that stores guest names, include it in
  the purge (`purgeExpired` in `src/app.js`) and in guest deletion.
- **Revocation covers every session.** Logging out, a password change or a disabled venue cuts
  live streams and cached data. If you add a new kind of session or stream, make sure revoking
  access ends it too.

## Before you open any PR

1. Run `npm test`. Everything must pass. Add a test for anything new.
2. Run `node --disable-warning=ExperimentalWarning scripts/check-layout.js` (needs Playwright). It
   checks every page at phone, iPad and desktop sizes. You want 0 problems; look at the
   screenshots too. It takes a few minutes.
3. Phones and iPads matter most, because door staff use phones:
   - touch targets 44px or larger;
   - text fields 16px;
   - nothing scrolls sideways;
   - iPads in portrait get the phone layout.

## Style

- Plain Australian English in the UI.
- Times shown to people are Melbourne time. A venue's "day" rolls over at 6am.
- No AI model names in commits or code.

## Your first steps

1. Read `CLAUDE.md`, then skim `src/app.js` and `test/api.test.js`.
2. Run `npm test` and confirm it's green. Run the layout check if Playwright is available.
3. To see the app, run `npm run dev`, then use **Try the demo** on the home page. It gives you a
   sandbox venue full of made-up guests.
4. Give the person a short summary of the above, then ask Will what to work on first.
