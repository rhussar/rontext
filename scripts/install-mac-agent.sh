#!/bin/bash
#
# Install (or remove) the nightly Messages sync as a launchd LaunchAgent.
#
#   scripts/install-mac-agent.sh              # install/refresh, runs daily at 09:30 local
#   scripts/install-mac-agent.sh --hour 7 --minute 0
#   scripts/install-mac-agent.sh --run-now    # install, then kick it once immediately
#   scripts/install-mac-agent.sh --uninstall
#   scripts/install-mac-agent.sh --status     # is it loaded, when did it last run, log tail
#
# What it writes: ~/Library/LaunchAgents/com.rontext.sync.plist that runs
#   node node_modules/tsx/dist/cli.mjs scripts/mac-agent.ts
# from this web/ directory, logging to ~/Library/Logs/rontext/mac-agent.log.
# StartCalendarInterval means a missed run (Mac asleep) fires on wake.
#
# THE ONE MANUAL STEP — Full Disk Access for node:
#   macOS grants FDA per *program*, and launchd runs node directly (not via a
#   shell — that's on purpose, so the grant goes to node, not bash). Add the
#   real node binary printed at the end of this script in
#   System Settings → Privacy & Security → Full Disk Access (click +, then
#   ⌘⇧G and paste the path). Until then every run fails with a clear
#   "no Full Disk Access" line in Settings → Accounts → Automation.
#   A Homebrew node upgrade changes that path → re-grant and re-run this.
set -euo pipefail

LABEL="com.rontext.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/rontext"
WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOUR=9
MINUTE=30
RUN_NOW=0
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --hour) HOUR="$2"; shift 2 ;;
    --minute) MINUTE="$2"; shift 2 ;;
    --run-now) RUN_NOW=1; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --status) MODE="status"; shift ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
done

UID_NUM="$(id -u)"

if [ "$MODE" = "status" ]; then
  if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
    echo "loaded:   yes ($PLIST)"
    launchctl print "gui/$UID_NUM/$LABEL" | grep -E "last exit code|state =" | sed 's/^/          /' || true
  else
    echo "loaded:   no"
  fi
  if [ -f "$LOG_DIR/mac-agent.log" ]; then
    echo "log tail: $LOG_DIR/mac-agent.log"
    tail -n 5 "$LOG_DIR/mac-agent.log" | sed 's/^/          /'
  fi
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL. Logs left in $LOG_DIR."
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH"; exit 1
fi
NODE_REAL="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$NODE_BIN")"
TSX="$WEB_DIR/node_modules/tsx/dist/cli.mjs"
if [ ! -f "$TSX" ]; then
  echo "tsx not installed — run npm install in $WEB_DIR first"; exit 1
fi
if [ ! -f "$WEB_DIR/.env.local" ]; then
  echo "warning: $WEB_DIR/.env.local not found — the agent needs DATABASE_URL from it"
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_REAL</string>
    <string>$TSX</string>
    <string>scripts/mac-agent.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$WEB_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG_DIR/mac-agent.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/mac-agent.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
PLIST

# Reload: bootout is a no-op when it isn't loaded yet.
launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"

echo "Installed $LABEL — runs daily at $(printf '%02d:%02d' "$HOUR" "$MINUTE") local (missed runs fire on wake)."
echo "  plist:  $PLIST"
echo "  log:    $LOG_DIR/mac-agent.log"
echo "  status: scripts/install-mac-agent.sh --status"
echo
echo "ONE MANUAL STEP if not done yet — grant Full Disk Access to node:"
echo "  System Settings → Privacy & Security → Full Disk Access → + → ⌘⇧G → paste:"
echo "  $NODE_REAL"
echo "  (a Homebrew node upgrade moves this path; re-grant + re-run this script after one)"

if [ "$RUN_NOW" = "1" ]; then
  echo
  echo "Kicking a run now…"
  launchctl kickstart -k "gui/$UID_NUM/$LABEL"
  sleep 20
  tail -n 3 "$LOG_DIR/mac-agent.log" 2>/dev/null || true
fi
