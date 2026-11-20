#!/bin/sh
# Cloudflare build for staging.tenniscourtcast.com (and branch previews).
# Set the Worker's build command to:  sh scripts/cf-build.sh
#
# 1. Build a fresh forecast with this branch's code, so new data fields show up on staging
#    before they reach the live site. If Python or the weather API fails, copy the live
#    forecast instead, so staging still loads.
# 2. Tell search engines not to list staging.
# 3. Pretend the visitor is in Rancho Cucamonga (scripts/staging-location.js), so the "near me"
#    features can be tested from anywhere. ?at=real or ?at=lat,lon overrides it. Staging only:
#    the live site is built by GitHub Actions from site/ and never gets this script.
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
cp scripts/staging-location.js site/staging-location.js
# Load it first in <head>, before the map library and app.js read the location.
sed -i 's|<link rel="stylesheet" href="style.css">|&\n  <script src="staging-location.js"></script>|' site/index.html
grep -q 'staging-location.js' site/index.html || { echo "Couldn't add the staging location script"; exit 1; }
