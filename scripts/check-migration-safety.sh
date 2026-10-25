#!/usr/bin/env bash
# check-migration-safety.sh — Scan Supabase migrations for destructive SQL patterns
# and for public tables / views the Data API can't reach.
# Exit 1 if any errors are found; warnings are informational only.
#
# Usage:
#   bash scripts/check-migration-safety.sh                 # check all migrations + new-version order
#   bash scripts/check-migration-safety.sh path/to/file.sql  # check a single file (no order rule)
#
# The grants rule (scripts/lib/check-migration-grants.awk, ADR 0052) replays the
# checked files in apply order: a GRANT counts when it follows the CREATE in the same
# file or a later one, so checking one file requires the GRANT in that same file.
#
# The order rule (scripts/lib/check-migration-order.mjs, ADR 0057) runs only when no
# paths are given. It fails a migration this checkout ADDS relative to a base commit
# when its version is not newer than the base's newest migration, because
# `supabase db push` refuses to insert it. The base is $MIGRATION_BASE_REF (CI sets it
# to the PR's base commit; an empty value counts as unset), else origin/main; with
# neither, or outside a git work tree, the rule is skipped with a note.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

ERRORS=0
WARNINGS=0

# Colors (disabled when not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  DIM='\033[2m'
  NC='\033[0m'
else
  RED=''
  YELLOW=''
  DIM=''
  NC=''
fi

check_file() {
  local file="$1"
  local line_num=0

  # Read all lines into an array for lookahead
  local -a lines=()
  while IFS= read -r l || [ -n "$l" ]; do
    lines+=("$l")
  done < "$file"

  local total=${#lines[@]}

  for ((i = 0; i < total; i++)); do
    line="${lines[$i]}"
    line_num=$((i + 1))

    # Skip lines with safety:ignore comment
    if echo "$line" | grep -q -- '-- safety:ignore'; then
      continue
    fi

    # Skip SQL comment-only lines
    if echo "$line" | grep -qE '^\s*--'; then
      continue
    fi

    # Normalize to uppercase for matching
    upper=$(echo "$line" | tr '[:lower:]' '[:upper:]')

    # --- ERRORS (exit 1) ---

    # DROP TABLE without IF EXISTS
    if echo "$upper" | grep -qE 'DROP\s+TABLE' && ! echo "$upper" | grep -qE 'DROP\s+TABLE\s+IF\s+EXISTS'; then
      echo -e "${RED}ERROR${NC}  $file:$line_num — DROP TABLE without IF EXISTS"
      echo "        $line"
      ERRORS=$((ERRORS + 1))
    fi

    # TRUNCATE
    if echo "$upper" | grep -qE '^\s*TRUNCATE\s'; then
      echo -e "${RED}ERROR${NC}  $file:$line_num — TRUNCATE statement"
      echo "        $line"
      ERRORS=$((ERRORS + 1))
    fi

    # DELETE FROM without WHERE (check current line and next line for multi-line statements)
    if echo "$upper" | grep -qE 'DELETE\s+FROM' && ! echo "$upper" | grep -qiE 'WHERE'; then
      local next_upper=""
      if [ $((i + 1)) -lt "$total" ]; then
        next_upper=$(echo "${lines[$((i + 1))]}" | tr '[:lower:]' '[:upper:]')
      fi
      if ! echo "$next_upper" | grep -qE '^\s*WHERE'; then
        echo -e "${RED}ERROR${NC}  $file:$line_num — DELETE FROM without WHERE clause"
        echo "        $line"
        ERRORS=$((ERRORS + 1))
      fi
    fi

    # DROP SCHEMA
    if echo "$upper" | grep -qE 'DROP\s+SCHEMA'; then
      echo -e "${RED}ERROR${NC}  $file:$line_num — DROP SCHEMA"
      echo "        $line"
      ERRORS=$((ERRORS + 1))
    fi

    # --- WARNINGS ---

    # DROP TABLE IF EXISTS (safer but still notable)
    if echo "$upper" | grep -qE 'DROP\s+TABLE\s+IF\s+EXISTS'; then
      echo -e "${YELLOW}WARN${NC}   $file:$line_num — DROP TABLE IF EXISTS (review carefully)"
      echo "        $line"
      WARNINGS=$((WARNINGS + 1))
    fi

    # DROP COLUMN
    if echo "$upper" | grep -qE 'DROP\s+COLUMN'; then
      echo -e "${YELLOW}WARN${NC}   $file:$line_num — DROP COLUMN (data loss possible)"
      echo "        $line"
      WARNINGS=$((WARNINGS + 1))
    fi

    # ALTER TABLE ... RENAME
    if echo "$upper" | grep -qE 'ALTER\s+TABLE.*RENAME'; then
      echo -e "${YELLOW}WARN${NC}   $file:$line_num — ALTER TABLE RENAME (may break queries)"
      echo "        $line"
      WARNINGS=$((WARNINGS + 1))
    fi

    # DROP POLICY
    if echo "$upper" | grep -qE 'DROP\s+POLICY'; then
      echo -e "${YELLOW}WARN${NC}   $file:$line_num — DROP POLICY (review RLS impact)"
      echo "        $line"
      WARNINGS=$((WARNINGS + 1))
    fi

  done
}

# Determine which files to check. Explicit paths are sorted by file name: migration
# names start with a timestamp, and the grants rule replays them in apply order.
FILES=()
if [ $# -ge 1 ]; then
  while IFS= read -r f; do
    FILES+=("$f")
  done < <(for f in "$@"; do printf '%s\t%s\n' "$(basename "$f")" "$f"; done | sort | cut -f2-)
else
  for f in supabase/migrations/*.sql; do
    [ -e "$f" ] && FILES+=("$f")
  done
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No migration files found."
  exit 0
fi

echo "Checking ${#FILES[@]} migration file(s)..."
echo ""

for file in "${FILES[@]}"; do
  check_file "$file"
done

# Data API grants: one ordered pass over the whole set. Captured rather than piped so
# an awk failure stops the script (set -e) instead of reading as "no findings".
GRANT_ERRORS=0
GRANT_FINDINGS=$(awk -f "$SCRIPT_DIR/lib/check-migration-grants.awk" "${FILES[@]}")
while IFS=$'\t' read -r location message statement; do
  [ -n "$location" ] || continue
  echo -e "${RED}ERROR${NC}  $location — $message"
  echo "        $statement"
  GRANT_ERRORS=$((GRANT_ERRORS + 1))
done <<< "$GRANT_FINDINGS"
ERRORS=$((ERRORS + GRANT_ERRORS))

# Migration order (repo mode only): a migration this checkout adds must sort after the
# base's newest one. ORDER_ERRORS are stale versions; ORDER_SETUP_ERRORS mean the rule
# could not run although CI asked for it, so a bad base never reads as a pass.
ORDER_ERRORS=0
ORDER_SETUP_ERRORS=0
order_check() {
  local base="${MIGRATION_BASE_REF:-}" findings
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo -e "${DIM}Migration order check skipped (no base ref: not inside a git work tree).${NC}"
    return 0
  fi
  if [ -n "$base" ]; then
    if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
      echo -e "${RED}ERROR${NC}  MIGRATION_BASE_REF=$base does not resolve to a commit — fetch it, or unset it to use origin/main"
      ORDER_SETUP_ERRORS=$((ORDER_SETUP_ERRORS + 1))
      return 0
    fi
  elif git rev-parse --verify --quiet "origin/main^{commit}" >/dev/null; then
    base="origin/main"
  else
    echo -e "${DIM}Migration order check skipped (no base ref: set MIGRATION_BASE_REF or fetch origin/main).${NC}"
    return 0
  fi
  echo "Checking migration order against $base..."
  if ! findings=$(node "$SCRIPT_DIR/lib/check-migration-order.mjs" --base "$base" --dir supabase/migrations); then
    echo -e "${RED}ERROR${NC}  migration order check failed to run against $base (see the message above)"
    ORDER_SETUP_ERRORS=$((ORDER_SETUP_ERRORS + 1))
    return 0
  fi
  while IFS=$'\t' read -r location message rename; do
    [ -n "$location" ] || continue
    echo -e "${RED}ERROR${NC}  $location — $message"
    echo "        $rename"
    ORDER_ERRORS=$((ORDER_ERRORS + 1))
  done <<< "$findings"
}
if [ $# -eq 0 ]; then
  order_check
fi
ERRORS=$((ERRORS + ORDER_ERRORS + ORDER_SETUP_ERRORS))

echo ""
echo "Results: $ERRORS error(s), $WARNINGS warning(s)"

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  if [ "$ERRORS" -gt $((ORDER_ERRORS + ORDER_SETUP_ERRORS)) ]; then
    echo "Fix errors above or add '-- safety:ignore' to suppress specific lines."
  fi
  if [ "$ORDER_ERRORS" -gt 0 ]; then
    echo "Migration order: a new migration must sort after every migration on the base branch, or"
    echo "'supabase db push' refuses it once the newer one is applied. Rename it with the git mv shown,"
    echo "then update every reference to the old version (git grep <old version>). If the old version"
    echo "was already pushed to dev, record the rename there with the repair recipe in"
    echo "docs/operations/migrations.md, \"Migration versions must sort last\". If the flagged file came"
    echo "from main rather than this branch, your origin/main is stale: git fetch origin main."
  fi
  if [ "$GRANT_ERRORS" -gt 0 ]; then
    echo "Data API grants: grant the table to the roles that use it, in the migration that creates it,"
    echo "e.g. grant select, insert, update, delete on table public.<name> to authenticated, service_role;"
    echo "Views also need 'with (security_invoker = true)'. Rules: docs/operations/migrations.md,"
    echo "\"New tables need explicit grants\" (a table kept off the Data API takes '-- safety:ignore')."
  fi
  exit 1
fi

exit 0
