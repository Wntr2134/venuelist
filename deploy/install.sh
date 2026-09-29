#!/usr/bin/env bash
# VenueList installer for an Ubuntu/Debian droplet.
#
#   sudo bash deploy/install.sh guestlist.riderly.com.au you@example.com
#
# Safe to re-run. Detects an existing nginx or Caddy and adds a site for this
# domain alongside whatever is already there; installs Caddy only if nothing
# is serving ports 80/443.
set -euo pipefail

DOMAIN="${1:-guestlist.riderly.com.au}"
EMAIL="${2:-}"
PORT="${PORT:-3100}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR=/var/lib/venuelist
BACKUP_DIR=/var/backups/venuelist
SERVICE=venuelist
APP_USER=venuelist

say()  { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
command -v apt-get >/dev/null || die "This script supports Ubuntu/Debian only."
[ -f "$APP_DIR/server.js" ] || die "Run this from inside the cloned venuelist repo."
case "$APP_DIR" in
  /root/*|/home/*) die "Clone the repo into /opt/venuelist (the service user can't read $APP_DIR)." ;;
esac

# ---------- DNS check ----------
say "Checking DNS for $DOMAIN"
MY_IP="$(curl -fsS --max-time 3 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || curl -fsS --max-time 5 https://api.ipify.org || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
echo "   droplet IP: ${MY_IP:-unknown}   $DOMAIN resolves to: ${DNS_IP:-nothing yet}"
if [ -z "$DNS_IP" ] || [ "$DNS_IP" != "$MY_IP" ]; then
  warn "$DOMAIN doesn't point at this droplet yet. Add an A record: guestlist -> $MY_IP"
  warn "The app will still install, but the HTTPS certificate can't be issued until DNS is right."
  DNS_OK=0
else
  DNS_OK=1
fi

# ---------- packages ----------
say "Installing packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git sqlite3 >/dev/null

need_node=1
if command -v node >/dev/null; then
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
echo "   node $("$NODE_BIN" --version) at $NODE_BIN"

# ---------- user & data ----------
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

if ss -ltn "sport = :$PORT" | grep -q LISTEN && ! systemctl is-active --quiet "$SERVICE"; then
  die "Port $PORT is already used by something else. Re-run with PORT=3200 sudo -E bash deploy/install.sh ..."
fi

# ---------- systemd service ----------
say "Creating systemd service ($SERVICE on 127.0.0.1:$PORT)"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=VenueList guest list
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=DB_FILE=$DATA_DIR/venuelist.db
Environment=SECURE_COOKIES=1
Environment=TRUST_PROXY=1
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"
sleep 1
curl -fsS "http://127.0.0.1:$PORT/api/session" >/dev/null || die "App didn't start. Check: journalctl -u $SERVICE -n 50"
echo "   app is up"

# ---------- reverse proxy + HTTPS ----------
if systemctl is-active --quiet nginx; then
  say "Found nginx — adding a site for $DOMAIN"
  CONF=/etc/nginx/sites-available/$DOMAIN
  cat > "$CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        # Live door sync (Server-Sent Events) needs these
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
EOF
  ln -sf "$CONF" /etc/nginx/sites-enabled/$DOMAIN
  nginx -t
  systemctl reload nginx
  if [ "$DNS_OK" -eq 1 ]; then
    command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    if [ -n "$EMAIL" ]; then
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
    else
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
    fi
  else
    warn "Skipped HTTPS. Once DNS points here, run: sudo certbot --nginx -d $DOMAIN --redirect"
  fi
elif systemctl is-active --quiet apache2; then
  die "Apache is running. This script handles nginx or Caddy — see deploy/README.md for an Apache config."
else
  if ! command -v caddy >/dev/null; then
    if ss -ltn '( sport = :80 or sport = :443 )' | grep -q LISTEN; then
      die "Something (not nginx/Caddy) is already on port 80/443. Stop it or configure it to proxy to 127.0.0.1:$PORT."
    fi
    say "No web server found — installing Caddy (automatic HTTPS)"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
    : > /etc/caddy/Caddyfile
  else
    say "Found Caddy — adding a site for $DOMAIN"
  fi
  if ! grep -q "^$DOMAIN" /etc/caddy/Caddyfile 2>/dev/null; then
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)" 2>/dev/null || true
    printf '\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" >> /etc/caddy/Caddyfile
  fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl enable --quiet caddy
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  [ "$DNS_OK" -eq 1 ] || warn "Caddy will fetch the HTTPS certificate automatically once DNS points here."
fi

# ---------- firewall ----------
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# ---------- nightly backups ----------
say "Setting up nightly database backups ($BACKUP_DIR, kept 30 days)"
cat > /etc/cron.daily/venuelist-backup <<EOF
#!/bin/sh
set -e
[ -f $DATA_DIR/venuelist.db ] || exit 0
sqlite3 $DATA_DIR/venuelist.db ".backup '$BACKUP_DIR/venuelist-\$(date +%F).db'"
find $BACKUP_DIR -name 'venuelist-*.db' -mtime +30 -delete
EOF
chmod 755 /etc/cron.daily/venuelist-backup

say "Done"
echo "   Open https://$DOMAIN and set the venue password straight away."
echo "   Logs:    journalctl -u $SERVICE -f"
echo "   Update:  sudo bash $APP_DIR/deploy/update.sh"
