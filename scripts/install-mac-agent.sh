#!/bin/bash
#
# Install (or remove) the two Mac-side syncs as launchd LaunchAgents.
#
#   com.rontext.sync      Messages + WhatsApp sync, daily at 09:30 local
#   com.rontext.contacts  Apple Contacts sync, every hour
#
#   scripts/install-mac-agent.sh              # install/refresh both
#   scripts/install-mac-agent.sh --hour 7 --minute 0     # Messages/WhatsApp time only
#   scripts/install-mac-agent.sh --every 30   # contacts every 30 minutes
#   scripts/install-mac-agent.sh --run-now    # install, then kick both once
#   scripts/install-mac-agent.sh --uninstall
#   scripts/install-mac-agent.sh --status     # loaded? last run? log tail
#
# Two agents rather than one because the schedules genuinely differ: a phone
# number saved on the iPhone should reach Rontext within the hour, while the
# Messages/WhatsApp pass is a full re-scan of chat.db and ChatStorage.sqlite
# that nothing waits on. WhatsApp is skipped (not failed) until WhatsApp for
# Mac is installed and linked. Same
# program either way, so the one Full Disk Access grant covers both.
#
# What they write: ~/Library/LaunchAgents/<label>.plist running
#   node node_modules/tsx/dist/cli.mjs scripts/mac-agent.ts --only <parts>
# from this web/ directory, logging into ~/Library/Logs/rontext/.
# StartCalendarInterval means a missed daily run (Mac asleep) fires on wake;
# so does a missed StartInterval.
#
# THE ONE MANUAL STEP — Full Disk Access for node:
#   macOS grants FDA per *program*, and launchd runs node directly (not via a
#   shell — that's on purpose, so the grant goes to node, not bash). Add the
#   real node binary printed at the end of this script in
#   System Settings → Privacy & Security → Full Disk Access (click +, then
#   ⌘⇧G and paste the path). Until then every run fails with a clear
#   "no Full Disk Access" line in Settings → Accounts → Automation.
#   A Homebrew node upgrade changes that path → re-grant and re-run this.
#   Contacts needs the same grant and nothing more: the sync reads the
#   AddressBook SQLite files directly, never Contacts.app, so no Automation
#   prompt is involved (a background job could never answer one).
set -euo pipefail

SYNC_LABEL="com.rontext.sync"
CONTACTS_LABEL="com.rontext.contacts"
LOG_DIR="$HOME/Library/Logs/rontext"
WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOUR=9
MINUTE=30
EVERY_MINUTES=60
RUN_NOW=0
MODE="install"

plist_path() { echo "$HOME/Library/LaunchAgents/$1.plist"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --hour) HOUR="$2"; shift 2 ;;
    --minute) MINUTE="$2"; shift 2 ;;
    --every) EVERY_MINUTES="$2"; shift 2 ;;
    --run-now) RUN_NOW=1; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --status) MODE="status"; shift ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
done

UID_NUM="$(id -u)"

if [ "$MODE" = "status" ]; then
  for LABEL in "$SYNC_LABEL" "$CONTACTS_LABEL"; do
    PLIST="$(plist_path "$LABEL")"
    echo "$LABEL"
    if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
      echo "  loaded:   yes ($PLIST)"
      launchctl print "gui/$UID_NUM/$LABEL" | grep -E "last exit code|state =" | sed 's/^/            /' || true
    else
      echo "  loaded:   no"
    fi
  done
  for LOG in "$LOG_DIR/mac-agent.log" "$LOG_DIR/contacts-agent.log"; do
    if [ -f "$LOG" ]; then
      echo "log tail: $LOG"
      tail -n 5 "$LOG" | sed 's/^/          /'
    fi
  done
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  for LABEL in "$SYNC_LABEL" "$CONTACTS_LABEL"; do
    PLIST="$(plist_path "$LABEL")"
    launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL."
  done
  echo "Logs left in $LOG_DIR."
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

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# $1 label, $2 --only value, $3 log file, $4 the schedule <key>…</key> block
write_plist() {
  local LABEL="$1" PART="$2" LOG="$3" SCHEDULE="$4"
  local PLIST; PLIST="$(plist_path "$LABEL")"
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
    <string>--only</string>
    <string>$PART</string>
  </array>
  <key>WorkingDirectory</key><string>$WEB_DIR</string>
$SCHEDULE
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
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
}

write_plist "$SYNC_LABEL" messages,whatsapp "$LOG_DIR/mac-agent.log" \
"  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>"

write_plist "$CONTACTS_LABEL" contacts "$LOG_DIR/contacts-agent.log" \
"  <key>StartInterval</key><integer>$((EVERY_MINUTES * 60))</integer>"

echo "Installed $SYNC_LABEL — Messages + WhatsApp, daily at $(printf '%02d:%02d' "$HOUR" "$MINUTE") local (missed runs fire on wake)."
echo "Installed $CONTACTS_LABEL — Apple Contacts, every $EVERY_MINUTES min."
echo "  plists: $(plist_path "$SYNC_LABEL")"
echo "          $(plist_path "$CONTACTS_LABEL")"
echo "  logs:   $LOG_DIR/mac-agent.log, $LOG_DIR/contacts-agent.log"
echo "  status: scripts/install-mac-agent.sh --status"
echo
echo "ONE MANUAL STEP if not done yet — grant Full Disk Access to node:"
echo "  System Settings → Privacy & Security → Full Disk Access → + → ⌘⇧G → paste:"
echo "  $NODE_REAL"
echo "  (a Homebrew node upgrade moves this path; re-grant + re-run this script after one)"

if [ "$RUN_NOW" = "1" ]; then
  echo
  echo "Kicking both now…"
  launchctl kickstart -k "gui/$UID_NUM/$CONTACTS_LABEL"
  launchctl kickstart -k "gui/$UID_NUM/$SYNC_LABEL"
  sleep 20
  tail -n 3 "$LOG_DIR/contacts-agent.log" 2>/dev/null || true
  tail -n 3 "$LOG_DIR/mac-agent.log" 2>/dev/null || true
fi
