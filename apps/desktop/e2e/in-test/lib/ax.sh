#!/bin/bash
# Drive and read the Drafto window: accessibility tree (bin/axq), mouse-free
# presses, clipboard paste, window capture + OCR (bin/ocr). Expects IN_TEST_BIN
# (the compiled Swift helpers, see harness.sh) and RUN_DIR.
#
# Lookups are EXACT matches on the AX description or identifier (RN testID),
# unlike apps/desktop/e2e/lib/ax-helpers.sh's substring match, so "Sign up"
# cannot hit "Don't have an account? Sign up" and the App-menu "Delete account"
# item cannot be mistaken for the delete panel's confirm button.
#
# Input model, measured on this app (RN macOS 0.81, TestFlight build 59):
# - Synthetic mouse clicks are unreliable here: after text is typed into an RN
#   text field the next two clicks on controls are dropped; RN views default
#   to mouseDownCanMoveWindow, so clicks can drag the window; and AXPress is
#   unsupported (-25206).
# - RN macOS Pressables are focusable and fire onPress on Space/Enter. So
#   controls are pressed WITHOUT the mouse: AX-focus the element, then Space
#   (press_el). A cliclick at the element's centre is only the fallback.
# - Text fields are focused through AXFocused, never clicked.
# - A window that is frontmost but not key is fixed mouse-free (axq makekey).
# - Every press is checked by its effect and retried (press_until).

AXQ="$IN_TEST_BIN/axq"
OCR="$IN_TEST_BIN/ocr"

drafto_pid() { pgrep -x Drafto | head -1; }

drafto_wid() { "$AXQ" "$(drafto_pid)" wid; }

# ax_dump [maxDepth] — JSON array of elements (see lib/axq.swift).
ax_dump() {
  local pid
  pid=$(drafto_pid)
  [ -n "$pid" ] || return 1
  "$AXQ" "$pid" dump "${1:-40}" 2> /dev/null
}

# ax_find <desc|id> <value> [role] — first visible element whose field equals value.
ax_find() {
  ax_dump | jq -c --arg k "$1" --arg v "$2" --arg r "${3:-}" \
    'map(select(.[$k] == $v and ($r == "" or .role == $r) and ((.w // 0) > 0) and ((.h // 0) > 0))) | first // empty'
}

# ax_find_contains <substring> — first visible element whose description contains it.
ax_find_contains() {
  ax_dump | jq -c --arg v "$1" \
    'map(select((.desc | contains($v)) and ((.w // 0) > 0))) | first // empty'
}

ax_has() { [ -n "$(ax_find "$@")" ]; }

# ax_wait <timeout_s> <desc|id> <value> [role]
ax_wait() {
  local timeout=$1
  shift
  local end=$(($(date +%s) + timeout))
  while [ "$(date +%s)" -lt "$end" ]; do
    ax_has "$@" && return 0
    sleep 0.5
  done
  return 1
}

# poll <timeout_s> <command…> — run the command until it succeeds.
poll() {
  local end=$(($(date +%s) + $1))
  shift
  while [ "$(date +%s)" -lt "$end" ]; do
    "$@" && return 0
    sleep 0.5
  done
  return 1
}

frontmost() {
  osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2> /dev/null
}

# Bring Drafto forward and make sure its window is key — each only when it
# isn't already: every activation is an AppState "active" event, which itself
# triggers a sync.
ensure_front() {
  if [ "$(frontmost)" != "Drafto" ]; then
    osascript -e 'tell application "System Events" to set frontmost of process "Drafto" to true' > /dev/null
    sleep 0.8
  fi
  if [[ "$("$AXQ" "$(drafto_pid)" keywin)" == *focusedWindow=false* ]]; then
    "$AXQ" "$(drafto_pid)" makekey > /dev/null
    sleep 0.3
  fi
}

# Focus another app, then Drafto again: one AppState background → active cycle.
focus_away_and_back() {
  osascript -e 'tell application "System Events" to set frontmost of process "Finder" to true' > /dev/null
  sleep 2
  osascript -e 'tell application "System Events" to set frontmost of process "Drafto" to true' > /dev/null
}

click_el() {
  local el=$1 x y
  [ -n "$el" ] || return 1
  ensure_front
  read -r x y < <(jq -r '"\((.x + .w / 2) | floor) \((.y + .h / 2) | floor)"' <<< "$el")
  cliclick "c:$x,$y"
}

# press_el <element json> — mouse-free press: AX-focus the control, then Space
# (RN macOS Pressable keyDownEvents). Falls back to a click if it can't be focused.
# Sets PRESS_MODE to "space" or "click": only a space press is known to have
# started with the control focused.
press_el() {
  local el=$1 path
  PRESS_MODE=
  [ -n "$el" ] || return 1
  ensure_front
  path=$(jq -r '.path' <<< "$el")
  # Space only once the control itself holds focus — otherwise it would type a
  # space into whatever text field still has it.
  if "$AXQ" "$(drafto_pid)" focus "$path" 2> /dev/null && sleep 0.25 &&
    [ "$(ax_dump | jq -r --arg p "$path" 'map(select(.path == $p)) | first | .focused // false')" = true ]; then
    PRESS_MODE=space
    osascript -e 'tell application "System Events" to key code 49' # Space
  else
    log "   (no AX focus for '$(jq -r '.desc' <<< "$el")'; clicking instead)"
    PRESS_MODE=click
    click_el "$el"
  fi
}

# ax_press <desc|id> <value> [role]
ax_press() { press_el "$(ax_find "$@")"; }

# press_until <timeout_s> <check> <desc|id> <value> [role] — press the element
# until <check> (a command) succeeds, up to 6 presses.
press_until() {
  local timeout=$1 check=$2 attempt
  shift 2
  for attempt in 1 2 3 4 5 6; do
    if ax_press "$@"; then
      poll "$timeout" "$check" && return 0
      log "   press on '$2' had no visible effect (attempt $attempt)"
    else
      sleep 1
    fi
  done
  return 1
}

# press_contains_until <timeout_s> <check> <description substring>
press_contains_until() {
  local timeout=$1 check=$2 attempt
  for attempt in 1 2 3 4 5 6; do
    if press_el "$(ax_find_contains "$3")"; then
      poll "$timeout" "$check" && return 0
      log "   press on '$3' had no visible effect (attempt $attempt)"
    else
      sleep 1
    fi
  done
  return 1
}

# Puts the caret at the end of the open note: AX-focus the editor's text area
# (the contenteditable inside the RichTextEditor web view), or click it when
# <click> is passed, then ⌘↓.
click_editor_end() {
  local el x y
  el=$(ax_dump | jq -c '
    (map(select(.role == "AXWebArea" and .desc == "RichTextEditor")) | first) as $web
    | if $web == null then empty else
        map(select(.role == "AXTextArea" and (.path | startswith($web.path)) and ((.w // 0) > 0))) | first // empty
      end')
  [ -n "$el" ] || return 1
  ensure_front
  if [ "${1:-}" = click ] || ! "$AXQ" "$(drafto_pid)" focus "$(jq -r .path <<< "$el")" 2> /dev/null; then
    read -r x y < <(jq -r '"\((.x + 40) | floor) \((.y + 12) | floor)"' <<< "$el")
    cliclick "c:$x,$y"
  fi
  sleep 0.4
  osascript -e 'tell application "System Events" to key code 125 using command down' # ⌘↓
  sleep 0.2
}

# type_marker <marker> — append " <marker>" to the open note; succeed once the
# local DB has it.
type_marker() {
  local _
  local mode
  for mode in focus click click; do
    click_editor_end "$mode" || return 1
    printf ' %s' "$1" | pbcopy
    osascript -e 'tell application "System Events" to keystroke "v" using command down'
    poll 8 db_has_marker "$1" && return 0
    log "   typing '$1' into the note did not reach the local DB; retrying"
  done
  return 1
}

# The Sync status button's accessibility help: "Syncing..." / "Offline" /
# "N pending" / "Synced" (apps/desktop/src/components/sync-status.tsx).
sync_help() {
  ax_dump 1 | jq -r 'map(select(.desc == "Sync status")) | first | .help // empty'
}

# wait_help <timeout_s> <regex>
wait_help() {
  local end=$(($(date +%s) + $1)) h
  while [ "$(date +%s)" -lt "$end" ]; do
    h=$(sync_help)
    [[ "$h" =~ $2 ]] && return 0
    sleep 0.3
  done
  return 1
}

# Pastes into whatever has keyboard focus (cliclick's per-character typing
# drops keys on RN macOS — see apps/desktop/e2e/run-e2e.sh).
paste_text() {
  printf '%s' "$1" | pbcopy
  ensure_front
  osascript -e 'tell application "System Events" to keystroke "v" using command down'
  sleep 0.4
}

clear_clipboard() { pbcopy < /dev/null; }

key_return() { osascript -e 'tell application "System Events" to key code 36'; }

field_len() { ax_find "${2:-desc}" "$1" | jq -r '(.value // "") | length'; }

# ax_focus <desc|id> <value> — focus an element via AXFocused (no mouse).
ax_focus() {
  local p
  p=$(ax_find "$1" "$2" | jq -r '.path // empty')
  [ -n "$p" ] || return 1
  "$AXQ" "$(drafto_pid)" focus "$p" || return 1
  sleep 0.3
  [ "$(ax_find "$1" "$2" | jq -r '.focused // false')" = true ]
}

select_all_delete() {
  osascript -e 'tell application "System Events" to keystroke "a" using command down' \
    -e 'tell application "System Events" to key code 51' # ⌘A, delete
  sleep 0.3
}

# fill_field <desc|value> <text> [desc|id] — make the window key, focus the
# field via AX, clear it, paste, and verify the length landed (secure fields
# hide the value but still report its length). The clipboard is cleared only
# after the paste is verified. The field stays focused, ready for Return.
fill_field() {
  local desc=$1 text=$2 key=${3:-desc} attempt n="" _
  for attempt in 1 2 3 4 5 6; do
    ensure_front
    if ax_focus "$key" "$desc"; then
      select_all_delete
      printf '%s' "$text" | pbcopy
      osascript -e 'tell application "System Events" to keystroke "v" using command down'
      for _ in 1 2 3 4 5 6; do
        sleep 0.3
        n=$(field_len "$desc" "$key")
        if [ "$n" = "${#text}" ]; then
          sleep 0.3
          clear_clipboard
          return 0
        fi
      done
    fi
    log "   fill of '$desc' did not land (attempt $attempt, field has ${n:-?} chars); retrying"
    sleep 1
  done
  clear_clipboard
  return 1
}

# ocr_text — every line OCR reads in the Drafto window, joined with " | ".
ocr_text() {
  local img="$RUN_DIR/tmp-ocr.png"
  win_capture "$img" && "$OCR" "$img" | jq -r '[.items[].text] | join(" | ")'
}

win_capture() { screencapture -x -o -l"$(drafto_wid)" "$1"; }

# ocr_has <text> — case-insensitive text match anywhere in the Drafto window.
ocr_has() {
  local img="$RUN_DIR/tmp-ocr.png"
  win_capture "$img" && "$OCR" "$img" "$1" > /dev/null
}

# ocr_click <text> — click the centre of the first OCR match.
ocr_click() {
  local img="$RUN_DIR/tmp-ocr.png" m win x y
  win_capture "$img" || return 1
  m=$("$OCR" "$img" "$1") || return 1
  win=$(ax_dump 0 | jq -c 'map(select(.role == "AXWindow")) | first')
  read -r x y < <(jq -rn --argjson m "$m" --argjson w "$win" '
    ($m.width / $w.w) as $s
    | "\(($w.x + ($m.match.x + $m.match.w / 2) / $s) | floor) \(($w.y + ($m.match.y + $m.match.h / 2) / $s) | floor)"')
  ensure_front
  cliclick "c:$x,$y"
}
