#!/bin/bash
# Generate release notes from conventional commits since the last mobile release tag.
# Usage: ./generate-release-notes.sh [--max-chars N]
#
# Output: plain text release notes suitable for Google Play (500 char limit)
# and TestFlight (4000 char limit).

set -euo pipefail

MAX_CHARS="${1:-500}"
if [[ "$1" == "--max-chars" ]]; then
  MAX_CHARS="${2:-500}"
fi

# Find the latest mobile release tag
LAST_TAG=$(git tag --list 'mobile@*' --sort=-v:refname | head -1)

if [[ -z "$LAST_TAG" ]]; then
  RANGE="HEAD"
else
  RANGE="${LAST_TAG}..HEAD"
fi

# Extract conventional commit subjects, grouped by type
FEATURES=$(git log "$RANGE" --oneline --no-merges --grep="^feat" --format="%s" -- apps/mobile/ packages/shared/ | sed 's/^feat[:(]//' | sed 's/^[^)]*) //' | sed 's/^: //')
FIXES=$(git log "$RANGE" --oneline --no-merges --grep="^fix" --format="%s" -- apps/mobile/ packages/shared/ | sed 's/^fix[:(]//' | sed 's/^[^)]*) //' | sed 's/^: //')

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

# Trim to max chars
NOTES="${NOTES:0:$MAX_CHARS}"

printf '%s' "$NOTES"
