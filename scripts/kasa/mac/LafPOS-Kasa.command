#!/bin/sh
# LafPOS kasa ekranı (macOS): Chrome'u kiosk ve sessiz fiş yazdırma ile açar. Çıkmak için Cmd+Q.
# Ayrıntı: docs/05-KASA-BILGISAYARI.md
URL="${LAFPOS_URL:-http://localhost:4000/}"
i=0
while [ $i -lt 90 ]; do
  curl -fsS "${URL}api/health" >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 1
done
open -na "Google Chrome" --args --kiosk --kiosk-printing --app="$URL" \
  --user-data-dir="$HOME/Library/Application Support/LafPOS/chrome" \
  --no-first-run --no-default-browser-check --disable-pinch --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required --disable-session-crashed-bubble
