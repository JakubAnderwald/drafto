#!/bin/bash
# Hook: Re-snapshot DB row counts AFTER a migration push and diff against
# the matching pre-snapshot. Always exits 0 — observability tool, not a
# guard. Migration is already done by the time this runs.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if ! echo "$COMMAND" | grep -qE '(^|[^[:alnum:]_])(supabase[[:space:]]+db[[:space:]]+(push|reset)|supabase[[:space:]]+migration[[:space:]]+up|pnpm[[:space:]]+supabase:push)([^[:alnum:]_]|$)'; then
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node "$REPO_ROOT/scripts/migration-stats.mjs" post || true
exit 0
