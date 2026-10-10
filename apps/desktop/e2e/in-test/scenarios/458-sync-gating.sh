#!/bin/bash
# In-Test scenario for #458 (PR #673): desktop sync must run only for a
# signed-in AND approved user, and keep working through every trigger (sign-in,
# window focus, the 30 s timer, network reconnect, the manual button, sign-out).
# Drives the installed TestFlight build against PRODUCTION with a throwaway
# account that it deletes at the end. Guide: docs/operations/macos-in-test-automation.md
#
#   bash scenarios/458-sync-gating.sh --preflight     read-only checks
#   bash scenarios/458-sync-gating.sh                 full run (~4 min; start it in Terminal)
#   bash scenarios/458-sync-gating.sh --cleanup-only  delete the last run's account, restore network
#
# The full run signs the app OUT of whatever account it is using (only when
# that account reads "Synced" with nothing pending) and leaves it on the login
# screen. Sign back in yourself afterwards.
#
# First green run: 2026-10-10, build 0.4.1 (59) — 11 PASS, 3 WARN (#675, #676,
# and C12 before it read the local DB).
set -uo pipefail

SCENARIO=458-sync-gating
SCENARIO_TITLE="#458 desktop sync gating"
QA_TAG=458
# The card checks pin the run to the In-Test build. #458 has shipped, so run it
# as a regression check with `ISSUE= PR= bash scenarios/458-sync-gating.sh`.
ISSUE=${ISSUE-458}
PR=${PR-673}
TOGGLES_NETWORK=1
PRODUCTION_SUMMARY="  • signs the Drafto app out of its current account (only if it reads Synced, 0 pending)
  • signs that account up in the app (you get one \"New Drafto signup\" e-mail), confirms
    its e-mail if prod demands it, and approves it with
    update public.profiles set is_approved = true where id = '<that user>'
  • as that user: inserts 1 notebook + 30 notes, edits one note title"

# shellcheck source=../lib/harness.sh
source "$(cd "$(dirname "$0")/.." && pwd)/lib/harness.sh" "$@"

M1="qa458m1x$RUN_TAG"
M2="qa458m2x$RUN_TAG"
M3="qa458m3x$RUN_TAG"
M4="qa458m4x$RUN_TAG"
W1="Web edit $RUN_TAG"
NB_NAME="QA 458 $RUN_TAG"

# ── 0. Sign the current account out ─────────────────────────────────────────
step_begin 0 "Sign the current account out (only at Synced)"
if on_login_screen; then
  step_end PASS "already on the login screen"
else
  # Bringing Drafto forward just started a sync; give it time to finish.
  settle 30 ||
    fail_step "sync status '$(sync_help)' with $(db_pending) pending local change(s) — not signing out (desktop sign-out wipes local data)"
  sign_out_via_menu || fail_step "could not sign out through the App menu"
  step_end PASS "signed out at Synced with 0 pending; login screen shown"
fi
sleep 2
# Baseline for A1b, taken before the sign-up: the old build pulled as soon as
# an unapproved user signed in, so a post-sign-up baseline would hide it.
BASE_PULLED=$(db_last_pulled)
BASE_COUNTS="$(db_count notes)/$(db_count notebooks)"
log "   local DB after sign-out: lastPulledAt='${BASE_PULLED:-unset}', notes/notebooks $BASE_COUNTS"

# ── A1. Sign up ─────────────────────────────────────────────────────────────
step_begin A1 "Sign up a throwaway account in the app"
press_contains_until 2 on_signup_screen "Don't have an account" || fail_step "could not open the sign-up screen"
fill_field "Email" "$QA_EMAIL" || fail_step "could not fill the sign-up Email field"
fill_field "Password" "$QA_PASSWORD" || fail_step "could not fill the sign-up Password field"
SIGNED_UP=1
ax_press desc "Sign up" || fail_step "no Sign up button"
outcome=""
for attempt in 1 2; do
  if [ "$attempt" = 2 ]; then
    log "   sign-up submit had no effect; screen reads: $(ocr_text | redact)"
    ax_press desc "Sign up"
  fi
  end=$(($(date +%s) + 12))
  while [ "$(date +%s)" -lt "$end" ]; do
    if on_waiting_screen; then
      outcome=waiting
      break 2
    fi
    if [ -n "$(sql_user_row)" ]; then
      outcome=created
      break 2
    fi
    sleep 2
  done
done
[ -n "$outcome" ] || fail_step "Sign up created no account; screen reads: $(ocr_text | redact)"
if [ "$outcome" = waiting ] || ax_wait 3 desc "Check approval status"; then
  A1_STATUS=PASS
  A1_NOTE="no e-mail confirmation needed; Awaiting Approval screen shown"
else
  # Prod requires e-mail confirmation ("confirm the e-mail if asked"): record
  # what the app shows, then stand in for the e-mail link with SQL.
  sleep 2
  shot "A1-after-sign-up"
  screen_text=$(ocr_text | redact)
  row=$(sql_user_row)
  [ -n "$(jq -r '.email_confirmed_at // empty' <<< "$row")" ] ||
    sb_sql "update auth.users set email_confirmed_at = now() where email = '$QA_EMAIL' and email_confirmed_at is null returning id" > /dev/null ||
    fail_step "could not confirm the e-mail"
  if grep -qiE 'check your|confirm|verify' <<< "$screen_text"; then
    A1_STATUS=PASS
    prompt="the app asked to confirm the e-mail"
  else
    A1_STATUS=WARN
    prompt="the app gave NO confirm-your-e-mail feedback after Sign up (#675; screen reads: $screen_text)"
  fi
  press_contains_until 2 on_login_screen "Already have an account" || fail_step "could not get back to the login screen"
  log_in on_waiting_screen || fail_step "Awaiting Approval screen never appeared after logging in; screen reads: $(ocr_text | redact)"
  A1_NOTE="prod requires e-mail confirmation — $prompt; confirmed via SQL in place of the e-mail link, logged in, Awaiting Approval shown"
fi
sb_login || fail_step "GoTrue login as the throwaway account failed: $SB_LOGIN_ERR"
QA_UID=$SB_UID
printf 'QA_UID=%q\n' "$QA_UID" >> "$RUN_DIR/state.env"
step_end "$A1_STATUS" "$A1_NOTE; user $QA_UID"

# ── A1b. Unapproved never syncs ─────────────────────────────────────────────
step_begin A1b "Unapproved account never pulls (sign-in sync, retry window, window focus)"
# 35 s outlasts the sync retry delays (2/5/15/30 s). The 30 s periodic timer is
# not exercised here: it only syncs when local changes are pending, and an
# unapproved user cannot make any — that gate is covered by the PR's unit tests.
sleep 35
focus_away_and_back
sleep 6
p1=$(db_last_pulled)
n1="$(db_count notes)/$(db_count notebooks)"
ax_has desc "Check approval status" || fail_step "left the Awaiting Approval screen"
if [ "$p1" != "$BASE_PULLED" ] || [ "$n1" != "$BASE_COUNTS" ]; then
  fail_step "pulled while unapproved: lastPulledAt '${BASE_PULLED:-unset}' (after sign-out) → '${p1:-unset}', notes/notebooks $BASE_COUNTS → $n1"
elif [ -n "$BASE_PULLED" ]; then
  step_end WARN "no pull while unapproved, but the fresh DB already had lastPulledAt=$BASE_PULLED right after sign-out"
else
  step_end PASS "lastPulledAt still unset and notes/notebooks still $n1 after sign-up, 35 s idle and a window-focus event"
fi

# ── A2. Check approval while pending ────────────────────────────────────────
step_begin A2 "Check approval status while still pending"
# The press runs checkApproval, which sets isCheckingApproval, and AppNavigator
# renders only a spinner while that is set (app-navigator.tsx:58). So the
# waiting screen unmounts and its "still pending" error state is lost when it
# comes back — a pre-existing desktop bug, untouched by #673. The press is
# therefore detected by that remount: the button press_el focused is replaced
# by an unfocused one (or by the spinner).
pending_msg_shown() { ocr_has "still pending approval"; }
check_btn_unfocused() { [ "$(ax_find desc "Check approval status" | jq -r '.focused // false')" != true ]; }
A2_FIRED=0 A2_MSG=0
for attempt in 1 2 3 4; do
  if ! ax_press desc "Check approval status"; then
    sleep 1
    continue
  fi
  [ "$PRESS_MODE" = space ] && poll 5 check_btn_unfocused && A2_FIRED=1
  poll 6 pending_msg_shown && A2_MSG=1 && break
  [ "$A2_FIRED" = 1 ] && break
  log "   press on 'Check approval status' had no visible effect (attempt $attempt)"
done
ax_wait 15 desc "Check approval status" || fail_step "left the Awaiting Approval screen (now: $(ocr_text | head -c 200))"
sleep 3
p2=$(db_last_pulled)
n2="$(db_count notes)/$(db_count notebooks)"
if [ "$p2" != "$BASE_PULLED" ] || [ "$n2" != "$BASE_COUNTS" ]; then
  fail_step "Check approval status started a pull while unapproved: lastPulledAt '${BASE_PULLED:-unset}' → '${p2:-unset}', notes/notebooks $BASE_COUNTS → $n2"
fi
if [ "$A2_MSG" = 1 ]; then
  step_end PASS "'Your account is still pending approval.' shown; still on the screen; no pull"
elif [ "$A2_FIRED" = 1 ]; then
  step_end WARN "press registered (the screen reloaded: the focused button was replaced), still on Awaiting Approval, no pull — but no 'still pending approval' message: pre-existing desktop bug #676, checkApproval's isCheckingApproval makes AppNavigator swap the screen for a spinner (app-navigator.tsx:58), unmounting WaitingForApprovalScreen and its error state; not touched by #673"
else
  fail_step "no press on Check approval status registered (focus never left the button; no message)"
fi

# ── A3. Approve + seed ──────────────────────────────────────────────────────
step_begin A3 "Approve the account (SQL) and seed 1 notebook + 30 notes as the user"
rows=$(sb_sql "update public.profiles set is_approved = true where id = '$QA_UID' and is_approved = false returning id") ||
  fail_step "approval SQL failed"
[ "$(jq 'length' <<< "$rows")" = 1 ] || fail_step "expected 1 profile updated, got: $rows"
nb=$(sb_rest POST notebooks "$(jq -nc --arg n "Seed 458 $RUN_TAG" --arg u "$QA_UID" '{name: $n, user_id: $u}')") ||
  fail_step "seed notebook insert failed: $nb"
SEED_NB=$(jq -r '.[0].id' <<< "$nb")
notes=$(jq -nc --arg nb "$SEED_NB" --arg u "$QA_UID" '[range(1; 31) as $i | {
  notebook_id: $nb, user_id: $u, title: "Seed note \($i)",
  content: [{type: "paragraph", content: [{type: "text", text: "Seed body \($i)", styles: {}}]}]}]')
resp=$(sb_rest POST notes "$notes") || fail_step "seed notes insert failed: $resp"
SEED_NOTE=$(jq -r 'map(select(.title == "Seed note 1")) | first | .id' <<< "$resp")
[ "$(sb_count notebooks)" = 1 ] && [ "$(sb_count notes)" = 30 ] || fail_step "server counts after seeding are not 1/30"
step_end PASS "is_approved=true; server has 1 notebook / 30 notes"

# ── A4. Check approval again → first sync ───────────────────────────────────
step_begin A4 "Check approval again: main window opens and the first sync completes"
press_until 20 on_main_screen desc "Check approval status" || fail_step "main window did not open after Check approval status"
settle 45 || fail_step "indicator never settled on Synced (now '$(sync_help)')"
has_30_notes() { [ "$(db_count notes)" = 30 ]; }
poll 30 has_30_notes || true
pulled=$(db_last_pulled)
counts="$(db_count notebooks)/$(db_count notes)"
[ -n "$pulled" ] || fail_step "lastPulledAt still unset after approval"
[ "$counts" = "1/30" ] || fail_step "local notebooks/notes are $counts, expected 1/30"
if ocr_has "Just now"; then
  step_end PASS "Synced · Just now; lastPulledAt=$pulled; pulled 1 notebook / 30 notes"
elif ocr_has "Never"; then
  fail_step "indicator still reads Never"
else
  step_end WARN "Synced and data pulled (lastPulledAt=$pulled), but OCR could not read 'Just now'"
fi

# ── A5. Create on the Mac → reaches the server ──────────────────────────────
step_begin A5 "Create a notebook + note on the Mac; it syncs without clicks"
nb_input_open() { ax_has placeholder "Notebook name"; }
press_until 4 nb_input_open desc "New notebook" || fail_step "the new-notebook field did not open"
fill_field "Notebook name" "$NB_NAME" placeholder || fail_step "could not type the notebook name"
key_return
ax_wait 10 desc "$NB_NAME" || fail_step "notebook '$NB_NAME' did not appear"
qa_selected() { ax_has id new-note-button && ! ax_has desc "Seed note 1"; }
press_until 5 qa_selected desc "$NB_NAME" || fail_step "could not select notebook '$NB_NAME'"
NOTES_BEFORE=$(db_count notes)
note_added() { [ "$(db_count notes)" -gt "$NOTES_BEFORE" ]; }
press_until 6 note_added id new-note-button || press_until 6 note_added desc "New note" ||
  fail_step "New note did not create a note"
poll 10 editor_present || fail_step "the note editor did not open"
sleep 1
type_marker "$M1" || fail_step "the typed text never reached the local DB"
db_marker_in_notebook "$M1" "$NB_NAME" || fail_step "the note landed outside notebook '$NB_NAME'"
poll_synced 60 "$M1" || fail_step "not Synced with the note on the server within 60 s (now '$(sync_help)')"
nb_id=$(sb_rest GET "notebooks?select=id&name=eq.$(jq -rn --arg v "$NB_NAME" '$v | @uri')" | jq -r '.[0].id // empty')
[ -n "$nb_id" ] || fail_step "notebook '$NB_NAME' not on the server"
[ "$ELAPSED" -le 45 ] && st=PASS || st=WARN
step_end "$st" "notebook + note with text on the server, Synced after ${ELAPSED}s (pending seen: $SAW_PENDING)"

# ── B8. Window focus pulls a web edit ───────────────────────────────────────
step_begin B8 "Window focus pulls an edit made on the server"
settle 60 || fail_step "did not settle before the test"
L0=$(db_last_pulled)
sb_rest PATCH "notes?id=eq.$SEED_NOTE" "$(jq -nc --arg t "$W1" '{title: $t}')" > /dev/null || fail_step "REST title edit failed"
sleep 8
ctrl_title=$(db_note_title "$SEED_NOTE")
focus_away_and_back
title_is_w1() { [ "$(db_note_title "$SEED_NOTE")" = "$W1" ]; }
poll 12 title_is_w1 || fail_step "the edit did not arrive within 12 s of the focus switch"
L1=$(db_last_pulled)
[ "$L1" != "$L0" ] || fail_step "title changed but lastPulledAt did not advance"
if [ "$ctrl_title" = "$W1" ]; then
  step_end WARN "edit arrived, but already before the focus switch (another trigger pulled it)"
else
  step_end PASS "unchanged for 8 s without focus; arrived after the focus switch; lastPulledAt $L0 → $L1"
fi

# ── B9. 30 s timer pushes a Mac edit ────────────────────────────────────────
step_begin B9 "Edit on the Mac; the periodic sync pushes it without clicks"
settle 60 || fail_step "did not settle before the test"
type_marker "$M2" || fail_step "the edit never reached the local DB"
poll_synced 60 "$M2" || fail_step "not Synced with the edit on the server within 60 s (now '$(sync_help)')"
[ "$ELAPSED" -le 45 ] && st=PASS || st=WARN
step_end "$st" "pending seen: $SAW_PENDING; Synced and on the server after ${ELAPSED}s"

# ── B10. Reconnect ──────────────────────────────────────────────────────────
step_begin B10 "Offline edit syncs on its own after the network returns"
settle 60 || fail_step "did not settle before the test"
if ! net_wait_idle 600; then
  step_end SKIP "a build or support run stayed active for 10 min; network left alone"
else
  net_off || fail_step "could not disable the network services"
  wait_help 20 '^Offline$' || fail_step "indicator never showed Offline (now '$(sync_help)')"
  type_marker "$M3" || fail_step "the offline edit never reached the local DB"
  sleep 2
  t_on=$(date +%s)
  net_on
  synced=no
  end=$((t_on + 60))
  while [ "$(date +%s)" -lt "$end" ]; do
    if [ "$(sync_help)" = Synced ] && [ "$(db_pending)" = 0 ]; then
      synced=yes
      break
    fi
    sleep 0.3
  done
  secs=$(($(date +%s) - t_on))
  [ "$synced" = yes ] || fail_step "not Synced within 60 s of the network returning (now '$(sync_help)')"
  net_wait_online 60 || fail_step "Supabase unreachable after re-enabling the network"
  poll 30 sb_has_marker "$M3" || fail_step "the offline edit is not on the server"
  if [ "$secs" -le 10 ]; then st=PASS; elif [ "$secs" -le 30 ]; then st=WARN; else st=FAIL; fi
  step_end "$st" "Offline shown; Synced ${secs}s after the network returned (scenario: ~10 s), edit on the server"
  [ "$st" = FAIL ] && exit 1
fi

# ── B11. Manual sync ────────────────────────────────────────────────────────
step_begin B11 "Clicking the indicator syncs"
ensure_front
sleep 3
settle 30 || fail_step "did not settle before the test"
L0=$(db_last_pulled)
SAW_SYNCING=no
pulled_after_click() {
  [ "$(sync_help)" = "Syncing..." ] && SAW_SYNCING=yes
  [ "$(db_last_pulled)" != "$L0" ] && [ "$(sync_help)" = Synced ]
}
press_until 15 pulled_after_click desc "Sync status" || fail_step "no pull after clicking the indicator (lastPulledAt stayed $L0)"
L1=$(db_last_pulled)
ocr_has "Just now" && jn="Just now" || jn="(last-synced text not read)"
step_end PASS "lastPulledAt $L0 → $L1; Syncing... seen: $SAW_SYNCING; $jn"

# ── C12. Sign out with an unsynced edit ─────────────────────────────────────
step_begin C12 "Sign out right after an edit, before it syncs"
settle 60 || fail_step "did not settle before the test"
type_marker "$M4" || fail_step "the edit never reached the local DB"
t0=$(date +%s)
open_app_menu || fail_step "the App menu did not open"
h_before=$(sync_help)
p_before=$(db_pending)
press_until 3 menu_closed id logout-button || press_until 3 menu_closed desc "Sign out" || fail_step "Sign out did not respond"
ax_wait 20 desc "Log in" || fail_step "the login screen did not appear within 20 s"
secs=$(($(date +%s) - t0))
poll 20 sb_has_marker "$M4" || fail_step "the edit made right before sign-out is NOT on the server (lost)"
if [ "${p_before:-0}" -gt 0 ] 2> /dev/null; then
  step_end PASS "signed out with $p_before local change(s) unsynced (indicator: '$h_before'); login screen after ${secs}s; the edit reached the server"
else
  step_end WARN "nothing was pending locally at sign-out (indicator: '$h_before'), so the flush was not exercised; the edit is on the server"
fi

# ── C13. Sign back in ───────────────────────────────────────────────────────
step_begin C13 "Sign back in: everything comes back"
sleep 1
log_in on_main_screen || fail_step "main window did not open after logging back in; screen reads: $(ocr_text | redact)"
srv="$(sb_count notebooks)/$(sb_count notes)"
counts_match() { [ "$(db_count notebooks)/$(db_count notes)" = "$srv" ]; }
poll 60 counts_match || fail_step "local notebooks/notes $(db_count notebooks)/$(db_count notes) ≠ server $srv"
settle 45 || fail_step "indicator never settled on Synced (now '$(sync_help)')"
db_has_marker "$M4" || fail_step "the step-12 edit is missing locally"
title_is_w1 || fail_step "the web title edit is missing locally"
step_end PASS "local = server = $srv notebooks/notes; step-12 edit and web edit present; Synced"

# ── A6. Delete the throwaway account in the app ─────────────────────────────
step_begin A6 "Delete the throwaway account from the App menu"
open_app_menu || fail_step "the App menu did not open"
press_until 5 delete_panel_open id delete-account-menu-item || press_until 5 delete_panel_open desc "Delete account" ||
  fail_step "the delete panel did not open"
{ fill_field "delete-account-input" "DELETE" id || fill_field "Type DELETE to confirm" "DELETE"; } ||
  fail_step "could not type DELETE into the confirmation field"
sleep 0.5
delete_started() { on_login_screen || ! delete_panel_open || [ "$(ax_find id delete-account-confirm | jq -r '.enabled')" = false ]; }
press_until 5 delete_started id delete-account-confirm || press_until 5 delete_started desc "Delete account" AXButton ||
  fail_step "the confirm button did not respond"
ax_wait 45 desc "Log in" || fail_step "not back on the login screen within 45 s"
row=$(sql_user_row) || fail_step "could not check auth.users for $QA_EMAIL (admin SQL failed)"
[ -z "$row" ] || fail_step "auth.users still has $QA_EMAIL"
ACCOUNT_DELETED=1
step_end PASS "account deleted through the app; auth.users row gone; login screen shown"

RUN_COMPLETE=1
log "All steps done. The app is on the login screen — sign back in to your own account."
