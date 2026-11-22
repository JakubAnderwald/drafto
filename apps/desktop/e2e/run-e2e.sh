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
# shellcheck source=lib/ax-helpers.sh
source "$(dirname "$0")/lib/ax-helpers.sh"

# ── Setup ──────────────────────────────────────

# Ensure Drafto is frontmost
osascript -e 'tell application "Drafto" to activate'
sleep 1

# ── Auth setup ────────────────────────────────
# If the app is sitting on the login screen, sign in with the E2E test user.
# Same env contract as the web suite (apps/web/e2e/auth.setup.ts).
if has_element "Email" && has_element "Password" && has_element "Log in"; then
  : "${E2E_TEST_EMAIL:?E2E_TEST_EMAIL must be set (see apps/web/.env.local)}"
  : "${E2E_TEST_PASSWORD:?E2E_TEST_PASSWORD must be set (see apps/web/.env.local)}"

  # ──────────────────────────────────────────────
  echo ""
  echo "TEST 0: Login password field has a show/hide toggle (PrimeTestLab 10668, S-01)"
  # ──────────────────────────────────────────────
  # Runs only from the login screen, and before the real password is typed. The field is
  # cleared first (an aborted earlier run can leave a typed password in it), so only an
  # empty field is ever revealed in the window or a screenshot. It ends hidden again, so the
  # sign-in below types into a secure field.
  click_element_by_desc "Password"
  cliclick kd:cmd t:a ku:cmd kp:delete
  wait_for_ui
  # The keystrokes clear the field only if the click focused it. Confirm it holds focus and
  # is empty (retrying the click and clear once) before anything reveals it.
  PASSWORD_CLEARED=false
  for attempt in 1 2; do
    if [ "$(text_field_state "Password")" = "true,0" ]; then
      PASSWORD_CLEARED=true
      break
    fi
    if [ "$attempt" = 1 ]; then
      click_element_by_desc "Password" || true
      cliclick kd:cmd t:a ku:cmd kp:delete
      wait_for_ui
    fi
  done
  # An aborted earlier run can also leave the field revealed: hide it before the test starts.
  if has_element "Hide password"; then
    click_element_by_desc "Hide password" || true
    wait_for_ui
  fi
  if [ "$PASSWORD_CLEARED" = false ]; then
    fail "Password toggle" "Password field not confirmed focused and empty ($(text_field_state "Password")) — not revealing it"
  elif has_element "Show password"; then
    pass "Password field offers 'Show password'"
    if click_element_by_desc "Show password" && wait_for_ui && has_element "Hide password"; then
      pass "Toggle switches to 'Hide password'"
      click_element_by_desc "Hide password" || true
      wait_for_ui
      if has_element "Show password"; then
        pass "Toggle switches back to 'Show password'"
      else
        fail "Password toggle" "'Show password' not back after clicking 'Hide password'"
      fi
    else
      fail "Password toggle" "'Hide password' not found after clicking 'Show password'"
    fi
  else
    fail "Password toggle" "No 'Show password' control on the login screen"
  fi

  # Never type the real password into a field that may be revealed. Sign in only when the
  # field is confirmed hidden: "Show password" present and "Hide password" absent. Try hiding
  # it once more, then abort rather than guess. This also aborts on a build with no toggle,
  # where neither label exists; the suite targets builds that have one.
  if has_element "Hide password"; then
    click_element_by_desc "Hide password" || true
    wait_for_ui
  fi
  if ! has_element "Show password" || has_element "Hide password"; then
    echo "Error: cannot confirm the password field is hidden — aborting before typing credentials." >&2
    exit 1
  fi

  click_element_by_desc "Email"
  cliclick t:"$E2E_TEST_EMAIL"
  click_element_by_desc "Password"
  cliclick t:"$E2E_TEST_PASSWORD"
  click_element_by_desc "Log in"
  # Poll up to 15s for the sidebar to render. Fail fast if it never does — the
  # rest of the suite would otherwise run against the login screen and emit
  # confusing failures unrelated to the underlying auth issue.
  LOGIN_OK=false
  for _ in $(seq 1 30); do
    if has_element "New notebook"; then
      LOGIN_OK=true
      break
    fi
    sleep 0.5
  done
  if [ "$LOGIN_OK" = false ]; then
    echo "Error: Login did not complete within 15s — aborting." >&2
    exit 1
  fi
else
  echo ""
  echo "TEST 0: Login password field has a show/hide toggle"
  echo "  ⏭  Skipped — the app is already signed in (sign out to run it)"
fi

# Notebook name is set up here so the cleanup teardown can find it later.
E2E_NB_NAME="E2E Notebook $(date +%s)"

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

if has_element "New notebook"; then
  pass "New notebook button present"
else
  fail "New notebook button" "No element with description 'New notebook' found"
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

# Sign out and Delete account live behind this menu, so they are not top-level elements.
if has_element "App menu"; then
  pass "App menu button visible"
else
  fail "App menu button" "Not found"
fi

if has_element "Sign out" || has_element "Delete account"; then
  fail "App menu closed by default" "Sign out / Delete account visible before the menu is opened"
else
  pass "Account actions hidden until the app menu is opened"
fi

if has_element "Sync status"; then
  pass "Sync status button visible"
else
  fail "Sync status" "Not found"
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 2b: App menu opens, its items click, and it closes"
# ──────────────────────────────────────────────
# The menu floats over the sidebar, so only the real app shows whether it takes clicks.
# Every check below leaves the menu and the delete panel closed, because an open menu's
# backdrop covers the sidebar and would take TEST 3's click on the first notebook. Never click
# "Sign out" (it ends the session the rest of the suite needs) and never confirm the deletion
# (this is the shared E2E user).

# Closes the menu by clicking where the trigger is: while the menu is open, the click lands on
# its backdrop, which covers the trigger.
close_app_menu_by_click() {
  if has_element "Sign out"; then
    click_element_by_desc "App menu" || true
    wait_for_ui
  fi
}

if click_element_by_desc "App menu"; then
  wait_for_ui
  if has_element "Sign out"; then
    pass "App menu shows Sign out"
  else
    fail "App menu Sign out" "Not found after clicking App menu"
  fi

  if has_element "Delete account"; then
    pass "App menu shows Delete account"
  else
    fail "App menu Delete account" "Not found after clicking App menu"
  fi

  # Choosing the item closes the menu and opens the type-DELETE panel. Close the panel with
  # Escape from its input; never type DELETE or click its confirm button.
  if click_element_by_desc "Delete account"; then
    wait_for_ui
    if has_element "Type DELETE to confirm"; then
      pass "Delete account opens the confirmation panel"
      click_element_by_desc "Type DELETE to confirm" || true
      sleep 0.5
      cliclick kp:esc
      wait_for_ui
      if has_element "Type DELETE to confirm"; then
        fail "Delete account panel" "Still open after Escape"
      else
        pass "Delete account panel closes on Escape"
      fi
    else
      fail "Delete account panel" "Not shown after choosing Delete account"
    fi
    # Whatever happened above, leave the panel closed. Cancel never sends the deletion.
    if has_element "Type DELETE to confirm"; then
      click_element_by_desc "Cancel" || true
      wait_for_ui
    fi
    if has_element "Sign out"; then
      fail "App menu" "Still open after choosing Delete account"
      close_app_menu_by_click
    fi
  else
    fail "App menu Delete account" "Could not click it"
    close_app_menu_by_click
  fi
else
  fail "App menu" "Could not click the App menu button"
fi

# Escape closes the open menu.
if click_element_by_desc "App menu" && wait_for_ui && has_element "Sign out"; then
  cliclick kp:esc
  wait_for_ui
  if has_element "Sign out"; then
    fail "App menu Escape" "Menu still open after Escape"
    close_app_menu_by_click
  else
    pass "App menu closes on Escape"
  fi
else
  fail "App menu Escape" "Menu did not open"
  cliclick kp:esc # best effort, in case it opened without its items being visible
fi

# Clicking the App menu button again closes it.
if click_element_by_desc "App menu" && wait_for_ui && has_element "Sign out"; then
  close_app_menu_by_click
  if has_element "Sign out"; then
    fail "App menu second click" "Menu still open after clicking App menu again"
  else
    pass "App menu closes when App menu is clicked again"
  fi
else
  fail "App menu second click" "Menu did not open"
  cliclick kp:esc # best effort, in case it opened without its items being visible
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 3: Select a notebook"
# ──────────────────────────────────────────���───
# Notebooks are rows of the sidebar's scrolling list (the scroll area under
# "New notebook"), not window-level elements. Pick the first one in view.
FIRST_NB_POS=$(scroll_row_center "$(scroll_area_under "New notebook")")

if [ -n "$FIRST_NB_POS" ]; then
  cliclick "c:$FIRST_NB_POS"
  wait_for_ui

  screencapture -x /tmp/drafto_e2e_notebook_click.png

  # After selecting a notebook, the "New note" button should appear
  if has_element "New note"; then
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
if click_element_by_desc "New notebook"; then
  # The TextInput renders with autoFocus. cliclick's per-character typing on
  # RN macOS drops keys at the start (focus latency) and its kp:return on a
  # text input was observed not to fire onSubmitEditing. Use clipboard paste
  # via AppleScript keystroke for both the value and the submit — these go
  # through the standard input pipeline and respect modifiers.
  sleep 1.5
  osascript -e "set the clipboard to \"$E2E_NB_NAME\""
  sleep 0.2
  osascript -e 'tell application "System Events" to keystroke "v" using command down'
  sleep 0.4
  osascript -e 'tell application "System Events" to keystroke return'
  wait_for_ui
  sleep 1

  if has_element "$E2E_NB_NAME"; then
    pass "Notebook '$E2E_NB_NAME' created and visible"
  else
    fail "Create notebook" "Notebook '$E2E_NB_NAME' not found after creation"
  fi
else
  fail "Create notebook" "Could not find 'New notebook' button"
fi

screencapture -x /tmp/drafto_e2e_new_notebook.png

# ──────────────────────────────────────────────
echo ""
echo "TEST 5: Create a new note"
# ──────────────────────────────────────────────
# Press Escape first to dismiss any open create-notebook input
cliclick kp:esc
wait_for_ui

# TEST 5b may delete only a note this test created: it runs only if the note list's
# Untitled count went up here.
TEST5_UNTITLED_BEFORE=""
TEST5_UNTITLED_AFTER=""
if has_element "New note"; then
  BEFORE_NOTE_COUNT=$(get_element_count)
  TEST5_UNTITLED_BEFORE=$(count_rows_in_area "$(scroll_area_under "New note")" "Untitled") || TEST5_UNTITLED_BEFORE=""
  # Exact match: a substring lookup finds "New notebook" first.
  click_window_element_exact "New note"
  wait_for_ui
  sleep 1

  AFTER_NOTE_COUNT=$(get_element_count)
  AFTER_DESCS=$(get_all_descs)
  TEST5_UNTITLED_AFTER=$(count_rows_in_area "$(scroll_area_under "New note")" "Untitled") || TEST5_UNTITLED_AFTER=""

  screencapture -x /tmp/drafto_e2e_new_note.png

  if echo "$AFTER_DESCS" | grep -qi "Untitled\|Saved\|No content"; then
    pass "New note created and visible in note list"
  elif [ "$AFTER_NOTE_COUNT" -ne "$BEFORE_NOTE_COUNT" ]; then
    pass "New note created (element count: $BEFORE_NOTE_COUNT -> $AFTER_NOTE_COUNT)"
  else
    fail "Create note" "No visible change after clicking New note"
  fi
else
  fail "Create note" "Could not find 'New note' button — is a notebook selected?"
fi

# ──────────────────────────────────────────────
echo ""
echo "TEST 5b: Delete a note from the keyboard (#864)"
# ──────────────────────────────────────────────
# The row's × is hover-only; a click on the row focuses it, and the focused, selected row
# takes ⌫. Everything here looks only inside the note list (the scroll area under "New
# note"), so a notebook named Untitled never matches. It deletes only the note TEST 5 just
# created (newest first, so the first Untitled row), and presses ⌫ only once the click has
# given that row keyboard focus: a ⌫ anywhere else would edit a note.
NOTE_AREA=$(scroll_area_under "New note")
if [ -z "$TEST5_UNTITLED_BEFORE" ] || [ -z "$TEST5_UNTITLED_AFTER" ] ||
  [ "$TEST5_UNTITLED_AFTER" -le "$TEST5_UNTITLED_BEFORE" ]; then
  fail "Keyboard delete" "TEST 5 didn't add an Untitled note (${TEST5_UNTITLED_BEFORE:-?} -> ${TEST5_UNTITLED_AFTER:-?}); nothing safe to delete"
elif ! UNTITLED_BEFORE=$(count_rows_in_area "$NOTE_AREA" "Untitled"); then
  fail "Keyboard delete" "Could not read the note list's rows (scroll area '$NOTE_AREA')"
else
  ROW_POS=$(scroll_row_center "$NOTE_AREA" "Untitled")
  if [ -z "$ROW_POS" ]; then
    fail "Keyboard delete" "The Untitled note row is not in view to click"
  else
    cliclick "c:$ROW_POS"
    sleep 0.5
    if [ "$(row_focused_in_area "$NOTE_AREA" "Untitled")" != "true" ]; then
      fail "Keyboard delete" "Clicking the note row didn't give it keyboard focus; ⌫ not pressed"
    else
      cliclick kp:delete
      wait_for_ui
      if ! UNTITLED_AFTER=$(count_rows_in_area "$NOTE_AREA" "Untitled"); then
        fail "Keyboard delete" "Could not read the note list's rows after ⌫"
      elif [ "$UNTITLED_AFTER" -lt "$UNTITLED_BEFORE" ]; then
        pass "⌫ on the clicked note row moves it to Trash ($UNTITLED_BEFORE -> $UNTITLED_AFTER)"
      else
        fail "Keyboard delete" "Untitled rows unchanged ($UNTITLED_BEFORE) after ⌫ on the focused row"
      fi
    fi
  fi
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
# Metro only runs when targeting a debug build started via `pnpm start`.
# Production builds (e.g. /Applications/Drafto.app) bundle JS into the .app
# and don't open port 8081 — skip the test in that case rather than fail it.
METRO_PID=$(lsof -ti :8081 2>/dev/null | head -1 || true)
if [ -z "$METRO_PID" ]; then
  echo "  ⏭  Skipped — Metro not running (likely a production-build target)"
else
  pass "Metro bundler running on port 8081 (PID: $METRO_PID)"
  METRO_STATUS=$(curl -s http://localhost:8081/status 2>/dev/null || echo "unreachable")
  if [[ "$METRO_STATUS" == *"packager-status:running"* ]]; then
    pass "Metro bundler is healthy"
  else
    fail "Metro health" "Status: $METRO_STATUS"
  fi
fi

# ──────────────────────────────────────────────
echo ""
echo "TEARDOWN: Delete E2E test notebook"
# ──────────────────────────────────────────────
# Both delete buttons are hover-gated (accessibilityElementsHidden={!hovered}),
# so the cursor must move over the row before the Delete button enters the
# accessibility tree. notebook.markAsDeleted() cascades to child notes via
# WatermelonDB, so deleting the notebook also collects the orphan note from
# Test 5 — no second pass needed.
# The row is inside the sidebar's scroll area; its Delete button appears there
# too once hovered.
NB_POS=$(find_element_center_by_desc "$E2E_NB_NAME")
if [ -n "$NB_POS" ]; then
  # RN macOS onHoverIn fires on real mouse motion, not on teleport. Move to a
  # different position first, then to the notebook row, so the cursor crosses
  # the row boundary and triggers the hover state that surfaces Delete.
  cliclick "m:10,10"
  sleep 0.2
  cliclick "m:$NB_POS"
  sleep 1.0
  if click_element_by_desc "Delete notebook"; then
    sleep 1
    if has_element "$E2E_NB_NAME"; then
      echo "  ⚠  Cleanup: Delete clicked but notebook still visible (state left behind)"
    else
      echo "  ✅ Cleanup: E2E notebook removed"
    fi
  else
    echo "  ⚠  Cleanup: 'Delete notebook' button not in a11y tree (hover may have failed)"
  fi
else
  echo "  ℹ  Cleanup: No matching E2E notebook to delete (Test 4 may have failed)"
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
