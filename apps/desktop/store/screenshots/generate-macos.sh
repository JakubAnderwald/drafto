#!/bin/bash
# Generates Mac App Store screenshots of the installed Drafto app, signed in as
# the App Review demo account, into apps/desktop/fastlane/screenshots/en-US/
# (the layout `fastlane mac upload_screenshots` uploads).
#
# Builds nothing: it drives an already-installed, prod-pointed Drafto.app (by
# default the TestFlight install in /Applications), so the desktop fossil rule
# does not apply and it runs from any checkout.
#
# ⚠️ Signs the app OUT of whatever account it is using (only once its sync
# status reads "Synced", since desktop sign-out wipes local data) and leaves it
# signed in as the review account with View → Appearance set to Light. Sign
# back in and restore the appearance yourself afterwards.
#
# Usage: bash apps/desktop/store/screenshots/generate-macos.sh
#   DRAFTO_APP=/path/Drafto.app   app to drive (default /Applications/Drafto.app)
#   SCREENSHOT_NOTEBOOK=<name>    notebook to open (default: first in the sidebar)
#   SCREENSHOT_NOTE=<title>       note for the first shot (default "Welcome to Drafto")
#   SCREENSHOT_NOTE_2=<title>     note for the second shot (default "Meeting notes")
#   SCREENSHOT_SEARCH=<query>     search query for the search shot (default: "note")
#
# Requires cliclick (brew install cliclick) and Accessibility permission for
# the terminal (System Settings → Privacy & Security → Accessibility).
set -euo pipefail
trap 'echo "Error: ${BASH_SOURCE[0]}:${LINENO}: \"${BASH_COMMAND}\" failed." >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"
OUT_DIR="$DESKTOP_DIR/fastlane/screenshots/en-US"
APP="${DRAFTO_APP:-/Applications/Drafto.app}"
SEARCH_QUERY="${SCREENSHOT_SEARCH:-note}"

# 1440x900 points is 2880x1800 pixels on a Retina display, 1440x900 otherwise;
# both are accepted Mac App Store sizes (16:10).
WIN_X=80
WIN_Y=60
WIN_W=1440
WIN_H=900

# shellcheck source=../../../../scripts/lib/app-review-account.sh
source "$REPO_ROOT/scripts/lib/app-review-account.sh"
# shellcheck source=../../e2e/lib/ax-helpers.sh
source "$DESKTOP_DIR/e2e/lib/ax-helpers.sh"

command -v cliclick > /dev/null || {
  echo "Error: cliclick is required (brew install cliclick)." >&2
  exit 1
}
[ -d "$APP" ] || {
  echo "Error: $APP not found. Install Drafto from TestFlight or set DRAFTO_APP." >&2
  exit 1
}

load_app_review_account

# Pastes $1 into the focused field. cliclick's per-character typing drops keys
# on RN macOS (see e2e/run-e2e.sh), so go through the clipboard.
paste_text() {
  printf '%s' "$1" | pbcopy
  sleep 0.2
  osascript -e 'tell application "System Events" to keystroke "v" using command down'
  sleep 0.4
}

# Polls up to $2 seconds for an element whose description contains $1.
wait_for_element() {
  local desc=$1 timeout=${2:-15} _
  for _ in $(seq 1 $((timeout * 2))); do
    has_element "$desc" && return 0
    sleep 0.5
  done
  echo "Error: '$desc' did not appear within ${timeout}s." >&2
  return 1
}

# Captures exactly the window's frame (no shadow, no desktop) to $1.
capture_window() {
  local out=$1
  osascript -e 'tell application "Drafto" to activate'
  sleep 0.8
  screencapture -x -R"$WIN_X,$WIN_Y,$WIN_W,$WIN_H" "$out"
  assert_png_size "$out" 2880x1800 1440x900
}

# Returns the index of the first window element after the one described $1
# whose description is not in the remaining arguments.
first_element_after() {
  local anchor=$1
  shift
  local skip
  skip=$(printf '"%s",' "$@")
  osascript -e "
  tell application \"System Events\"
    tell process \"Drafto\"
      set skipDescs to {${skip%,}}
      set seen to false
      repeat with i from 1 to count of UI elements of window 1
        try
          set d to description of UI element i of window 1
          if seen and d is not \"\" and d is not in skipDescs then return i
          if d is \"$anchor\" then set seen to true
        end try
      end repeat
      return 0
    end tell
  end tell
  " 2> /dev/null
}

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/mac-*.png

# (Captured first: under pipefail, `ioreg | grep -q` fails when grep exits early.)
session_state=$(ioreg -n Root -d1)
if [[ "$session_state" == *'"CGSSessionScreenIsLocked"=Yes'* ]]; then
  echo "Error: the screen is locked; unlock it first (the script drives the real UI)." >&2
  exit 1
fi

echo "→ Launching $APP"
open -a "$APP"
sleep 3
# A window closed with its red button doesn't come back on activate; relaunch.
if [ "$(osascript -e 'tell application "System Events" to count windows of process "Drafto"')" = 0 ]; then
  osascript -e 'tell application "Drafto" to quit'
  sleep 3
  open -a "$APP"
  sleep 3
fi
osascript -e 'tell application "Drafto" to activate'
for _ in $(seq 1 60); do
  has_element "Log in" || has_element "App menu" && break
  sleep 0.5
done

echo "→ Light appearance"
osascript -e '
tell application "System Events" to tell process "Drafto"
  click menu item "Light" of menu 1 of menu item "Appearance" of menu 1 of menu bar item "View" of menu bar 1
end tell' > /dev/null

if has_element "App menu"; then
  # Desktop sign-out syncs pending changes but gives up after a timeout and
  # then wipes the local database, so unsynced edits would be lost for good.
  # The sync button exposes its status ("Synced", "3 pending", "Offline"…)
  # as its accessibility help; only sign out when it says "Synced".
  sync_idx=$(find_element_by_desc "Sync status")
  if [ "${sync_idx:-0}" -gt 0 ] 2> /dev/null; then
    sync_status=$(osascript -e "
    tell application \"System Events\" to tell process \"Drafto\"
      return help of UI element $sync_idx of window 1
    end tell" 2> /dev/null || true)
  else
    echo "Warning: the Sync status control was not found." >&2
    sync_status=""
  fi
  if [ "$sync_status" != "Synced" ] && [ "${SCREENSHOT_CONFIRM_SIGN_OUT:-}" != 1 ]; then
    echo "Error: Drafto's sync status is '${sync_status:-unknown}', not 'Synced'." >&2
    echo "Signing out now could lose unsynced edits. Let it sync, or set" >&2
    echo "SCREENSHOT_CONFIRM_SIGN_OUT=1 if you're sure nothing is pending." >&2
    exit 1
  fi
  echo "→ Signing out the current account (sync status: ${sync_status:-confirmed})"
  # The first click after activation can land as a window-focus click, so
  # retry until the menu is actually open.
  for _ in 1 2 3; do
    click_element_by_desc "App menu"
    wait_for_ui
    has_element "Sign out" && break
  done
  click_element_by_desc "Sign out"
  wait_for_element "Log in" 20
fi

echo "→ Signing in as the review account"
wait_for_element "Log in" 20
click_element_by_desc "Email"
paste_text "$APPREVIEW_EMAIL"
click_element_by_desc "Password"
paste_text "$APPREVIEW_PASSWORD"
pbcopy < /dev/null
click_element_by_desc "Log in"
wait_for_element "New notebook" 30
# Let the first sync pull the account's notebooks and notes.
sleep "${SCREENSHOT_SYNC_WAIT:-8}"

echo "→ Sizing the window to ${WIN_W}x${WIN_H} points"
osascript -e "
tell application \"System Events\" to tell process \"Drafto\"
  set position of window 1 to {$WIN_X, $WIN_Y}
  set size of window 1 to {$WIN_W, $WIN_H}
end tell"
sleep 1
# macOS shrinks a window that doesn't fit the display, and -R would then
# capture the desktop around it.
actual_size=$(osascript -e 'tell application "System Events" to tell process "Drafto" to get size of window 1' | tr -d ' ')
[ "$actual_size" = "$WIN_W,$WIN_H" ] || {
  echo "Error: the window is ${actual_size/,/x} points, not ${WIN_W}x${WIN_H}; the display is too small." >&2
  exit 1
}

SIDEBAR_CONTROLS=("Search" "New notebook" "Trash" "App menu" "Sync status")

open_notebook() {
  if [ -n "${SCREENSHOT_NOTEBOOK:-}" ]; then
    click_element_by_desc "$SCREENSHOT_NOTEBOOK"
  else
    click_element "$(first_element_after "New notebook" "${SIDEBAR_CONTROLS[@]}")"
  fi
  wait_for_element "New note" 10
  wait_for_ui
}

# Opens the note titled $1. Note rows are not window-level elements: they
# live inside the note list (the window's first scroll area), labelled by title.
open_note() {
  local title=$1 pos
  pos=$(osascript -e "
  tell application \"System Events\" to tell process \"Drafto\"
    repeat with noteRow in (UI elements of scroll area 1 of window 1)
      if description of noteRow is \"$title\" then
        set p to position of noteRow
        set s to size of noteRow
        set cx to (item 1 of p) + (item 1 of s) / 2
        set cy to (item 2 of p) + (item 2 of s) / 2
        return (cx as integer as text) & \",\" & (cy as integer as text)
      end if
    end repeat
    return \"\"
  end tell" 2> /dev/null)
  [ -n "$pos" ] || {
    echo "Error: note '$title' not found in the note list." >&2
    exit 1
  }
  cliclick "c:$pos"
  sleep 2
}

# The editor can open scrolled to the caret. Scroll it back to the top with
# real wheel events over the editor pane, then park the pointer in the
# editor's empty area so no row shows its hover-only delete button.
scroll_editor_to_top() {
  cliclick "m:$((WIN_X + 920)),$((WIN_Y + 450))"
  osascript -l JavaScript -e '
    ObjC.import("CoreGraphics");
    for (let i = 0; i < 15; i++) {
      $.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 0, 1, 50));
      delay(0.03);
    }' > /dev/null
  cliclick "m:$((WIN_X + 1100)),$((WIN_Y + 700))"
  sleep 1
}

echo "→ Capturing"
open_notebook
open_note "${SCREENSHOT_NOTE:-Welcome to Drafto}"
scroll_editor_to_top
capture_window "$OUT_DIR/mac-01-editor.png"

open_note "${SCREENSHOT_NOTE_2:-Meeting notes}"
scroll_editor_to_top
capture_window "$OUT_DIR/mac-02-notes.png"

click_element_by_desc "Search"
sleep 1
paste_text "$SEARCH_QUERY"
sleep 2
capture_window "$OUT_DIR/mac-03-search.png"
# Escape doesn't close the search overlay; a click on its backdrop does.
cliclick "c:$((WIN_X + 1100)),$((WIN_Y + 750))"
pbcopy < /dev/null

echo "Done: $(ls "$OUT_DIR"/mac-*.png | wc -l | tr -d ' ') screenshots in $OUT_DIR"
echo "Drafto.app is now signed in as the review account, with View → Appearance set to Light."
echo "Sign back in to your own account (and restore your appearance setting) when done."
