#!/usr/bin/env bash
# Run the app locally in demo mode against the demo database.
#   scripts/dev-demo.sh            (port 3100)
# Loads .env.local for the bootstrap keys, then overrides DATABASE_URL with
# DEMO_DATABASE_URL and sets DEMO_MODE=1. Next.js never overrides an env var
# that is already set, so the override survives its own .env.local loading.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.local; set +a
: "${DEMO_DATABASE_URL:?DEMO_DATABASE_URL is not set in .env.local}"
export DEMO_MODE=1
export DATABASE_URL="$DEMO_DATABASE_URL"
exec npx next dev -p "${PORT:-3100}"
