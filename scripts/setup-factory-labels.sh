#!/bin/bash
# One-shot, idempotent factory label bootstrap.
#
# Usage: scripts/setup-factory-labels.sh [--repo <owner/name>]
#
# Defaults to JakubAnderwald/drafto. Re-running is safe: existing labels are
# updated in place via `gh label create --force` (which upserts colour +
# description), missing labels are created.
#
# These labels back the dark-factory state machine documented in
# docs/features/dark-factory.md and ADR-0026. The status:* set mirrors the
# Project v2 Status field (see .github/workflows/factory-status-mirror.yml);
# parity:* and migration-approved are operator gates; factory-pause and
# factory-failure are kill-switch / failure-trap signals.

set -euo pipefail

REPO="JakubAnderwald/drafto"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not found on PATH" >&2
  exit 1
fi

# Schema: name|color|description. Colours are deliberately spread along the
# lifecycle (cool → warm → green) so the board reads at a glance.
LABELS=(
  # Lifecycle (mirrored from Project v2 Status). Backlog has no label —
  # it's the implicit "no status:* set" state.
  "status:ready|0E8A16|Spec complete; factory may plan."
  "status:planning|1D76DB|Factory is reading the issue and writing a plan."
  "status:plan-review|5319E7|Plan posted as a comment; awaiting human approval."
  "status:in-progress|FBCA04|Plan approved; factory is implementing."
  "status:in-review|0052CC|PR open; factory monitoring CI and review comments."
  "status:in-test|006B75|Vercel preview ready; awaiting human approval to ship."
  "status:approved|0E8A16|Approved for release; factory will merge + dispatch."
  "status:released|2E7D32|Merged + beta channels dispatched (Phase D)."
  "status:done|0E8A16|Final acceptance from reporter; issue closed."
  "status:blocked|B60205|Spec incomplete, retry budget exhausted, or hard gate."

  # Operator gates.
  "factory-pause|D93F0B|Global kill switch — factory exits early when set."
  "migration-approved|0052CC|Authorises factory to merge a PR with supabase/migrations changes."
  "factory-failure|B60205|Filed by the factory failure trap when a run errors out."

  # Parity overrides — set by the operator to disable the cross-platform
  # parity check for legitimate single-platform work.
  "parity:web-only|C5DEF5|Skip cross-platform parity check (web-only feature)."
  "parity:mobile-only|C5DEF5|Skip cross-platform parity check (mobile-only feature)."
  "parity:desktop-only|C5DEF5|Skip cross-platform parity check (desktop-only feature)."
)

echo "Bootstrapping factory labels on $REPO ($(date '+%Y-%m-%d %H:%M:%S'))"
for entry in "${LABELS[@]}"; do
  IFS='|' read -r name color description <<<"$entry"
  if gh label create "$name" --repo "$REPO" --color "$color" --description "$description" --force >/dev/null 2>&1; then
    echo "  ok   $name"
  else
    echo "  FAIL $name" >&2
    exit 1
  fi
done
echo "Done."
