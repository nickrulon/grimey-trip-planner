#!/bin/bash
# Rebuild the read-only static snapshot and push it to the shared preview site:
#   https://nickrulon.github.io/grimey-trip-planner-preview/
# Prereq: the local API must be running (npm run dev / launch entry "grimey").
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT="${API_PORT:-5181}"
curl -sf "localhost:$API_PORT/api/summary" > /dev/null \
  || { echo "API not reachable on :$API_PORT — start the dev server first (or API_PORT=5281 $0)"; exit 1; }

npx vite build --base=./
API_PORT=$API_PORT node scripts/export-static.mjs

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone -q --depth 1 https://github.com/nickrulon/grimey-trip-planner-preview.git "$TMP"
find "$TMP" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r dist/. "$TMP"/
touch "$TMP/.nojekyll"
cd "$TMP"
git -c http.postBuffer=524288000 -c http.version=HTTP/1.1 add -A
if git diff --cached --quiet; then echo "No changes to deploy."; exit 0; fi
git -c user.name="Nick Lynn-Rulon" -c user.email="nicklr@commercient.com" \
  commit -qm "Update preview snapshot ($(date +%Y-%m-%d))"
git -c http.postBuffer=524288000 -c http.version=HTTP/1.1 push -q
echo "Deployed — live in ~1 min at https://nickrulon.github.io/grimey-trip-planner-preview/"
