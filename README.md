# VenueList

A guest list and door check-in web app for live music venues.

- **One venue account.** Staff, managers and door crew all log in with the same venue password. There are no individual user accounts.
- **Name per device.** The first time someone opens the app on a device, it asks for their name (e.g. "Sam (Door 1)"). Every add, edit, check-in and check-out is logged against that name.
- **Event contributors.** Artists, tour managers and promoters get a private link for a show. They add their own guests straight onto the event's list, without an account. Each contributor can have an allocation (heads, including plus-ones), and all links lock at the event's cutoff time.
- **Door mode.** A big search box and big IN / OUT buttons for every guest. Partial check-in works for parties with plus-ones (e.g. 2 of 3 in), and people can check out and back in. Counters show who's inside, who has arrived, and how many VIPs are in. It syncs live across every door device.
- **VIP.** VIPs are highlighted gold at the door, and every door screen gets an alert when a VIP arrives.
- **Office tools.** Paste a list in straight from Excel or Sheets, export to CSV, view the full activity log, and archive old events.

## Running it

Requires **Node.js 22.5 or newer**. It has no npm dependencies, because it uses Node's built-in SQLite.

```bash
npm start            # http://localhost:3000
npm test             # API tests
```

On first visit you'll be asked to set the venue name and password, plus a one-time setup code that the server prints to its log on start. `GET /health` returns `{"ok": true}`.

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
- First-time setup needs the one-time code from the server log, so a stranger can't claim the venue first.
- All data lives in one SQLite file (`DB_FILE`). The app snapshots it nightly to `BACKUP_DIR`; copy those off the server too.

## How it works

| Who | Where | Login |
|---|---|---|
| Venue staff | `/` — events, guest lists, contributors, activity, settings | Venue password + device name |
| Door staff | `/#/door/<event>` — search, IN / OUT | Venue password + device name |
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
