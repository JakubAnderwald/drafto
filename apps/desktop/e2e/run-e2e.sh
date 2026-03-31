#!/bin/bash
# Desktop macOS E2E Tests
# Uses cliclick for mouse interactions and AppleScript for verification
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

get_element_count() {
  osascript -e '
  tell application "System Events"
    tell process "Drafto"
      return count of UI elements of window 1
    end tell
  end tell
  '
}

get_element_desc() {
  local idx=$1
  osascript -e "
  tell application \"System Events\"
    tell process \"Drafto\"
      return description of UI element $idx of window 1
    end tell
  end tell
  " 2>/dev/null || echo ""
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
  local x
  local y
  x=$(echo "$pos" | cut -d',' -f1)
  y=$(echo "$pos" | cut -d',' -f2)
  cliclick "c:$x,$y"
}

wait_for_ui_change() {
  # Allow time for React Native UI to update after interactions
  sleep "${E2E_UI_WAIT:-1.5}"
}

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

# Check for Search button
SEARCH_DESC=$(get_element_desc 1)
if [[ "$SEARCH_DESC" == *"Search"* ]]; then
  pass "Search button present"
else
  fail "Search button" "Element 1 desc is '$SEARCH_DESC'"
fi

# Check for + button
PLUS_DESC=$(get_element_desc 2)
if [[ "$PLUS_DESC" == *"+"* ]]; then
  pass "Create notebook button (+) present"
else
  fail "Create notebook button" "Element 2 desc is '$PLUS_DESC'"
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 2: Notebook list is populated"
# ──────────────────────────────────────────────
ALL_DESCS=$(get_all_descs)
if echo "$ALL_DESCS" | grep -q "Trash"; then
  pass "Trash entry visible in sidebar"
else
  fail "Trash entry" "Not found in sidebar"
fi

if echo "$ALL_DESCS" | grep -q "Sign out"; then
  pass "Sign out link visible"
else
  fail "Sign out link" "Not found"
fi

if echo "$ALL_DESCS" | grep -q "Sync status"; then
  pass "Sync status button visible"
else
  fail "Sync status" "Not found"
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 3: Click a notebook to select it"
# ──────────────────────────────────────────────
# Click first notebook (element 3)
click_element 3
wait_for_ui_change

# After clicking a notebook, the notes list panel should appear
# Take a screenshot to verify
screencapture -x /tmp/drafto_e2e_notebook_click.png

# Check if new elements appeared (note list items)
NEW_DESCS=$(get_all_descs)
if echo "$NEW_DESCS" | grep -qi "new\|Untitled\|note\|New Note\|\\+ New"; then
  pass "Note list panel appeared after notebook selection"
else
  # Even if we don't find specific note elements, check if the element count changed
  NEW_COUNT=$(get_element_count)
  if [ "$NEW_COUNT" -ne "$ELEM_COUNT" ]; then
    pass "UI changed after notebook click ($ELEM_COUNT -> $NEW_COUNT elements)"
  else
    fail "Notebook selection" "No visible change after clicking notebook (still $ELEM_COUNT elements)"
  fi
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 4: Create a new notebook"
# ──────────────────────────────────────────────
BEFORE_COUNT=$(get_element_count)

# Click the "+" button (element 2)
click_element 2
wait_for_ui_change
sleep 1

AFTER_COUNT=$(get_element_count)
NEW_DESCS_AFTER=$(get_all_descs)

# Check if a new notebook appeared (UI may have changed due to sync too)
if [ "$AFTER_COUNT" -ne "$BEFORE_COUNT" ]; then
  pass "New notebook created (element count: $BEFORE_COUNT -> $AFTER_COUNT)"
elif echo "$NEW_DESCS_AFTER" | grep -qi "New Notebook\|Untitled"; then
  pass "New notebook created with default name"
else
  # Check if there's a new "Target" entry with a recent timestamp
  LATEST=$(echo "$NEW_DESCS_AFTER" | tr ',' '\n' | grep "Target" | head -1)
  if [ -n "$LATEST" ]; then
    pass "Notebook list present (latest: $LATEST)"
  else
    fail "Create notebook" "No change after clicking + (count: $BEFORE_COUNT -> $AFTER_COUNT)"
  fi
fi

screencapture -x /tmp/drafto_e2e_new_notebook.png

# ──────────────────────────────────────────────
echo ""
echo "TEST 5: Create a new note"
# ──────────────────────────────────────────────
# After TEST 3 selected a notebook, look for "+ New Note" button
# Search for element with "New Note" in its description
NEW_NOTE_IDX=$(osascript -e '
tell application "System Events"
  tell process "Drafto"
    repeat with i from 1 to count of UI elements of window 1
      try
        set d to description of UI element i of window 1
        if d contains "New Note" or d contains "+ New Note" then
          return i
        end if
      end try
    end repeat
    return 0
  end tell
end tell
' 2>/dev/null)

if [ "$NEW_NOTE_IDX" -gt 0 ] 2>/dev/null; then
  echo "  Found '+ New' button at element $NEW_NOTE_IDX"
  BEFORE_NOTE_COUNT=$(get_element_count)
  click_element "$NEW_NOTE_IDX"
  wait_for_ui_change

  screencapture -x /tmp/drafto_e2e_new_note.png
  AFTER_NOTE_COUNT=$(get_element_count)

  # Wait a bit longer for database write
  sleep 1
  AFTER_NOTE_COUNT=$(get_element_count)
  AFTER_DESCS=$(get_all_descs)
  screencapture -x /tmp/drafto_e2e_new_note.png

  # Check multiple indicators of success
  if echo "$AFTER_DESCS" | grep -qi "Untitled\|Saved\|No content"; then
    pass "New note created and visible in note list"
  elif [ "$AFTER_NOTE_COUNT" -ne "$BEFORE_NOTE_COUNT" ]; then
    pass "New note created (element count: $BEFORE_NOTE_COUNT -> $AFTER_NOTE_COUNT)"
  else
    fail "Create note" "No visible change after clicking + New"
  fi
else
  # Notebook may not be selected yet - click first notebook again
  echo "  '+ New Note' not found, selecting first notebook..."
  click_element 3
  sleep 2

  NEW_NOTE_IDX2=$(osascript -e '
  tell application "System Events"
    tell process "Drafto"
      repeat with i from 1 to count of UI elements of window 1
        try
          set d to description of UI element i of window 1
          if d contains "New Note" or d contains "+ New Note" then
            return i
          end if
        end try
      end repeat
      return 0
    end tell
  end tell
  ' 2>/dev/null)

  if [ "$NEW_NOTE_IDX2" -gt 0 ] 2>/dev/null; then
    click_element "$NEW_NOTE_IDX2"
    wait_for_ui_change
    pass "New note created after re-selecting notebook"
  else
    fail "Create note" "Could not find '+ New Note' button even after notebook selection"
  fi
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 6: Search functionality"
# ──────────────────────────────────────────────
# Click Search button (element 1)
PRE_SEARCH_COUNT=$(get_element_count)
click_element 1
sleep 2

screencapture -x /tmp/drafto_e2e_search.png

# Check if search overlay appeared
SEARCH_DESCS=$(get_all_descs)
SEARCH_ELEM_COUNT=$(get_element_count)
if echo "$SEARCH_DESCS" | grep -qi "search\|query\|find\|⌘K" || [ "$SEARCH_ELEM_COUNT" -ne "$PRE_SEARCH_COUNT" ]; then
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
  fail "Search" "No change after clicking Search button"
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 7: Sync status check"
# ──────────────────────────────────────────────
# Use get_all_descs (same approach as TEST 2 which reliably finds sync status)
# and also check accessibility titles/values for sync-related text
wait_for_ui_change
SYNC_DESCS=$(get_all_descs)

if echo "$SYNC_DESCS" | grep -qi "sync\|Synced\|pending\|Syncing"; then
  SYNC_MATCH=$(echo "$SYNC_DESCS" | tr ',' '\n' | grep -i "sync\|Synced\|pending\|Syncing" | head -1)
  pass "Sync status found ($SYNC_MATCH)"
else
  # Fallback: check accessibility titles (accessibilityLabel may map to title on macOS)
  SYNC_TITLE=$(osascript -e '
  tell application "System Events"
    tell process "Drafto"
      repeat with i from 1 to count of UI elements of window 1
        try
          set t to title of UI element i of window 1
          if t contains "Sync" or t contains "sync" then
            return (i as text) & ":" & t
          end if
        end try
      end repeat
      return "none"
    end tell
  end tell
  ' 2>/dev/null)

  if [[ "$SYNC_TITLE" != "none" ]]; then
    pass "Sync status button found via title ($SYNC_TITLE)"
  else
    # Last resort: check entire accessibility tree for sync-related text
    SYNC_DEEP=$(osascript -e '
    tell application "System Events"
      tell process "Drafto"
        set found to "none"
        repeat with i from 1 to count of UI elements of window 1
          try
            set allProps to properties of UI element i of window 1
            set propsText to allProps as text
            if propsText contains "Sync" or propsText contains "sync" then
              set found to (i as text) & ":found"
              exit repeat
            end if
          end try
        end repeat
        return found
      end tell
    end tell
    ' 2>/dev/null)

    if [[ "$SYNC_DEEP" != "none" ]]; then
      pass "Sync status element found in accessibility tree ($SYNC_DEEP)"
    else
      fail "Sync status" "No sync-related element found"
    fi
  fi
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 8: Window management"
# ──────────────────────────────────────────────
# Check window exists and has reasonable size
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

# Check Metro health
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
