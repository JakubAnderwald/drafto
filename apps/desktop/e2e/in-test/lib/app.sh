#!/bin/bash
# Drafto screens and flows built on ax.sh, db.sh and prod.sh: the predicates a
# scenario uses to check that a press took effect, and the sign-in / sign-out /
# sync-wait building blocks. Expects QA_EMAIL / QA_PASSWORD for log_in.

on_login_screen() { ax_has desc "Log in"; }
on_signup_screen() { ! ax_has desc "Log in" && ax_has desc "Sign up"; }
on_waiting_screen() { ax_has desc "Check approval status"; }
on_main_screen() { ax_has desc "New notebook"; }
menu_open() { ax_has id logout-button || ax_has desc "Sign out"; }
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

sign_out_via_menu() {
  open_app_menu || return 1
  press_until 3 menu_closed id logout-button || press_until 3 menu_closed desc "Sign out" || return 1
  ax_wait 45 desc "Log in"
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
    # The indicator only refreshes its pending count after a sync attempt
    # (#677), so the local DB is the oracle for "a change was waiting".
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
