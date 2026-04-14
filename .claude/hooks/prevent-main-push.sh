#!/bin/bash
# Hook: Block git push to main unless the user explicitly asked for it.
# This prevents accidental pushes to main during iterative debugging sessions
# where changes accumulate without being branched first.

# Read tool input from stdin
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only check git push commands
if ! echo "$COMMAND" | grep -qE '^\s*(git push|git push )'; then
  exit 0
fi

# Check if pushing to main/master
BRANCH=$(git branch --show-current 2>/dev/null)
if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
  # Allow if explicitly pushing to a different branch (e.g., git push origin feature-branch)
  if echo "$COMMAND" | grep -qE 'git push.*(origin|upstream)\s+[^-]' && ! echo "$COMMAND" | grep -qE 'git push.*(origin|upstream)\s+(main|master|HEAD)'; then
    exit 0
  fi
  echo "Blocked: pushing to main. Create a branch first (CLAUDE.md requires worktree workflow). Use 'git checkout -b fix/description' or ask the user for permission." >&2
  exit 2
fi

exit 0
