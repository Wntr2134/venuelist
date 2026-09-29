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
| Backups | `/srv/guestlist/data/backups/`. The app writes one nightly and keeps 30 days. With `backup.json`, an encrypted copy also goes to DigitalOcean Spaces (syd1). |

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

## Email (optional)

Email turns on sign-up alerts, "you're live" emails to venues, and "Forgot password?" links. It uses a Gmail **app password** (not your normal Gmail password).

1. On the Google account: turn on 2-Step Verification, then go to https://myaccount.google.com/apppasswords, create one called "Riderly Guest List", and copy the 16 letters.
2. On the droplet:
   ```bash
   sudo -u venue nano /srv/guestlist/mail.json
   ```
   Paste this in, with your details and the app password:
   ```json
   { "host": "smtp.gmail.com", "port": 465, "user": "wpmixing@gmail.com", "pass": "abcd efgh ijkl mnop",
     "from": "Riderly Guest List <wpmixing@gmail.com>", "notify": "wpmixing@gmail.com" }
   ```
   Save with Ctrl+O, Enter, then Ctrl+X.
3. Lock the file down: `sudo chmod 600 /srv/guestlist/mail.json`
4. In /admin, press **Send a test email**. You don't need to restart anything.

`mail.json` is git-ignored, so deploys never touch it.

## Off-site backups (DigitalOcean Spaces)

Every night the app encrypts a copy of the database (AES-256, with a passphrase only you know) and uploads it to a private Space in Sydney. It keeps one copy per weekday (`daily-mon.vlb` and so on, overwritten each week) plus one per month (`monthly-10.vlb` for October, overwritten the next October). So nothing off-site is older than a year. If an upload fails, it retries every hour and emails you (when email is set up). The Backups card in /admin shows the last good copy.

1. DigitalOcean → **Spaces Object Storage** → **Create a Space**. Region **Sydney (SYD1)**, name `riderly-backups`, **File listing: Restricted**. (Spaces is about US$5 a month.)
2. DigitalOcean → **Spaces Object Storage** → **Access Keys** → **Create Access Key**. Choose **Limited access**, pick `riderly-backups`, **Read/Write/Delete**. Copy the Access Key and the Secret (the secret is shown only once).
3. Make a passphrase: four or five random words. **Save it in your password manager now.** Without it the backups can't be opened, and it is not stored anywhere off the droplet.
4. On the droplet:
   ```bash
   sudo -u venue nano /srv/guestlist/backup.json
   ```
   ```json
   { "endpoint": "syd1.digitaloceanspaces.com", "region": "syd1", "bucket": "riderly-backups",
     "key": "DO00…", "secret": "…", "passphrase": "your four random words", "prefix": "guestlist/" }
   ```
   Then `sudo chmod 600 /srv/guestlist/backup.json`.
5. In /admin, press **Back up now** on the Backups card. It should say "Backed up and uploaded to Spaces". No restart needed.

`backup.json` is git-ignored, so deploys never touch it.

**Restore from Spaces:** download the `.vlb` file from the Space in the DigitalOcean website, copy it to the droplet (or any computer with Node 22 and this code), then:

```bash
node scripts/decrypt-backup.js daily-mon.vlb restored.db
```

It reads the passphrase from `backup.json` if it's there, otherwise it asks. Then restore `restored.db` as shown under **Personal data** below.

## Forgot the owner (/admin) password?

On the droplet:

```bash
sudo -u venue node --disable-warning=ExperimentalWarning /srv/guestlist/scripts/reset-owner-password.js
```

This prints a new random owner password and logs out every other /admin session. Log in with it, then change it under **Owner password**. Venues and their data aren't touched.

## Personal data

- Guest names and notes live in the SQLite file on the droplet. If off-site backups are on, an encrypted copy also sits in your private Space in Sydney; it can't be read without the passphrase. Every page and API route needs the venue login, except `/health` (reveals nothing) and each contributor's private link, which shows only that contributor's own guests.
- Pages send `noindex`, so search engines won't index them.
- No secrets are in git. Venue passwords are stored hashed in the database, and the session key is generated there too. `mail.json` and `backup.json` hold the only secrets, `chmod 600`, owned by `venue`.
- **Without `backup.json`, backups are only on the same droplet**, which doesn't protect you if the droplet itself is lost. Set up off-site backups (above).
- **Restore:**
  ```bash
  sudo systemctl stop guestlist
  sudo -u venue cp data/backups/venuelist-YYYY-MM-DD.db data/venuelist.db
  sudo systemctl start guestlist
  ```
  Run it from `/srv/guestlist`. Also delete `data/venuelist.db-wal` and `data/venuelist.db-shm` if they exist.
