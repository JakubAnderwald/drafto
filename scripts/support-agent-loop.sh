#!/bin/bash
# launchd entrypoint that runs support-agent.sh's three live modes back-to-back
# under a single mutex, so a 60-second cron tick walks the full Zoho → GitHub
# → customer-email pipeline once per minute.
#
# Modes (per scripts/support-agent.sh):
#   --auto-classify  Phase D+: classify pending Zoho threads, escalate or auto-reply.
#   --comment-sync   Phase F+: forward GitHub support-issue comments to Zoho.
#   --state-sync     Phase G+: forward GitHub issue lifecycle (closed/reopened) to Zoho.
#
# Mutex: macOS lacks flock(1), so we use a mkdir-based lock. If the previous
# tick is still running, this run exits cleanly without waiting.

set -euo pipefail

LOCK_DIR="/tmp/drafto-support-agent.lock"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="$SCRIPT_DIR/support-agent.sh"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Each mode is independent; if one fails, still try the others so a transient
# Zoho hiccup doesn't starve the GitHub-side sweeps.
"$AGENT" --auto-classify --phase G || true
"$AGENT" --comment-sync  --phase G || true
"$AGENT" --state-sync    --phase G || true
