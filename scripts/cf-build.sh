#!/bin/sh
# Cloudflare build for staging.tenniscourtcast.com (and branch previews).
# Set the Worker's build command to:  sh scripts/cf-build.sh
#
# 1. Build a fresh forecast with this branch's code, so new data fields show up on staging
#    before they reach the live site. If Python or the weather API fails, copy the live
#    forecast instead, so staging still loads.
# 2. Tell search engines not to list staging.
set -u
mkdir -p site/data
PY=$(command -v python3 || command -v python || true)
if [ -n "$PY" ] && "$PY" -m courtcast.build --out site/data/forecast.json --snapshot-dir /tmp/snapshots; then
  echo "Built a fresh forecast with this branch's code."
else
  echo "Fresh build unavailable; copying the live forecast."
  curl -sfL --retry 3 https://tenniscourtcast.com/data/forecast.json -o site/data/forecast.json || exit 1
fi
printf '/*\n  X-Robots-Tag: noindex\n' > site/_headers
