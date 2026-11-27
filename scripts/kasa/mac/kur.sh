#!/bin/sh
# AsilPOS kasa bilgisayarı kurulumu (macOS). Ayrıntı: docs/05-KASA-BILGISAYARI.md
#   Kur:    sh scripts/kasa/mac/kur.sh
#   Kaldır: sh scripts/kasa/mac/kur.sh --kaldir
# Oturum açılınca sunucu (launchd, çökerse yeniden başlar) ve kasa ekranı (kiosk Chrome) açılır.
set -e
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
SERVER="net.laffogato.lafpos"
SCREEN="net.laffogato.lafpos.kasa"

if [ "$1" = "--kaldir" ]; then
  launchctl unload "$AGENTS/$SERVER.plist" 2>/dev/null || true
  launchctl unload "$AGENTS/$SCREEN.plist" 2>/dev/null || true
  rm -f "$AGENTS/$SERVER.plist" "$AGENTS/$SCREEN.plist"
  echo "AsilPOS otomatik başlatma kaldırıldı (veriler duruyor: $REPO/data)."
  exit 0
fi

NPM="$(command -v npm || true)"
[ -n "$NPM" ] || { echo "Node.js bulunamadı (22.11 ya da üstü): https://nodejs.org"; exit 1; }
[ -f "$REPO/dist/web/index.html" ] || { echo "Önce derleyin: npm ci && npm run build"; exit 1; }
mkdir -p "$AGENTS" "$REPO/data"
chmod +x "$REPO/scripts/kasa/mac/LafPOS-Kasa.command"

cat > "$AGENTS/$SERVER.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SERVER</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>ProgramArguments</key><array><string>$NPM</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NPM"):/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO/data/sunucu.log</string>
  <key>StandardErrorPath</key><string>$REPO/data/sunucu.log</string>
</dict></plist>
PLIST

cat > "$AGENTS/$SCREEN.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SCREEN</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$REPO/scripts/kasa/mac/LafPOS-Kasa.command</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST

launchctl unload "$AGENTS/$SERVER.plist" 2>/dev/null || true
launchctl load "$AGENTS/$SERVER.plist"
launchctl unload "$AGENTS/$SCREEN.plist" 2>/dev/null || true
launchctl load "$AGENTS/$SCREEN.plist"
echo "Tamam: oturum açılınca AsilPOS sunucusu ve kasa ekranı açılacak."
