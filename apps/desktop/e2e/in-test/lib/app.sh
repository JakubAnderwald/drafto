#!/bin/bash
# Drafto screens and flows built on ax.sh, db.sh and prod.sh: the predicates a
# scenario uses to check that a press took effect, and the sign-in / sign-out /
# sync-wait building blocks. Expects QA_EMAIL / QA_PASSWORD for log_in.

on_login_screen() { ax_has desc "Log in"; }
on_signup_screen() { ! ax_has desc "Log in" && ax_has desc "Sign up"; }
on_waiting_screen() { ax_has desc "Check approval status"; }
on_main_screen() { ax_has desc "New notebook"; }
# The App menu's "Sign out" item. It is an RN view labelled by its AXDescription;
# the sign-out confirmation's native "Sign out" button carries the label as its
# AXTitle, so an element titled "Sign out" is never the menu item.
menu_sign_out_item() {
  ax_dump | jq -c 'map(select(.desc == "Sign out" and .title != "Sign out" and ((.w // 0) > 0) and ((.h // 0) > 0))) | first // empty'
}
menu_open() { ax_has id logout-button || ax_has id app-menu || [ -n "$(menu_sign_out_item)" ]; }
menu_closed() { ! menu_open; }
delete_panel_open() { ax_has id delete-account-input || ax_has desc "Type DELETE to confirm"; }
editor_present() { ax_dump | jq -e 'any(.[]; .role == "AXWebArea" and .desc == "RichTextEditor")' > /dev/null; }

# redact — replace the throwaway e-mail in OCR'd screen text before logging it.
redact() {
  local t
  t=$(cat)
  printf '%s' "${t//"$QA_EMAIL"/<email>}"
}

# testIDs surface as AXIdentifier (verified for app-menu-trigger); lookups fall
# back to the accessibility description in case one does not.
open_app_menu() {
  menu_open && return 0
  # The trigger toggles, so a retry that comes too soon closes the menu the
  # first press opened: give each press 5 s to show.
  press_until 5 menu_open id app-menu-trigger || press_until 5 menu_open desc "App menu"
}

# choose_sign_out — with the App menu open, pick "Sign out"; succeeds once the
# menu has closed (the confirmation opens next).
choose_sign_out() {
  local attempt
  press_until 3 menu_closed id logout-button && return 0
  for attempt in 1 2 3; do
    press_el "$(menu_sign_out_item)" && poll 3 menu_closed && return 0
  done
  return 1
}

# Every sign-out asks first (useSafeSignOut, PrimeTestLab report 10668 S-02).
# Alert.alert on RN macOS is an NSAlert sheet on the main window. Its buttons
# are AppKit NSButtons in the order given, Cancel first, so Cancel is the
# default (Return) and the confirm button must be pressed by its label:
# "Sign out", or "Sign out anyway" when changes are still unsynced. NSButtons
# expose that label as AXTitle; AXDescription is the fallback.
sign_out_confirm_button() {
  ax_dump | jq -c '
    def label_is_confirm: . == "Sign out" or . == "Sign out anyway";
    map(select(.role == "AXButton" and .id != "logout-button" and ((.w // 0) > 0) and ((.h // 0) > 0)))
    | (map(select(.title | label_is_confirm)) | first)
      // (map(select(.desc | label_is_confirm)) | first)
      // empty'
}
sign_out_confirm_open() { [ -n "$(sign_out_confirm_button)" ]; }
sign_out_confirm_closed() { ! sign_out_confirm_open; }

# sign_out_confirm_copy — which message the open confirmation shows: synced,
# unsynced ("N changes haven't synced and will be lost."), unknown (the count
# failed) or unread. The texts are in packages/shared/src/constants.ts.
sign_out_confirm_copy() {
  local copy
  copy=$(ax_dump | jq -r '
    [.[] | .value, .title, .desc | strings] as $t
    | if any($t[]; startswith("Everything is synced")) then "synced"
      elif any($t[]; test("^[0-9]+ changes? (hasn.t|haven.t) synced")) then "unsynced"
      elif any($t[]; startswith("Any changes that haven")) then "unknown"
      else empty end' 2> /dev/null)
  if [ -z "$copy" ]; then
    if ocr_has "Everything is synced"; then
      copy=synced
    elif ocr_has "synced and will be lost"; then
      copy=unsynced
    elif ocr_has "Any changes that"; then
      copy=unknown
    fi
  fi
  printf '%s' "${copy:-unread}"
}

# confirm_sign_out [timeout_s] — wait for the sign-out confirmation, record its
# copy in SIGN_OUT_COPY, press its confirm button (AXPress, then the
# focus-and-Space / click press) and wait up to timeout_s for the Log In screen.
confirm_sign_out() {
  local timeout=${1:-45} attempt el
  SIGN_OUT_COPY=unread
  if ! poll 30 sign_out_confirm_open; then
    log "   the sign-out confirmation did not appear; screen reads: $(ocr_text | redact)"
    return 1
  fi
  SIGN_OUT_COPY=$(sign_out_confirm_copy)
  for attempt in 1 2 3 4 5 6; do
    el=$(sign_out_confirm_button)
    [ -n "$el" ] || break
    if [ "$attempt" -gt 2 ] || ! ax_native_press "$el"; then
      press_el "$el"
    fi
    poll 5 sign_out_confirm_closed && break
    log "   press on the sign-out confirmation had no visible effect (attempt $attempt)"
  done
  sign_out_confirm_closed || return 1
  poll "$timeout" on_login_screen
}

sign_out_via_menu() {
  open_app_menu || return 1
  choose_sign_out || return 1
  confirm_sign_out 45
}

# log_in <check> — on the Log In screen, enter the throwaway credentials and
# press "Log in" (AX focus + Space, which also ends the field's editing); <check>
# is what success looks like.
log_in() {
  local check=$1 attempt
  for attempt in 1 2; do
    fill_field "Email" "$QA_EMAIL" || return 1
    fill_field "Password" "$QA_PASSWORD" || return 1
    ax_press desc "Log in"
    poll 25 "$check" && return 0
    on_login_screen || return 1
    log "   login submit had no effect (attempt $attempt); screen reads: $(ocr_text | redact)"
  done
  return 1
}

# settle [timeout_s] — wait until the indicator reads Synced and nothing is
# pending in the local DB.
synced_idle() { [ "$(sync_help)" = Synced ] && [ "$(db_pending)" = 0 ]; }
settle() { poll "${1:-60}" synced_idle; }

# poll_synced <timeout_s> <marker> — after a local edit: waits for "Synced",
# nothing pending and the marker on the server. Sets SAW_PENDING and ELAPSED.
poll_synced() {
  local t0 end h last_srv=0
  t0=$(date +%s)
  end=$((t0 + $1))
  SAW_PENDING=no
  while [ "$(date +%s)" -lt "$end" ]; do
    h=$(sync_help)
    # Builds without the #677 fix refresh the indicator's pending count only
    # after a sync attempt, and with it "N pending" shows for about 1 s online,
    # so the local DB is the oracle for "a change was waiting".
    { [[ "$h" == *pending* ]] || [ "$(db_pending)" -gt 0 ] 2> /dev/null; } && SAW_PENDING=yes
    if [ "$h" = Synced ] && [ "$(db_pending)" = 0 ] && [ $(($(date +%s) - last_srv)) -ge 2 ]; then
      last_srv=$(date +%s)
      if sb_has_marker "$2"; then
        ELAPSED=$(($(date +%s) - t0))
        return 0
      fi
    fi
    sleep 0.3
  done
  ELAPSED=$1
  return 1
}
