#!/bin/bash
# Hook: Block a git push that would land on a protected branch (main/master),
# unless the user explicitly asked for it. Enforces the worktree/branch workflow
# required by CLAUDE.md.
#
# Thin wrapper on purpose. The judgement is in scripts/git-guard.mjs, which parses
# the command instead of pattern-matching it — see docs/operations/claude-code-hooks.md.
# Self-locating via "$0", so it does not care what $CLAUDE_PROJECT_DIR happens to be.

INPUT=$(cat)

# Cheap prefilter: most Bash calls have nothing to do with git, and this keeps
# node out of that path entirely.
case "$INPUT" in
  *git*) ;;
  *) exit 0 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/git-guard.mjs"

# Fail closed. Claude Code treats ONLY exit 2 as blocking: a missing node exits
# 127 and a missing module exits 1, both of which would wave the command through
# with no guard at all. A guard that cannot run must block, not abstain.
if ! command -v node >/dev/null 2>&1; then
  echo "Blocked: node not found, so the push guard cannot run." >&2
  exit 2
fi
if [ ! -f "$GUARD" ]; then
  echo "Blocked: $GUARD is missing, so the push guard cannot run." >&2
  exit 2
fi

printf '%s' "$INPUT" | node "$GUARD" push
