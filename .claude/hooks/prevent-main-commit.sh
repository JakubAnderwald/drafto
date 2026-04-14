#!/bin/bash
# Hook: Block git commit on main unless the user explicitly asked for it.
# Forces the worktree/branch workflow required by CLAUDE.md.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only check git commit commands
if ! echo "$COMMAND" | grep -qE '^\s*git commit'; then
  exit 0
fi

BRANCH=$(git branch --show-current 2>/dev/null)
if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
  echo "Blocked: committing on main. CLAUDE.md requires working on a branch. Create one with 'git checkout -b fix/description' first." >&2
  exit 2
fi

exit 0
