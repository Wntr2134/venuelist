#!/usr/bin/env bash
# Pull the latest code and restart. Data is untouched.
#   sudo bash deploy/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
sqlite3 /var/lib/venuelist/venuelist.db ".backup '/var/backups/venuelist/pre-update-$(date +%F-%H%M).db'" 2>/dev/null || true
git pull --ff-only
systemctl restart venuelist
sleep 1
systemctl is-active --quiet venuelist && echo "Updated to $(git log -1 --format='%h %s')" || { journalctl -u venuelist -n 30; exit 1; }
