#!/bin/bash
# Accessibility helpers for driving the Drafto macOS app from shell scripts.
# Elements are found by accessibilityLabel/description (System Events), not by
# index, and clicked at their centre with cliclick. Sourced by e2e/run-e2e.sh
# and store/screenshots/generate-macos.sh.
#
# A ScrollView is a scroll area in the accessibility tree, and its rows are
# children of that scroll area, not of the window: the sidebar's notebooks, the
# note list's notes and the trash list's notes. Window-level controls (Search,
# New notebook, Trash, Sync status, App menu, New note…) stay direct children
# of window 1. The lookups below search both.

get_element_count() {
  osascript -e '
  tell application "System Events"
    tell process "Drafto"
      return count of UI elements of window 1
    end tell
  end tell
  '
}

# "<i>:<desc>" for each described direct child of window 1, then
# "<k>.<j>:<desc>" for each described row j of scroll area k.
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
      repeat with k from 1 to count of scroll areas of window 1
        try
          set areaItems to UI elements of scroll area k of window 1
          repeat with j from 1 to count of areaItems
            try
              set d to description of item j of areaItems
              if d is not "" then
                set end of results to (k as text) & "." & (j as text) & ":" & d
              end if
            end try
          end repeat
        end try
      end repeat
      return results
    end tell
  end tell
  '
}

# Find a direct child of window 1 by its accessibility description (substring
# match) and print its index, or 0. Rows inside a scroll area are not searched:
# use find_element_center_by_desc for those.
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

# Print the centre ("x,y") of the first element whose accessibility description
# contains $1, or nothing. Searches the direct children of window 1 first, then
# the rows of each scroll area. A row scrolled out of its scroll area's visible
# frame is skipped: a click at its centre would land on whatever is drawn there.
find_element_center_by_desc() {
  local desc=$1
  osascript -e "
  tell application \"System Events\"
    tell process \"Drafto\"
      repeat with el in (UI elements of window 1)
        try
          if description of el contains \"$desc\" then
            set p to position of el
            set s to size of el
            set cx to (item 1 of p) + (item 1 of s) / 2
            set cy to (item 2 of p) + (item 2 of s) / 2
            return (cx as integer as text) & \",\" & (cy as integer as text)
          end if
        end try
      end repeat
      repeat with sa in (scroll areas of window 1)
        try
          set topEdge to item 2 of (position of sa)
          set bottomEdge to topEdge + (item 2 of (size of sa))
          repeat with el in (UI elements of sa)
            try
              if role of el is not \"AXScrollBar\" and description of el contains \"$desc\" then
                set p to position of el
                set s to size of el
                set cx to (item 1 of p) + (item 1 of s) / 2
                set cy to (item 2 of p) + (item 2 of s) / 2
                if cy > topEdge and cy < bottomEdge then
                  return (cx as integer as text) & \",\" & (cy as integer as text)
                end if
              end if
            end try
          end repeat
        end try
      end repeat
      return \"\"
    end tell
  end tell
  " 2>/dev/null || true
}

# Print the index (among window 1's scroll areas) of the list under the
# window-level control described exactly $1, or 0: the scroll area whose
# horizontal span contains that control's centre. "New notebook" gives the
# sidebar's notebook list, "New note" the note list.
scroll_area_under() {
  local anchor=$1
  osascript -e "
  tell application \"System Events\"
    tell process \"Drafto\"
      try
        set anchorX to missing value
        repeat with el in (UI elements of window 1)
          try
            if description of el is \"$anchor\" then
              set anchorX to (item 1 of (position of el)) + (item 1 of (size of el)) / 2
              exit repeat
            end if
          end try
        end repeat
        if anchorX is missing value then return 0
        repeat with k from 1 to count of scroll areas of window 1
          set leftEdge to item 1 of (position of scroll area k of window 1)
          set rightEdge to leftEdge + (item 1 of (size of scroll area k of window 1))
          if anchorX > leftEdge and anchorX < rightEdge then return k
        end repeat
      end try
      return 0
    end tell
  end tell
  " 2>/dev/null || echo 0
}

# Print the centre ("x,y") of a row in view in scroll area $1 of window 1 (an
# index from scroll_area_under), or nothing: the row described exactly $2, or,
# without $2, the first row that has a description.
scroll_row_center() {
  local area=$1 desc=${2:-}
  [ "$area" -gt 0 ] 2>/dev/null || return 0
  osascript -e "
  tell application \"System Events\"
    tell process \"Drafto\"
      try
        set sa to scroll area $area of window 1
        set topEdge to item 2 of (position of sa)
        set bottomEdge to topEdge + (item 2 of (size of sa))
        repeat with el in (UI elements of sa)
          try
            set d to description of el
            if role of el is not \"AXScrollBar\" and d is not \"\" and (\"$desc\" is \"\" or d is \"$desc\") then
              set p to position of el
              set s to size of el
              set cx to (item 1 of p) + (item 1 of s) / 2
              set cy to (item 2 of p) + (item 2 of s) / 2
              if cy > topEdge and cy < bottomEdge then
                return (cx as integer as text) & \",\" & (cy as integer as text)
              end if
            end if
          end try
        end repeat
      end try
      return \"\"
    end tell
  end tell
  " 2>/dev/null || true
}

# Find and click an element by its accessibility description (substring match),
# including rows in view inside a scroll area
click_element_by_desc() {
  local pos
  pos=$(find_element_center_by_desc "$1")
  [ -n "$pos" ] || return 1
  cliclick "c:$pos"
}

# Check if an element with the given description is on screen, including rows
# in view inside a scroll area
has_element() {
  [ -n "$(find_element_center_by_desc "$1")" ]
}

wait_for_ui() {
  sleep "${E2E_UI_WAIT:-1.5}"
}

