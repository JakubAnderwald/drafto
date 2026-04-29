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
#
# Shebang bypass: we invoke the agent as `bash "$AGENT"` instead of letting
# the kernel resolve the script's `#!/bin/bash` shebang. On macOS 26.3.1
# (and likely related builds), launching a `#!/bin/bash` script from a
# child of a launchd-spawned bash hangs at `_dyld_start` indefinitely
# (sample shows the universal-binary slice mis-selected as plain ARM64
# rather than the available ARM64E). Calling `bash <path>` explicitly
# sidesteps that resolution path. Verified by side-by-side test:
# `bash -c 'support-agent.sh ...'` hangs; `bash -c 'bash support-agent.sh ...'`
# completes immediately.

set -euo pipefail

LOCK_DIR="/tmp/drafto-support-agent.lock"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="$SCRIPT_DIR/support-agent.sh"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Each mode is independent; if one fails, still try the others so a transient
# Zoho hiccup doesn't starve the GitHub-side sweeps. Use the absolute
# `/bin/bash` rather than relying on PATH — launchd's PATH is minimal and a
# missing `bash` lookup here would silently no-op the whole tick.
/bin/bash "$AGENT" --auto-classify --phase G || true
/bin/bash "$AGENT" --comment-sync  --phase G || true
/bin/bash "$AGENT" --state-sync    --phase G || true
