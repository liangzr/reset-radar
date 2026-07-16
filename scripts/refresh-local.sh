#!/usr/bin/env bash
# Reset Radar — local hourly refresh (run from a residential-IP machine via cron).
# Reads nitter through the local mihomo proxy (curl honours http_proxy), detects
# new resets, and pushes an updated events.json so GitHub Pages redeploys.
set -uo pipefail

# cron runs with a bare environment — set PATH + proxy explicitly.
export PATH="/usr/local/bin:/usr/bin:/bin"
export http_proxy="http://127.0.0.1:7890"
export https_proxy="http://127.0.0.1:7890"
export all_proxy="socks5://127.0.0.1:7890"
export no_proxy="localhost,127.0.0.1,::1"

cd "$(dirname "$0")/.." || exit 1
LOG=".refresh.log"

{
  echo "=== $(date -u +%FT%TZ) ==="
  git pull --rebase --autostash --quiet origin main || echo "warn: pull failed"
  node scripts/fetch.mjs || { echo "fetch error"; exit 1; }
  if [ -n "$(git status --porcelain data/events.json)" ]; then
    git add data/events.json
    git -c user.name="reset-radar-bot" \
        -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
        commit -q -m "chore: refresh reset events [skip ci]"
    if git push -q origin main; then echo "pushed new events"; else echo "warn: push failed"; fi
  else
    echo "no new events"
  fi
} 2>&1 | tee -a "$LOG"
