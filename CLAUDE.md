# Riderly Guest List

Guest list and door app for live music venues, at https://guestlist.riderly.com.au. A side
product of Riderly (riderly.com.au, the venue manager, "VMT"). Owner: Will.

## How work gets in
- Work on a branch, open a pull request into `main`. Never push to `main`: only Will merges,
  and every merge to `main` deploys to production automatically (GitHub Actions).
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

## Rules that don't bend
- Guest lists are personal information. No guest names in logs, emails to Riderly, the Riderly
  API (`/api/v1`), analytics or third parties. The banned list is venue-admin only.
- Secrets never go in git (`mail.json`, `backup.json` are git-ignored on the server).
- Times shown to people are Melbourne time; a venue's "day" rolls over at 6am.
- Plain Australian English in the UI. No model names in commits or code.
- `docs/riderly-api.md` is the contract with the VMT. Don't break it; add to it.
