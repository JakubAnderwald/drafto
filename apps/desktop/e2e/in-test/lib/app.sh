#!/bin/bash
# Drafto screens and flows built on ax.sh, db.sh and prod.sh: the predicates a
# scenario uses to check that a press took effect, and the sign-in / sign-out /
# sync-wait building blocks. Expects QA_EMAIL / QA_PASSWORD for log_in.

on_login_screen() { ax_has desc "Log in"; }
on_signup_screen() { ! ax_has desc "Log in" && ax_has desc "Sign up"; }
# The inactive-account screen's check button: "Check again" since open signup (ADR 0094),
# "Check approval status" on builds before it. Prints the label on screen.
check_btn_label() {
  local label
  for label in "Check again" "Check approval status"; do
    if ax_has desc "$label"; then
      echo "$label"
      return 0
    fi
  done
  return 1
}
on_waiting_screen() { check_btn_label > /dev/null; }
on_main_screen() { ax_has desc "New notebook"; }
# jq definitions over an ax_dump: a visible element, and the App menu's "Sign
# out" item. That item is an RN view labelled by its AXDescription; the sign-out
# confirmation's native "Sign out" button carries the label as its AXTitle, so
# an element titled "Sign out" is never the menu item.
JQ_MENU_DEFS='def visible: ((.w // 0) > 0) and ((.h // 0) > 0);
  def menu_sign_out: .desc == "Sign out" and .title != "Sign out" and visible;'
menu_sign_out_item() { ax_dump | jq -c "$JQ_MENU_DEFS"' map(select(menu_sign_out)) | first // empty'; }
# One AX dump per check: menu_closed is polled.
menu_open() {
  ax_dump | jq -e "$JQ_MENU_DEFS"'
    any(.[]; menu_sign_out or (visible and (.id == "logout-button" or .id == "app-menu")))' > /dev/null 2>&1
}
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
# The confirmation's Cancel: an NSButton titled "Cancel" (description fallback).
sign_out_cancel_button() {
  ax_dump | jq -c '
    map(select(.role == "AXButton" and ((.w // 0) > 0) and ((.h // 0) > 0)))
    | (map(select(.title == "Cancel")) | first) // (map(select(.desc == "Cancel")) | first) // empty'
}
# cancel_sign_out — answer the open confirmation with Cancel, so the app stays
# signed in and usable.
cancel_sign_out() {
  local el
  el=$(sign_out_cancel_button)
  [ -n "$el" ] || return 1
  ax_native_press "$el" || press_el "$el"
  poll 5 sign_out_confirm_closed
}

# sign_out_confirm_copy — which message the open confirmation shows: synced,
# unsynced ("N changes haven't synced and will be lost."), unknown (the count
# failed) or unread. The texts come from describeSignOut in
# packages/shared/src/account/sign-out-copy.ts (the unsynced wording there, the
# others from the SIGN_OUT_* constants in packages/shared/src/constants.ts);
# packages/shared/__tests__/sign-out-copy.test.ts pins the unsynced pattern.
# Only text inside the confirmation counts: the AX dump covers every window, so
# the texts are those under the confirm button's nearest sheet or dialog-window
# ancestor, and a note in the window behind that starts "Everything is synced"
# cannot pass for the dialog's copy. OCR, the fallback when AX exposes no copy,
# reads the whole window, so there the loss wordings win over the synced one.
sign_out_confirm_copy() {
  local copy text
  copy=$(ax_dump | jq -r '
    def visible: ((.w // 0) > 0) and ((.h // 0) > 0);
    def label_is_confirm: . == "Sign out" or . == "Sign out anyway";
    . as $all
    | ($all | map(select(.role == "AXButton" and .id != "logout-button" and visible
        and ((.title | label_is_confirm) or (.desc | label_is_confirm)))) | first) as $btn
    | if $btn == null then empty else
        ($all | map(. as $e | select(
            (.role == "AXSheet" or .subrole == "AXDialog" or .subrole == "AXSystemDialog")
            and ($btn.path | startswith($e.path + "/"))))
          | max_by(.path | length)) as $sheet
        | if $sheet == null then empty else
            [$all[] | select(.path | startswith($sheet.path + "/")) | .value, .title, .desc | strings] as $t
            | if any($t[]; test("^[0-9]+ changes? (hasn.t|haven.t) synced")) then "unsynced"
              elif any($t[]; startswith("Any changes that haven")) then "unknown"
              elif any($t[]; startswith("Everything is synced")) then "synced"
              else empty end
          end
      end' 2> /dev/null)
  if [ -z "$copy" ]; then
    # One capture and OCR pass, matched case-insensitively like ocr_has.
    text=$(ocr_text 2> /dev/null)
    if grep -qiF "synced and will be lost" <<< "$text"; then
      copy=unsynced
    elif grep -qiF "Any changes that" <<< "$text"; then
      copy=unknown
    elif grep -qiF "Everything is synced" <<< "$text"; then
      copy=synced
    fi
  fi
  printf '%s' "${copy:-unread}"
}

# confirm_sign_out [timeout_s] [synced|any] — wait for the sign-out
# confirmation, record its copy in SIGN_OUT_COPY, press its confirm button
# (AXPress, then the focus-and-Space / click press) and wait up to timeout_s for
# the Log In screen.
# Mode "synced" (the default) is for callers that settled first and expect
# nothing pending: unless the dialog reads as the synced copy (it warns of a
# loss, or its copy could not be read) it answers Cancel instead and fails, so
# the harness never accepts data loss by accident. Mode "any" confirms whatever the
# dialog says; only pass it when losing unsynced changes is acceptable.
confirm_sign_out() {
  local timeout=${1:-45} mode=${2:-synced} attempt el
  SIGN_OUT_COPY=unread
  if ! poll 30 sign_out_confirm_open; then
    log "   the sign-out confirmation did not appear; screen reads: $(ocr_text | redact)"
    return 1
  fi
  SIGN_OUT_COPY=$(sign_out_confirm_copy)
  el=$(sign_out_confirm_button)
  # "Sign out anyway" (SIGN_OUT_ANYWAY_LABEL) is the confirm label only of the unsynced copy
  # (describeSignOut), so it decides over the copy read above: the OCR fallback reads the whole
  # window and could take a note's "Everything is synced" for the dialog's copy.
  if jq -e '.title == "Sign out anyway" or .desc == "Sign out anyway"' <<< "$el" > /dev/null 2>&1; then
    SIGN_OUT_COPY=unsynced
  fi
  if [ "$mode" != any ] && [ "$SIGN_OUT_COPY" != synced ]; then
    log "   the sign-out confirmation reads '$SIGN_OUT_COPY', not the synced copy (unsynced changes could be lost): not confirming"
    cancel_sign_out || log "   could not press Cancel on the sign-out confirmation"
    return 1
  fi
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

# sign_out_via_menu [synced|any] — App menu > Sign out, then confirm_sign_out in
# that mode (default synced: refuses a confirmation that warns of a loss).
sign_out_via_menu() {
  open_app_menu || return 1
  choose_sign_out || return 1
  confirm_sign_out 45 "${1:-synced}"
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
