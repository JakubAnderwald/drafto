#!/bin/bash
# Generate release notes from conventional commits since the last mobile release tag.
# Usage: ./generate-release-notes.sh [--max-chars N]
#
# Output: plain text release notes suitable for Google Play (500 char limit)
# and TestFlight (4000 char limit).

set -euo pipefail

MAX_CHARS=500
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-chars) MAX_CHARS="${2:-500}"; shift 2 ;;
    *) shift ;;
  esac
done

# Run from repo root so `git log -- apps/mobile/ packages/shared/` pathspecs
# resolve correctly regardless of where fastlane invoked us (it calls this
# script from `apps/mobile/`, which would make the pathspec look for
# `apps/mobile/apps/mobile/` and silently match nothing).
cd "$(git rev-parse --show-toplevel)"

# Find the latest mobile release tag.
# If the latest tag points to HEAD (just created by the tag job), use the
# previous tag so the range covers the actual changes in this release.
LAST_TAG=$(git tag --list 'mobile@*' --sort=-v:refname | head -1)

if [[ -n "$LAST_TAG" ]]; then
  TAG_COMMIT=$(git rev-parse "$LAST_TAG" 2>/dev/null || true)
  HEAD_COMMIT=$(git rev-parse HEAD)
  if [[ "$TAG_COMMIT" == "$HEAD_COMMIT" ]]; then
    LAST_TAG=$(git tag --list 'mobile@*' --sort=-v:refname | sed -n '2p')
  fi
fi

if [[ -z "$LAST_TAG" ]]; then
  RANGE="HEAD"
else
  RANGE="${LAST_TAG}..HEAD"
fi

# Extract conventional commit subjects, grouped by type.
#
# Classify from the SUBJECT ONLY, in one pass per bucket. Two bugs this closes,
# both seen in real TestFlight notes:
#
#   1. `git log --grep` matches the WHOLE commit message, and `^` anchors at the
#      start of every line in the body — not the subject. A commit whose body
#      merely wrapped onto a line beginning "fix" was pulled into Bug fixes:
#      d951b75 ("feat(factory): …") appeared in BOTH lists because line 39 of its
#      body wrapped to "fix is observable, plus what failure looks like…".
#      Filtering the subjects here makes the buckets mutually exclusive — a
#      subject can only start with one prefix.
#
#   2. The old three-`sed` pipeline mangled every scoped commit:
#      `feat(web): export notebooks` → `web): export notebooks`, because the
#      second sed needed ") " (paren-space) and the real text has "): ".
#      `feat: add X` kept its leading space. One anchored regex handles both.
#
# `sed -n …p` filters and strips together, so a line can never be emitted with
# its prefix intact — the failure mode that put "feat(factory): …" under
# "Bug fixes" in build 32's notes.
SUBJECTS=$(git log "$RANGE" --no-merges --format="%s" -- apps/mobile/ packages/shared/)
FEATURES=$(printf '%s\n' "$SUBJECTS" | sed -nE 's/^feat(\([^)]+\))?!?:[[:space:]]*//p')
FIXES=$(printf '%s\n' "$SUBJECTS" | sed -nE 's/^fix(\([^)]+\))?!?:[[:space:]]*//p')

NOTES=""

if [[ -n "$FEATURES" ]]; then
  NOTES+="What's new:"$'\n'
  while IFS= read -r line; do
    NOTES+="- ${line}"$'\n'
  done <<< "$FEATURES"
fi

if [[ -n "$FIXES" ]]; then
  if [[ -n "$NOTES" ]]; then
    NOTES+=$'\n'
  fi
  NOTES+="Bug fixes:"$'\n'
  while IFS= read -r line; do
    NOTES+="- ${line}"$'\n'
  done <<< "$FIXES"
fi

# Fallback if no conventional commits found
if [[ -z "$NOTES" ]]; then
  COMMIT_COUNT=$(git log "$RANGE" --oneline --no-merges -- apps/mobile/ packages/shared/ | wc -l | tr -d ' ')
  if [[ "$COMMIT_COUNT" -gt 0 ]]; then
    NOTES="Bug fixes and improvements."
  else
    NOTES="Maintenance update."
  fi
fi

# Pre-merge test build (factory In Test dispatch): stamp the card it belongs to
# so a tester can tell which build corresponds to which issue, and so nobody
# mistakes an unmerged branch build for a release candidate. Prepended BEFORE the
# trim so the identifier survives Google Play's 500-char cap. No-op when unset.
if [[ -n "${DRAFTO_INTEST_ISSUE:-}" ]]; then
  INTEST_SHA="${DRAFTO_INTEST_SHA:-unknown}"
  NOTES="PRE-MERGE TEST BUILD — issue #${DRAFTO_INTEST_ISSUE} / PR #${DRAFTO_INTEST_PR:-?} (${INTEST_SHA:0:12})"$'\n\n'"$NOTES"
fi

# Trim to max chars
NOTES="${NOTES:0:$MAX_CHARS}"

printf '%s' "$NOTES"
