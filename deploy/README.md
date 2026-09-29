# Deploying to guestlist.riderly.com.au

This follows the droplet's existing conventions. The app runs as `venue` in `/srv/guestlist` on `127.0.0.1:5070`, behind Caddy, and is deployed only by GitHub Actions on push to `main`.

**Don't touch:** ballroom (5052, live client), demo (5053), control/admin (5060), the landing page, or tullamarine (5051, frozen).

| | |
|---|---|
| Droplet | 134.199.157.198 |
| Folder | `/srv/guestlist` (owned by `venue`) |
| Port | `127.0.0.1:5070` only |
| Unit | `guestlist` (`deploy/guestlist.service`, `MemoryMax=300M`) |
| Health | `GET /health` → `{"ok": true}` |
| Data | `/srv/guestlist/data/venuelist.db` (git-ignored, `600`) |
| Backups | `/srv/guestlist/data/backups/`. The app writes one nightly and keeps 30 days. |

Measured memory: about 93 MB peak with 1,000 guests, 50 live door screens and 200 full reloads.

---

## 0. One-time: Node.js 22 (the other apps are Python)

Check first: `node --version`. If it prints **v22.5 or newer**, skip this step. Otherwise, as root:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
node --version && which node      # expect /usr/bin/node
```

This adds one system package and doesn't change any other app. If `which node` isn't `/usr/bin/node`, fix the `ExecStart` path in the unit. The app has **no npm dependencies**, so there's no `npm install` step, ever.

## 1. DNS (VentraIP), done by Will

In the `riderly.com.au` zone, add **one** record and change nothing else:

| Host | Type | Value | TTL |
|---|---|---|---|
| `guestlist` | A | `134.199.157.198` | 300 |

## 2. Wait for DNS

```bash
dig @ns1.nameserver.net.au +short guestlist.riderly.com.au A    # must print 134.199.157.198
```

Don't do step 5 until this works. Otherwise Let's Encrypt can refuse the certificate for about an hour.

## 3. Get the code (as `venue`, never root)

```bash
sudo -u venue mkdir -p /srv/guestlist
sudo -u venue git clone -b main https://github.com/Wntr2134/venuelist.git /srv/guestlist
```

If the repo is private, `venue` needs read access. Add a read-only deploy key: generate it with `sudo -u venue ssh-keygen -t ed25519 -f ~venue/.ssh/guestlist_repo -N ""`, add the `.pub` in GitHub → repo → Settings → Deploy keys, and clone via `git@github.com:Wntr2134/venuelist.git` with `GIT_SSH_COMMAND='ssh -i ~venue/.ssh/guestlist_repo'`. Then set the same key in `~venue/.ssh/config` for `github.com` so deploys can fetch.

## 4. Service

```bash
sudo cp /srv/guestlist/deploy/guestlist.service /etc/systemd/system/guestlist.service
sudo systemctl daemon-reload && sudo systemctl enable --now guestlist
curl -s http://127.0.0.1:5070/health                           # {"ok":true}
sudo journalctl -u guestlist --no-pager | grep "setup code"    # note the code
```

**One-time setup code.** Until a venue password exists, the setup screen asks for a code. The app prints that code in its log (above). This stops a random visitor from claiming the venue before you do. The code changes on every restart until setup is done, and after that it's gone for good.

## 5. Caddy: append at the very end, edit nothing above

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-guestlist
cat /srv/guestlist/deploy/Caddyfile.snippet | sudo tee -a /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

The block includes `bind 134.199.157.198` like every other site on this droplet. Tailscale holds `:443` on the tailnet IP, so a block without `bind` makes the reload fail with `address already in use`.

About `read_timeout 60s`: live door sync holds a connection open, but the app sends a keep-alive every 25 seconds, so it stays inside the timeout. Caddy passes the live stream through without buffering by default.

## 6. Check the new app and that the others still answer

```bash
curl -s https://guestlist.riderly.com.au/health
curl -s https://ballroom.riderly.com.au/health
curl -s https://demo.riderly.com.au/health
curl -s https://admin.riderly.com.au/health
```

If anything is wrong, roll Caddy back:

```bash
sudo cp /etc/caddy/Caddyfile.bak-guestlist /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Then open **https://guestlist.riderly.com.au**, enter the setup code, and set the venue name and password.

## 7. Deploys through GitHub Actions, set up by Will

`.github/workflows/deploy.yml` runs on every push to `main`. It runs the tests, then SSHes in as `venue`, runs `git fetch` and `git reset --hard origin/main` in `/srv/guestlist`, restarts **only** `guestlist`, and waits for `/health`. The `data/` folder is git-ignored, so resets never touch the database.

Add these to the repo's **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | `134.199.157.198` |
| `DEPLOY_SSH_KEY` | Private key for a key listed in `venue`'s `~/.ssh/authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | *(recommended)* output of `ssh-keyscan 134.199.157.198`. If it's missing, the workflow trusts whatever host key it sees on first connect. |

Let `venue` restart this unit and nothing else. Run `sudo visudo` and add `/bin/systemctl restart guestlist` to `venue`'s existing command list. For example:

```
venue ALL=(root) NOPASSWD: /bin/systemctl restart ballroom, ..., /bin/systemctl restart guestlist
```

If the other repos use different secret names, rename them in `deploy.yml` to match.

## Personal data

- Guest names and notes stay in the SQLite file on the droplet and nowhere else. Every page and API route needs the venue login, except `/health` (reveals nothing) and each contributor's private link, which shows only that contributor's own guests.
- Pages send `noindex`, so search engines won't index them.
- The app has no secrets in git or in files. The venue password is stored hashed in the database, and the session key is generated there too.
- **Backups are on the same droplet**, which doesn't protect you if the droplet itself is lost. Turn on DigitalOcean droplet backups, or periodically copy `/srv/guestlist/data/backups/` somewhere else.
- **Restore:**
  ```bash
  sudo systemctl stop guestlist
  sudo -u venue cp data/backups/venuelist-YYYY-MM-DD.db data/venuelist.db
  sudo systemctl start guestlist
  ```
  Run it from `/srv/guestlist`. Also delete `data/venuelist.db-wal` and `data/venuelist.db-shm` if they exist.
