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

# ── Self-update: only ever run reviewed, CI-gated code from origin/main ──
# The factory deploys from a dedicated git worktree pinned to main (detached
# HEAD; see docs/operations/factory-runbook.md → "Deployment"). Fast-forward to
# the latest origin/main at the start of every tick so a merged fix — or a
# revert — goes live on the very next cycle with zero manual pull, and the
# factory can never again run unmerged, un-CI'd code (the failure mode that
# shipped the bash-3.2 --release crash). Runs INSIDE the mutex so two ticks
# can't reset the tree out from under each other. Set FACTORY_AUTOPULL=0 for
# ad-hoc local runs against a dirty tree.
if [[ "${FACTORY_AUTOPULL:-1}" == "1" ]]; then
  _ts() { date "+%Y-%m-%d %H:%M:%S"; }
  _loop_before="$(shasum "${BASH_SOURCE[0]}" 2>/dev/null | awk '{print $1}')"
  if git -C "$SCRIPT_DIR" fetch --quiet origin main 2>/dev/null; then
    if git -C "$SCRIPT_DIR" reset --hard --quiet origin/main 2>/dev/null; then
      echo "[$(_ts)] self-update: synced to origin/main @ $(git -C "$SCRIPT_DIR" rev-parse --short HEAD)"
    else
      echo "[$(_ts)] self-update: reset to origin/main FAILED; running the checked-out tree as-is" >&2
    fi
  else
    echo "[$(_ts)] self-update: fetch origin main FAILED (offline?); running the checked-out tree as-is" >&2
  fi
  # If this wrapper itself changed in the sync, the running bash is now executing
  # a stale file (byte-offset reads can misbehave). Re-exec the fresh copy once;
  # the guard env prevents an infinite loop, and we drop the lock first so the
  # re-exec's fresh run can re-acquire it (exec replaces the process, so the EXIT
  # trap never fires to release it for us).
  _loop_after="$(shasum "${BASH_SOURCE[0]}" 2>/dev/null | awk '{print $1}')"
  if [[ -n "$_loop_before" && "$_loop_before" != "$_loop_after" && "${FACTORY_LOOP_REEXECED:-0}" != "1" ]]; then
    echo "[$(_ts)] self-update: loop wrapper changed; re-exec'ing the new version"
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    export FACTORY_LOOP_REEXECED=1
    exec /bin/bash "${BASH_SOURCE[0]}"
  fi
fi

# Each mode is independent; if one fails, still try the others so a
# transient GitHub hiccup in --plan doesn't starve --watch/--release. Use the
# absolute /bin/bash rather than relying on PATH — launchd's PATH is
# minimal and a missing `bash` lookup here would silently no-op the tick.
/bin/bash "$AGENT" --plan      --phase "$PHASE" || true
/bin/bash "$AGENT" --implement --phase "$PHASE" || true
/bin/bash "$AGENT" --watch     --phase "$PHASE" || true
/bin/bash "$AGENT" --release   --phase "$PHASE" || true
