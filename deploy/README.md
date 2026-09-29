# Deploying to guestlist.riderly.com.au

The main site (riderly.com.au) stays exactly where it is. We only add a **subdomain** that points at the DigitalOcean droplet, and the droplet runs the app.

```
guestlist.riderly.com.au ──A record──▶ droplet ──nginx/Caddy (HTTPS)──▶ VenueList on 127.0.0.1:3100
riderly.com.au           ──unchanged──▶ your existing host
```

## 1. DNS (VentraIP), 2 minutes

You need the droplet's public IPv4. Find it in DigitalOcean → Droplets, or run `curl -4 ifconfig.me` on the droplet.

In **VIPcontrol** → Domain Names → `riderly.com.au` → **DNS**, add:

| Type | Host / Name | Value | TTL |
|---|---|---|---|
| A | `guestlist` | *droplet IP* | 3600 |

Which screen to use depends on where the domain's nameservers point:
- **VentraIP DNS hosting:** add the record in VIPcontrol, as above.
- **VentraIP web hosting (cPanel):** add it in cPanel → **Zone Editor** instead.
- **DigitalOcean nameservers (`ns1.digitalocean.com`):** add it in DigitalOcean → Networking → Domains instead.

VIPcontrol shows the current nameservers on the domain's page.

Check it with `nslookup guestlist.riderly.com.au`. It usually works within minutes, but it can take up to a few hours.

## 2. Install on the droplet, 5 minutes

SSH in (`ssh root@<droplet-ip>`), then run:

```bash
# get the code (must live in /opt)
git clone -b claude/eloquent-bohr-d549tm https://github.com/Wntr2134/venuelist.git /opt/venuelist

# install: Node 22, a systemd service, HTTPS, nightly backups
sudo bash /opt/venuelist/deploy/install.sh guestlist.riderly.com.au you@youremail.com
```

If the repo is **private**, the clone will ask for credentials. Either:
- make a read-only deploy key: `ssh-keygen -t ed25519 -f ~/.ssh/venuelist -N ""`, add `~/.ssh/venuelist.pub` in GitHub → repo → Settings → Deploy keys, then clone with `GIT_SSH_COMMAND='ssh -i ~/.ssh/venuelist' git clone -b claude/eloquent-bohr-d549tm git@github.com:Wntr2134/venuelist.git /opt/venuelist`, or
- use a fine-grained personal access token (read-only, this repo only) as the password.

What the script does:
- **Existing websites are safe.** If nginx or Caddy is already running, it *adds* a site for the subdomain and leaves your other sites alone. If nothing is on ports 80/443, it installs Caddy.
- **HTTPS.** Uses Let's Encrypt (certbot for nginx; automatic with Caddy). If DNS isn't pointing at the droplet yet, it tells you and skips the certificate; just re-run the script later.
- **App service.** Runs as a locked-down `venuelist` system user, bound to `127.0.0.1:3100`, so it's only reachable through the web server. It restarts automatically if it crashes or the droplet reboots. If port 3100 is taken, use `PORT=3200 sudo -E bash …`.
- **Data.** The database lives in `/var/lib/venuelist/venuelist.db`, with nightly backups to `/var/backups/venuelist/` kept for 30 days.

**Then immediately open https://guestlist.riderly.com.au and set the venue password.** Whoever opens it first gets to set it.

## Day to day

```bash
sudo bash /opt/venuelist/deploy/update.sh   # pull the latest code and restart (backs up first)
journalctl -u venuelist -f                  # live logs
systemctl status venuelist                  # is it running?
```

**Restore a backup:**

```bash
systemctl stop venuelist
cp /var/backups/venuelist/venuelist-YYYY-MM-DD.db /var/lib/venuelist/venuelist.db
chown venuelist:venuelist /var/lib/venuelist/venuelist.db
systemctl start venuelist
```

Nightly backups live on the droplet itself. Turn on DigitalOcean's droplet backups (about 20% of the droplet price) so there's a copy off the box too.

## Apache instead of nginx?

The script stops if Apache is running. Enable `proxy`, `proxy_http` and `headers`, then use:

```apache
<VirtualHost *:80>
    ServerName guestlist.riderly.com.au
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3100/ flushpackets=on timeout=3600
    ProxyPassReverse / http://127.0.0.1:3100/
</VirtualHost>
```

Then run `certbot --apache -d guestlist.riderly.com.au`. You'll also need to create the systemd service by hand; copy it from `install.sh`.
