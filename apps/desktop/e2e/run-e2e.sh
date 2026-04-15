#!/bin/bash
# Desktop macOS E2E Tests
# Uses AppleScript accessibility descriptions and cliclick for interactions.
# Elements are found by accessibilityLabel/description — not by index.
set -euo pipefail

# Check required dependencies
if ! command -v cliclick &> /dev/null; then
  echo "Error: cliclick is required but not installed."
  echo "Install with: brew install cliclick"
  exit 1
fi

PASS=0
FAIL=0
ERRORS=""

pass() {
  echo "  ✅ $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  ❌ $1: $2"
  FAIL=$((FAIL + 1))
  ERRORS="$ERRORS\n  ❌ $1: $2"
}

# ── Accessibility helpers ──────────────────────

get_element_count() {
  osascript -e '
  tell application "System Events"
    tell process "Drafto"
      return count of UI elements of window 1
    end tell
  end tell
  '
}

get_all_descs() {
  osascript -e '
  tell application "System Events"
    tell process "Drafto"
      set results to {}
      repeat with i from 1 to count of UI elements of window 1
        try
          set d to description of UI element i of window 1
          if d is not "" then
            set end of results to (i as text) & ":" & d
          end if
        end try
      end repeat
      return results
    end tell
  end tell
  '
}

# Find element index by its accessibility description (substring match)
find_element_by_desc() {
  local desc=$1
  osascript -e "
  tell application \"System Events\"
    tell process \"Drafto\"
      repeat with i from 1 to count of UI elements of window 1
        try
          set d to description of UI element i of window 1
          if d contains \"$desc\" then return i
        end try
      end repeat
      return 0
    end tell
  end tell
  " 2>/dev/null
}

# Click an element at the given index (center of its bounds)
click_element() {
  local idx=$1
  local pos
  pos=$(osascript -e "
  tell application \"System Events\"
    tell process \"Drafto\"
      set p to position of UI element $idx of window 1
      set s to size of UI element $idx of window 1
      set cx to (item 1 of p) + (item 1 of s) / 2
      set cy to (item 2 of p) + (item 2 of s) / 2
      return (cx as integer as text) & \",\" & (cy as integer as text)
    end tell
  end tell
  ")
  local x y
  x=$(echo "$pos" | cut -d',' -f1)
  y=$(echo "$pos" | cut -d',' -f2)
  cliclick "c:$x,$y"
}

# Find and click an element by its accessibility description
click_element_by_desc() {
  local desc=$1
  local idx
  idx=$(find_element_by_desc "$desc")
  if [ "$idx" -gt 0 ] 2>/dev/null; then
    click_element "$idx"
    return 0
  fi
  return 1
}

# Check if an element with the given description exists
has_element() {
  local desc=$1
  local idx
  idx=$(find_element_by_desc "$desc")
  [ "$idx" -gt 0 ] 2>/dev/null
}

wait_for_ui() {
  sleep "${E2E_UI_WAIT:-1.5}"
}

# ── Setup ──────────────────────────────────────

# Ensure Drafto is frontmost
osascript -e 'tell application "Drafto" to activate'
sleep 1

echo ""
echo "=== Drafto macOS E2E Tests ==="
echo ""

# ──────────────────────────────────────────────
echo "TEST 1: App is running and shows main screen"
# ──────────────────────────────────────────────
ELEM_COUNT=$(get_element_count)
if [ "$ELEM_COUNT" -gt 10 ]; then
  pass "App running with $ELEM_COUNT UI elements"
else
  fail "App main screen" "Only $ELEM_COUNT elements found"
fi

if has_element "Search"; then
  pass "Search button present"
else
  fail "Search button" "No element with description 'Search' found"
fi

if has_element "Add notebook"; then
  pass "Add notebook button present"
else
  fail "Add notebook button" "No element with description 'Add notebook' found"
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 2: Sidebar elements are present"
# ──────────────────────────────────────────────
if has_element "Trash"; then
  pass "Trash button visible in sidebar"
else
  fail "Trash button" "Not found in sidebar"
fi

if has_element "Sign out"; then
  pass "Sign out link visible"
else
  fail "Sign out link" "Not found"
fi

if has_element "Sync status"; then
  pass "Sync status button visible"
else
  fail "Sync status" "Not found"
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 3: Select a notebook"
# ──────────────────────────────────────────���───
# Find the first notebook by looking for elements that are NOT known sidebar controls
FIRST_NB_IDX=$(osascript -e '
tell application "System Events"
  tell process "Drafto"
    set knownDescs to {"Search", "Add notebook", "Trash", "Sign out", "Sync status", "Drafto", "+ New Note"}
    repeat with i from 1 to count of UI elements of window 1
      try
        set d to description of UI element i of window 1
        if d is not "" and d is not in knownDescs then
          return i
        end if
      end try
    end repeat
    return 0
  end tell
end tell
' 2>/dev/null)

if [ "$FIRST_NB_IDX" -gt 0 ] 2>/dev/null; then
  click_element "$FIRST_NB_IDX"
  wait_for_ui

  screencapture -x /tmp/drafto_e2e_notebook_click.png

  # After selecting a notebook, the "+ New Note" button should appear
  if has_element "+ New Note"; then
    pass "Note list panel appeared after notebook selection"
  else
    NEW_COUNT=$(get_element_count)
    if [ "$NEW_COUNT" -ne "$ELEM_COUNT" ]; then
      pass "UI changed after notebook click ($ELEM_COUNT -> $NEW_COUNT elements)"
    else
      fail "Notebook selection" "No visible change after clicking notebook"
    fi
  fi
else
  fail "Notebook selection" "Could not find any notebook element in sidebar"
fi

# ────────────────────────────────────────��─────
echo ""
echo "TEST 4: Create a new notebook"
# ──────────────────────────────────────────────
BEFORE_COUNT=$(get_element_count)

if click_element_by_desc "Add notebook"; then
  wait_for_ui
  sleep 1

  AFTER_COUNT=$(get_element_count)
  if [ "$AFTER_COUNT" -ne "$BEFORE_COUNT" ]; then
    pass "Create notebook form appeared (element count: $BEFORE_COUNT -> $AFTER_COUNT)"
  else
    fail "Create notebook" "No change after clicking Add notebook"
  fi
else
  fail "Create notebook" "Could not find 'Add notebook' button"
fi

screencapture -x /tmp/drafto_e2e_new_notebook.png

# ──────────────────────────────────────────────
echo ""
echo "TEST 5: Create a new note"
# ──────────────────────────────────────────────
# Press Escape first to dismiss any open create-notebook input
cliclick kp:esc
wait_for_ui

if has_element "+ New Note"; then
  BEFORE_NOTE_COUNT=$(get_element_count)
  click_element_by_desc "+ New Note"
  wait_for_ui
  sleep 1

  AFTER_NOTE_COUNT=$(get_element_count)
  AFTER_DESCS=$(get_all_descs)

  screencapture -x /tmp/drafto_e2e_new_note.png

  if echo "$AFTER_DESCS" | grep -qi "Untitled\|Saved\|No content"; then
    pass "New note created and visible in note list"
  elif [ "$AFTER_NOTE_COUNT" -ne "$BEFORE_NOTE_COUNT" ]; then
    pass "New note created (element count: $BEFORE_NOTE_COUNT -> $AFTER_NOTE_COUNT)"
  else
    fail "Create note" "No visible change after clicking + New Note"
  fi
else
  fail "Create note" "Could not find '+ New Note' button — is a notebook selected?"
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 6: Search functionality"
# ──────────────────────────────────────────────
PRE_SEARCH_COUNT=$(get_element_count)

if click_element_by_desc "Search"; then
  sleep 2

  screencapture -x /tmp/drafto_e2e_search.png

  SEARCH_ELEM_COUNT=$(get_element_count)
  if [ "$SEARCH_ELEM_COUNT" -ne "$PRE_SEARCH_COUNT" ]; then
    pass "Search overlay opened"

    # Type a search query
    cliclick t:"test"
    sleep 1
    screencapture -x /tmp/drafto_e2e_search_typed.png
    pass "Search query typed"

    # Close search with Escape
    cliclick kp:esc
    sleep 1
  else
    fail "Search" "No UI change after clicking Search button"
  fi
else
  fail "Search" "Could not find 'Search' button"
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 7: Sync status check"
# ────────────────────────────────────────────��─
wait_for_ui

if has_element "Sync status"; then
  pass "Sync status element present"
else
  # Fallback: search the full accessibility tree
  SYNC_DESCS=$(get_all_descs)
  if echo "$SYNC_DESCS" | grep -qi "sync\|Synced\|pending\|Syncing"; then
    SYNC_MATCH=$(echo "$SYNC_DESCS" | tr ',' '\n' | grep -i "sync" | head -1)
    pass "Sync status found ($SYNC_MATCH)"
  else
    fail "Sync status" "No sync-related element found"
  fi
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 8: Window management"
# ──────────────────────────────────────────────
WIN_INFO=$(osascript -e '
tell application "System Events"
  tell process "Drafto"
    set s to size of window 1
    return (item 1 of s as text) & "x" & (item 2 of s as text)
  end tell
end tell
')
WIDTH=$(echo "$WIN_INFO" | cut -d'x' -f1)
HEIGHT=$(echo "$WIN_INFO" | cut -d'x' -f2)

if [ "$WIDTH" -ge 800 ] && [ "$HEIGHT" -ge 500 ]; then
  pass "Window size is reasonable (${WIN_INFO})"
else
  fail "Window size" "Too small: ${WIN_INFO}"
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 9: Metro bundler connection"
# ──────────────────────────────────────────────
METRO_PID=$(lsof -ti :8081 2>/dev/null | head -1)
if [ -n "$METRO_PID" ]; then
  pass "Metro bundler running on port 8081 (PID: $METRO_PID)"
else
  fail "Metro bundler" "Not running on port 8081"
fi

METRO_STATUS=$(curl -s http://localhost:8081/status 2>/dev/null || echo "unreachable")
if [[ "$METRO_STATUS" == *"packager-status:running"* ]]; then
  pass "Metro bundler is healthy"
else
  fail "Metro health" "Status: $METRO_STATUS"
fi

# ──────────────────────────────────────────────
echo ""
echo "=== Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  echo -e "$ERRORS"
fi
echo ""

exit $FAIL
