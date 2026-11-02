#!/bin/bash
# Accessibility helpers for driving the Drafto macOS app from shell scripts.
# Elements are found by accessibilityLabel/description (System Events), not by
# index, and clicked at their centre with cliclick. Sourced by e2e/run-e2e.sh
# and store/screenshots/generate-macos.sh.

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

