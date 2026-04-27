#!/bin/bash
# Hook: Snapshot DB row counts BEFORE a migration push so we can diff after.
# Triggered for every Bash tool invocation; no-op unless the command actually
# runs a migration. Always exits 0 — observability tool, not a guard.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Match: `supabase db push`, `pnpm supabase:push`, `supabase migration up`,
# `supabase db reset`. Whitespace-tolerant; doesn't match arbitrary strings
# containing those substrings inside other args.
if ! echo "$COMMAND" | grep -qE '(^|[^[:alnum:]_])(supabase[[:space:]]+db[[:space:]]+(push|reset)|supabase[[:space:]]+migration[[:space:]]+up|pnpm[[:space:]]+supabase:push)([^[:alnum:]_]|$)'; then
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node "$REPO_ROOT/scripts/migration-stats.mjs" pre || true
exit 0
