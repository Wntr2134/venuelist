# Riderly Guest List

Guest list and door app for live music venues, at https://guestlist.riderly.com.au. A side
product of Riderly (riderly.com.au, the venue manager, "VMT"). Owner: Will.

New to this repo, or asked to get caught up? Read `docs/onboarding.md` first.

## How work gets in
- Work on a branch, open a pull request into `main`. Never push to `main` directly. Every merge to
  `main` deploys to production automatically (GitHub Actions).
- Who merges: sessions working under Will's own GitHub account (Wntr2134) may merge their own pull
  request once its `test` check is green, then tell Will it's live. Everyone else's pull requests
  wait for Will's review and approval (GitHub enforces this: only the repo admin can bypass).
- Pull requests run the tests (`.github/workflows/test.yml`). Keep them green.
- Never deploy by hand, never SSH to the droplet, never read or ask for the deploy secrets.

## Stack
- Node.js 22, no npm dependencies: built-in `node:sqlite`, `node:http`, `node:crypto`.
- `server.js` boots `src/app.js` (all routes). `src/db.js` schema + migrations (additive only:
  `ALTER TABLE ... ADD COLUMN`, `CREATE ... IF NOT EXISTS`; never drop or rename).
- Front end: plain JS in `public/js` using the `h()` / `put()` helpers in `common.js`. The CSP
  forbids inline `<script>` and `style="..."` attributes in HTML (use classes; `el.style` is fine).
- Styles: `public/css/styles.css`, Riderly palette (`--accent` amber, `--in` green, `--gold` VIP).

## Before you open a PR
1. `npm test` — all pass. Add a test for anything new (`test/api.test.js` style).
2. `node --disable-warning=ExperimentalWarning scripts/check-layout.js` (needs Playwright) —
   checks every page at phone, iPad and desktop sizes. 0 problems, and look at the screenshots.
3. Phones and iPads matter most: door staff use phones; touch targets 44px, text fields 16px,
   nothing scrolls sideways. iPads in portrait get the phone layout.

## New features ship switched off
- Anything that changes how the app behaves for venues (new screens, new buttons, changed rules)
  goes behind a feature flag: add an entry to `src/features.js` (key, name, plain-English `what`,
  `added` date) in the same PR, and guard the new behaviour with `feature(venue, KEY)` on the server
  and `hasFeature(KEY)` in `public/js/app.js`. Venues only get it when Will switches it on in /admin
  (per venue, Early access, or everyone). A test fails if code checks a key that isn't listed.
- Bug fixes, security fixes and wording tweaks don't need a flag.

## Rules that don't bend
- Guest lists are personal information. No guest names in logs, emails to Riderly, the Riderly
  API (`/api/v1`), analytics or third parties. The banned list is venue-admin only, except that venues with the `banned-photos` feature let door
  staff see a matching entry's photo and a logged gallery of photos. Staff compare faces by eye: never add
  automatic face matching (biometric data under the Privacy Act).
- Secrets never go in git (`mail.json`, `backup.json` are git-ignored on the server).
- Times shown to people are Melbourne time; a venue's "day" rolls over at 6am.
- Plain Australian English in the UI. No model names in commits or code.
- `docs/riderly-api.md` is the contract with the VMT. Don't break it; add to it.
