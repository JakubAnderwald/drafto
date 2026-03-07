#!/usr/bin/env bash
# check-migration-safety.sh — Scan Supabase migrations for destructive SQL patterns.
# Exit 1 if any errors are found; warnings are informational only.
#
# Usage:
#   bash scripts/check-migration-safety.sh                 # check all migrations
#   bash scripts/check-migration-safety.sh path/to/file.sql  # check a single file

set -euo pipefail

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

# Determine which files to check
if [ $# -ge 1 ]; then
  FILES=("$@")
else
  FILES=()
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

echo ""
echo "Results: $ERRORS error(s), $WARNINGS warning(s)"

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "Fix errors above or add '-- safety:ignore' to suppress specific lines."
  exit 1
fi

exit 0
