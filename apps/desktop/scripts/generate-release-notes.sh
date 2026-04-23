#!/bin/bash
# Generate release notes from conventional commits since the last desktop release tag.
# Usage: ./generate-release-notes.sh [--max-chars N]
#
# Output: plain text release notes suitable for TestFlight (4000 char limit).

set -euo pipefail

MAX_CHARS=4000
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-chars)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ ]]; then
        echo "Usage: $0 [--max-chars N]" >&2
        exit 1
      fi
      MAX_CHARS="$2"
      shift 2
      ;;
    *) shift ;;
  esac
done

# Run from repo root so `git log -- apps/desktop/ packages/shared/` pathspecs
# resolve correctly regardless of where fastlane invoked us (it calls this
# script from `apps/desktop/`, which would make the pathspec look for
# `apps/desktop/apps/desktop/` and silently match nothing).
cd "$(git rev-parse --show-toplevel)"

# Find the latest desktop release tag.
# If the latest tag points to HEAD (just created by the tag job), use the
# previous tag so the range covers the actual changes in this release.
LAST_TAG=$(git tag --list 'desktop@*' --sort=-v:refname | head -1)

if [[ -n "$LAST_TAG" ]]; then
  TAG_COMMIT=$(git rev-parse "$LAST_TAG" 2>/dev/null || true)
  HEAD_COMMIT=$(git rev-parse HEAD)
  if [[ "$TAG_COMMIT" == "$HEAD_COMMIT" ]]; then
    LAST_TAG=$(git tag --list 'desktop@*' --sort=-v:refname | sed -n '2p')
  fi
fi

if [[ -z "$LAST_TAG" ]]; then
  RANGE="HEAD"
else
  RANGE="${LAST_TAG}..HEAD"
fi

# Extract conventional commit subjects, grouped by type
FEATURES=$(git log "$RANGE" --oneline --no-merges --grep="^feat" --format="%s" -- apps/desktop/ packages/shared/ | sed -E 's/^feat(\([^)]+\))?!?:[[:space:]]*//')
FIXES=$(git log "$RANGE" --oneline --no-merges --grep="^fix" --format="%s" -- apps/desktop/ packages/shared/ | sed -E 's/^fix(\([^)]+\))?!?:[[:space:]]*//')

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
  COMMIT_COUNT=$(git log "$RANGE" --oneline --no-merges -- apps/desktop/ packages/shared/ | wc -l | tr -d ' ')
  if [[ "$COMMIT_COUNT" -gt 0 ]]; then
    NOTES="Bug fixes and improvements."
  else
    NOTES="Maintenance update."
  fi
fi

# Trim to max chars
NOTES="${NOTES:0:$MAX_CHARS}"

printf '%s' "$NOTES"
