#!/bin/bash
# launchd entrypoint that runs factory-agent.sh's tick-driven modes
# back-to-back under a single mutex, so one 5-min launchd cycle walks
# the full plan → implement → watch → release pipeline.
#
# Modes (per scripts/factory-agent.sh):
#   --plan       Ready → Plan Review (or Blocked). Real work in every phase.
#   --implement  In Progress → In Review. Phase A: no-op (logged + exit 0).
#   --watch      In Review → In Test. Phase B+ feature; Phase A: no-op.
#   --release    Approved → Released. Phase B+: migration gate + squash-merge
#                of the green PR a human dragged to Approved; Phase A: no-op.
#
# --release is edge-triggered by the human Approved drag (ADR-0026), but it's
# cheap to poll every tick: with no Approved cards it's a single board query
# that exits in ~2s. Beta-channel dispatch (iOS/Android/macOS) stays a Phase D
# concern and is not part of --release yet.
#
# Mutex: macOS lacks flock(1); use a mkdir-based lock. If the previous
# tick is still running, exit cleanly without waiting.
#
# Shebang bypass: invoke the agent as `bash "$AGENT"` instead of letting
# the kernel resolve the script's `#!/bin/bash` shebang. On macOS 26.3.1
# (and likely related builds), launching a `#!/bin/bash` script from a
# child of a launchd-spawned bash hangs at `_dyld_start` indefinitely.
# Calling `bash <path>` explicitly sidesteps that resolution path.
# Verified pattern carried over from support-agent-loop.sh.

set -euo pipefail

LOCK_DIR="/tmp/drafto-factory-agent.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="$SCRIPT_DIR/factory-agent.sh"
PHASE="${FACTORY_PHASE:-A}"

# mkdir is the atomic lock. If it's already held, check whether the owning PID is
# still alive: a tick SIGKILL'd mid-run (reboot, OOM, or force-killing the
# documented _dyld_start hang) never fires the EXIT trap, so the lock dir leaks
# and every later tick would exit here forever. Reap a stale lock (dead/unknown
# owner) so the factory recovers on its own instead of dead-stopping silently.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  STALE_PID=$(cat "$LOCK_PID_FILE" 2>/dev/null || echo "")
  if [[ -n "$STALE_PID" ]] && kill -0 "$STALE_PID" 2>/dev/null; then
    exit 0  # previous tick genuinely still running
  fi
  rm -rf "$LOCK_DIR" 2>/dev/null || true
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    exit 0  # lost a race to a concurrent tick; let that one run
  fi
fi
echo "$$" > "$LOCK_PID_FILE" 2>/dev/null || true
trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT

# Each mode is independent; if one fails, still try the others so a
# transient GitHub hiccup in --plan doesn't starve --watch/--release. Use the
# absolute /bin/bash rather than relying on PATH — launchd's PATH is
# minimal and a missing `bash` lookup here would silently no-op the tick.
/bin/bash "$AGENT" --plan      --phase "$PHASE" || true
/bin/bash "$AGENT" --implement --phase "$PHASE" || true
/bin/bash "$AGENT" --watch     --phase "$PHASE" || true
/bin/bash "$AGENT" --release   --phase "$PHASE" || true
