#!/usr/bin/env bash
# check-migration-safety.sh — Scan Supabase migrations for destructive SQL patterns
# and for public tables / views the Data API can't reach.
# Exit 1 if any errors are found; warnings are informational only.
#
# Usage:
#   bash scripts/check-migration-safety.sh                 # check all migrations
#   bash scripts/check-migration-safety.sh path/to/file.sql  # check a single file
#
# The grants rule (scripts/lib/check-migration-grants.awk, ADR 0052) replays the
# checked files in apply order: a GRANT counts when it follows the CREATE in the same
# file or a later one, so checking one file requires the GRANT in that same file.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

ERRORS=0
WARNINGS=0

# Colors (disabled when not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  NC='\033[0m'
else
  RED=''
  YELLOW=''
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

echo ""
echo "Results: $ERRORS error(s), $WARNINGS warning(s)"

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "Fix errors above or add '-- safety:ignore' to suppress specific lines."
  if [ "$GRANT_ERRORS" -gt 0 ]; then
    echo "Data API grants: grant the table to the roles that use it, in the migration that creates it,"
    echo "e.g. grant select, insert, update, delete on table public.<name> to authenticated, service_role;"
    echo "Views also need 'with (security_invoker = true)'. Rules: docs/operations/migrations.md,"
    echo "\"New tables need explicit grants\" (a table kept off the Data API takes '-- safety:ignore')."
  fi
  exit 1
fi

exit 0
