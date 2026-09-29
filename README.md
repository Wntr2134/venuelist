# Riderly Guest List

A multi-venue guest list and door check-in web app for live music venues.

- **Landing page** (`/`) explains the product and has a **Request access** form. Requests land in the owner dashboard.
- **Owner dashboard** (`/admin`): add a venue, get a one-time setup link (with a ready-to-send message), see each venue's status and counts, and reset, disable or delete venues. The owner never sees guest names.
- **Venue setup** (`/setup/<token>`): the venue manager opens the link and picks the venue password. It works once and expires after 7 days.
- **One login per venue.** Staff open the venue's link (`/v/<venue-id>`), type the shared password, and put their own name on the device. Every change is logged against that name.
- **Contributor links** for artists, tour managers and promoters (`/c/<token>`), with allocations and cutoffs.
- **Door mode:** IN/OUT per guest, partial plus-ones, re-entry, walk-ups, and live sync across devices.
- **VIPs** are highlighted gold, with an alert on every door screen when one arrives.
- **Guide** at `/guide`: the user manual for managers, door staff and contributors.
- **Venues are fully isolated.** An ID from another venue is simply "not found".

## Running it

Requires **Node.js 22.5 or newer**. It has no npm dependencies, because it uses Node's built-in SQLite.

```bash
npm start            # http://localhost:3000
npm test             # API tests
```

On first start the server prints an **owner setup code** to its log. Open `/admin`, enter the code, and set the owner password. Then add venues from there. `GET /health` returns `{"ok": true}`.

Upgrading from the single-venue version is automatic: the old venue becomes the first venue, with the same password and all its events.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` only inside Docker) |
| `DB_FILE` | `./data/venuelist.db` | SQLite database file |
| `BACKUP_DIR` | `<db folder>/backups` | Nightly snapshots written by the app |
| `BACKUP_KEEP_DAYS` | `30` | How long snapshots are kept |
| `SECURE_COOKIES` | unset | Set to `1` when served over HTTPS (recommended in production) |
| `TRUST_PROXY` | unset | Set to `1` behind nginx/Caddy so login rate-limiting uses the real client IP |

### DigitalOcean droplet (production)

See **[deploy/README.md](deploy/README.md)**: `guestlist.riderly.com.au` on the Riderly droplet, behind Caddy, deployed by GitHub Actions on push to `main`.

### Docker

```bash
docker build -t venuelist .
docker run -d -p 3000:3000 -v venuelist-data:/data -e SECURE_COOKIES=1 -e TRUST_PROXY=1 venuelist
```

### Hosting notes

- Put it behind HTTPS (e.g. Caddy, nginx, Cloudflare, or your host's proxy). Contributor links and the venue password travel over the network.
- Live sync uses Server-Sent Events on `/api/events/:id/stream`. If you use nginx, disable buffering for that path (the app already sends `X-Accel-Buffering: no`). Door screens also re-sync every 30 seconds as a fallback.
- Claiming `/admin` needs the one-time code from the server log, so a stranger can't take the owner account.
- Login rate-limiting counts only wrong passwords, so a whole venue on one Wi-Fi never locks itself out.
- All data lives in one SQLite file (`DB_FILE`). The app snapshots it nightly to `BACKUP_DIR`; copy those off the server too.

## How it works

| Who | Where | Login |
|---|---|---|
| Public | `/` landing + request access, `/guide` manual | None |
| Owner (Riderly) | `/admin` — venues, setup links, access requests | Owner password |
| Venue manager | `/setup/<token>` once, then `/app` | Setup link, then venue password |
| Venue staff | `/v/<venue-id>` → `/app` (events, lists, contributors, door mode, settings) | Venue password + device name |
| Contributors | `/c/<token>` — add, edit or remove their own guests | Private link + device name |

Rules the server enforces:
- Contributors can only see and change their own guests, only up to their allocation, and only before the cutoff while their link is enabled.
- A guest who has already arrived can't be removed or edited by a contributor, and the venue can't reduce their party size below the number already admitted.
- The venue can override allocations and the event cap. The app asks for confirmation first.
- "New link" invalidates a contributor's old link immediately.
- Changing the venue password logs out every other device.

## Project layout

```
server.js           entry point
src/app.js          HTTP API, routing, live updates
src/db.js           SQLite schema
src/auth.js         password hashing, signed session cookie
public/             front end (vanilla JS, no build step)
test/               node:test API tests
```

## Not built yet

- Moshtix integration (e.g. combining ticket scans and guest list into one capacity count)
- Offline door mode (queue check-ins while the Wi-Fi is down)
- QR codes / confirmation emails to guests
- SMS alerts for VIP arrivals
