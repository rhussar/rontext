#!/bin/bash
#
# Install (or remove) the two Mac-side syncs as launchd LaunchAgents.
#
#   com.rontext.sync      Messages + WhatsApp sync, daily at 09:30 local
#   com.rontext.contacts  Apple Contacts sync, every hour
#   com.rontext.whatsapp  WhatsApp sync whenever WhatsApp's database files
#                         change, at most once every 5 minutes
#
#   scripts/install-mac-agent.sh              # install/refresh both
#   scripts/install-mac-agent.sh --hour 7 --minute 0     # Messages/WhatsApp time only
#   scripts/install-mac-agent.sh --every 30   # contacts every 30 minutes
#   scripts/install-mac-agent.sh --wa-throttle 120  # WhatsApp at most every 2 min
#   scripts/install-mac-agent.sh --run-now    # install, then kick both once
#   scripts/install-mac-agent.sh --uninstall
#   scripts/install-mac-agent.sh --status     # loaded? last run? log tail
#   scripts/install-mac-agent.sh --ensure     # reinstall only if stale (see below)
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
#
# WHY --ensure EXISTS — the plists hold absolute paths (this web/ directory,
# the node binary). Moving the project folder breaks them in the worst way:
# launchd can't even start the job, so nothing runs, nothing logs, and no
# heartbeat is written. That is exactly what happened Sep 5–24, 2026, when
# ~/Rontext moved to ~/Software/Rontext. --ensure compares every installed
# plist with this checkout and the current node and reinstalls only on a
# mismatch; the project's Claude Code SessionStart hook runs it, so a move is
# repaired the next time a session opens here.
set -euo pipefail

SYNC_LABEL="com.rontext.sync"
CONTACTS_LABEL="com.rontext.contacts"
WHATSAPP_LABEL="com.rontext.whatsapp"
WA_DIR="$HOME/Library/Group Containers/group.net.whatsapp.WhatsApp.shared"
WA_THROTTLE=300
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
    --wa-throttle) WA_THROTTLE="$2"; shift 2 ;;
    --run-now) RUN_NOW=1; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --status) MODE="status"; shift ;;
    --ensure) MODE="ensure"; shift ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
done

UID_NUM="$(id -u)"

# Prints why a label's installed job wouldn't run from this checkout; prints
# nothing when it's current. $1 label, $2 the node it should use.
stale_reason() {
  local LABEL="$1" WANT_NODE="$2" PLIST WD NODE_ARG TSX_ARG PB=/usr/libexec/PlistBuddy
  PLIST="$(plist_path "$LABEL")"
  [ -f "$PLIST" ] || { echo "$LABEL isn't installed"; return; }
  WD="$($PB -c "Print :WorkingDirectory" "$PLIST" 2>/dev/null || true)"
  NODE_ARG="$($PB -c "Print :ProgramArguments:0" "$PLIST" 2>/dev/null || true)"
  TSX_ARG="$($PB -c "Print :ProgramArguments:1" "$PLIST" 2>/dev/null || true)"
  if [ "$WD" != "$WEB_DIR" ]; then echo "$LABEL points at $WD, not $WEB_DIR"; return; fi
  if [ ! -f "$TSX_ARG" ]; then echo "$LABEL's tsx is missing ($TSX_ARG)"; return; fi
  if [ ! -x "$NODE_ARG" ]; then echo "$LABEL's node is missing ($NODE_ARG)"; return; fi
  if [ -n "$WANT_NODE" ] && [ "$NODE_ARG" != "$WANT_NODE" ]; then
    echo "$LABEL uses $NODE_ARG, not the current node $WANT_NODE"; return
  fi
  launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || echo "$LABEL isn't loaded"
}

current_node() {
  local BIN; BIN="$(command -v node || true)"
  [ -n "$BIN" ] && python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$BIN"
}

if [ "$MODE" = "ensure" ]; then
  WANT="$(current_node)"
  REASONS=""
  for LABEL in "$SYNC_LABEL" "$CONTACTS_LABEL" "$WHATSAPP_LABEL"; do
    R="$(stale_reason "$LABEL" "$WANT")"
    [ -n "$R" ] && REASONS="$REASONS$R; "
  done
  # Silent when everything is current — this runs at every session start.
  [ -z "$REASONS" ] && exit 0
  echo "Rontext Mac sync jobs were stale (${REASONS%; }) — reinstalling."
  MODE="install"
fi

if [ "$MODE" = "status" ]; then
  for LABEL in "$SYNC_LABEL" "$CONTACTS_LABEL" "$WHATSAPP_LABEL"; do
    PLIST="$(plist_path "$LABEL")"
    echo "$LABEL"
    R="$(stale_reason "$LABEL" "$(current_node)")"
    echo "  paths:    ${R:-ok — points at $WEB_DIR}"
    if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
      echo "  loaded:   yes ($PLIST)"
      launchctl print "gui/$UID_NUM/$LABEL" | grep -E "last exit code|state =" | sed 's/^/            /' || true
    else
      echo "  loaded:   no"
    fi
  done
  for LOG in "$LOG_DIR/mac-agent.log" "$LOG_DIR/contacts-agent.log" "$LOG_DIR/whatsapp-agent.log"; do
    if [ -f "$LOG" ]; then
      echo "log tail: $LOG"
      tail -n 5 "$LOG" | sed 's/^/          /'
    fi
  done
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  for LABEL in "$SYNC_LABEL" "$CONTACTS_LABEL" "$WHATSAPP_LABEL"; do
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

# $1 label, $2 --only value, $3 log file, $4 the schedule <key>…</key> block,
# $5 optional extra <string> args for mac-agent.ts
write_plist() {
  local LABEL="$1" PART="$2" LOG="$3" SCHEDULE="$4" EXTRA="${5:-}"
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
    <string>$PART</string>$EXTRA
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

# WatchPaths fires on any write to these files; ThrottleInterval is the
# minimum gap between launches, and --if-changed makes the many runs where
# only receipts or presence changed exit without touching the database. The
# daily $SYNC_LABEL run stays as the guaranteed check-in.
write_plist "$WHATSAPP_LABEL" whatsapp "$LOG_DIR/whatsapp-agent.log" \
"  <key>WatchPaths</key>
  <array>
    <string>$WA_DIR/ChatStorage.sqlite</string>
    <string>$WA_DIR/ChatStorage.sqlite-wal</string>
    <string>$WA_DIR/ContactsV2.sqlite-wal</string>
    <string>$WA_DIR/LID.sqlite-wal</string>
  </array>
  <key>ThrottleInterval</key><integer>$WA_THROTTLE</integer>" \
"
    <string>--if-changed</string>"

echo "Installed $SYNC_LABEL — Messages + WhatsApp, daily at $(printf '%02d:%02d' "$HOUR" "$MINUTE") local (missed runs fire on wake)."
echo "Installed $CONTACTS_LABEL — Apple Contacts, every $EVERY_MINUTES min."
echo "Installed $WHATSAPP_LABEL — WhatsApp, when its database changes (at most every $((WA_THROTTLE / 60)) min)."
echo "  plists: $(plist_path "$SYNC_LABEL")"
echo "          $(plist_path "$CONTACTS_LABEL")"
echo "          $(plist_path "$WHATSAPP_LABEL")"
echo "  logs:   $LOG_DIR/mac-agent.log, $LOG_DIR/contacts-agent.log, $LOG_DIR/whatsapp-agent.log"
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
