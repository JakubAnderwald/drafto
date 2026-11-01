#!/bin/bash
# In-Test scenario for #677 (PR #772): the desktop sync indicator must show a
# local change as "N pending" before its sync starts, count local deletions,
# and still settle on "Synced" once the push has landed. Drives the installed
# TestFlight build against PRODUCTION with a throwaway account that it deletes
# at the end. Guide: docs/operations/macos-in-test-automation.md
#
#   bash scenarios/677-pending-indicator.sh --preflight     read-only checks
#   bash scenarios/677-pending-indicator.sh                 full run (~3 min; start it in Terminal)
#   bash scenarios/677-pending-indicator.sh --cleanup-only  delete the last run's account
#
# Negative control on a build without the fix (P1 and P4 should FAIL there):
#   ISSUE= PR= bash scenarios/677-pending-indicator.sh
# WITH_OFFLINE=1 adds step P5, which takes the Mac offline with sudo (like
# #458's B10) to check the offline state is unchanged.
#
# How the steps decide: a background sampler records the indicator's
# accessibility hint (AXHelp: "Synced" / "Syncing..." / "Offline" /
# "N pending") and the local DB's unpushed-row count about every 0.3 s, and
# each step judges the timeline rather than one read. Nothing in the run brings
# another app forward, because a window activation triggers a sync.
#
# The full run signs the app OUT of whatever account it is using (only when
# that account reads "Synced" with nothing pending) and leaves it on the login
# screen. Sign back in yourself afterwards.
set -uo pipefail

SCENARIO=677-pending-indicator
SCENARIO_TITLE="#677 desktop pending indicator"
QA_TAG=677
# The card checks pin the run to the In-Test build. For the negative control on
# an older build, or once #677 has shipped, run with `ISSUE= PR=`.
ISSUE=${ISSUE-677}
PR=${PR-772}
WITH_OFFLINE=${WITH_OFFLINE:-0}
TOGGLES_NETWORK=$WITH_OFFLINE
PRODUCTION_SUMMARY="  • signs the Drafto app out of its current account (only if it reads Synced, 0 pending)
  • signs a throwaway account up over the auth API (its confirmation e-mail goes to your
    inbox, and you may get one \"New Drafto signup\" e-mail), then confirms and approves it:
    update auth.users set email_confirmed_at = now() where email = '<that e-mail>'
    update public.profiles set is_approved = true where id = '<that user>'
  • as that user: inserts 1 notebook + 3 notes already in Trash; the app then creates
    1 note, types into it, and permanently deletes the 3 trashed notes"

# shellcheck source=../lib/harness.sh
source "$(cd "$(dirname "$0")/.." && pwd)/lib/harness.sh" "$@"

M1="qa677m1x$RUN_TAG"
M2="qa677m2x$RUN_TAG"
M3="qa677m3x$RUN_TAG"
LETTERS="a b c d e f g h i j k l"
NB_NAME="QA 677 $RUN_TAG"
# The acceptance criterion: pending shows "within about 2 s" of a local change.
GRACE_MS=2000

# ── Timeline sampler ────────────────────────────────────────────────────────

now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time * 1000'; }

SAMPLES=""
SAMPLER_PID=""
# sampler_start <label> — append "<ms>\t<AXHelp>\t<db_pending>" to
# $RUN_DIR/timeline-<label>.tsv about every 0.3 s until sampler_stop.
sampler_start() {
  SAMPLES="$RUN_DIR/timeline-$1.tsv"
  : > "$SAMPLES"
  (
    while :; do
      printf '%s\t%s\t%s\n' "$(now_ms)" "$(sync_help)" "$(db_pending)" >> "$SAMPLES"
      sleep 0.2
    done
  ) &
  SAMPLER_PID=$!
  BG_PIDS="$BG_PIDS $SAMPLER_PID"
  sleep 0.5
}

sampler_stop() {
  [ -n "$SAMPLER_PID" ] || return 0
  kill "$SAMPLER_PID" 2> /dev/null
  wait "$SAMPLER_PID" 2> /dev/null
  # Reaped: the EXIT trap must not signal a PID the system may have reused.
  BG_PIDS=" $BG_PIDS "
  BG_PIDS=${BG_PIDS/ $SAMPLER_PID / }
  SAMPLER_PID=""
}

# tl_stats [from_ms] [to_ms] — summarise $SAMPLES as shell assignments (eval
# them). Times are attributed to the sample that starts each interval.
#   TL_N            samples in the window; TL_IVL mean interval (ms)
#   TL_DB_MS        time with unpushed rows in the local DB; TL_MAXDB the most seen
#   TL_FIRST_DB     first sample with unpushed rows (-1 when none)
#   TL_FIRST_SHOWN  first sample reading "N pending" (-1 when none)
#   TL_SHOWN_MS     time the indicator read "N pending"; TL_MAXSHOWN the highest N
#   TL_ZERO         samples reading "0 pending"
#   TL_FIRST_SYNC   first "Syncing..." sample (-1 when none)
#   TL_BUG_MS       time it read "Synced" with unpushed rows, more than GRACE_MS
#                   after those rows appeared or the last sync ended (the bug)
#   TL_STALE_MS     time it read "N pending" with nothing unpushed, more than
#                   GRACE_MS after the DB emptied (a stale count)
#   TL_LAT          ms from TL_FIRST_DB to TL_FIRST_SHOWN (-1 when either is missing
#                   or "pending" was read before any unpushed row was sampled)
#   TL_FIRST_CLEAN  first sample reading "Synced" with nothing unpushed (-1 when none)
#   TL_SEQ          the indicator's states in order, e.g. "Synced → 1 pending → Syncing..."
# Samples whose DB read failed (empty count, e.g. a lock timeout) are skipped
# rather than read as "nothing unpushed".
tl_stats() {
  awk -F'\t' -v from="${1:-0}" -v to="${2:-99999999999999}" -v grace="$GRACE_MS" '
    BEGIN { n = 0; first_db = -1; first_shown = -1; first_sync = -1; first_clean = -1; maxdb = 0
            maxshown = -1; zero = 0; db_ms = 0; shown_ms = 0; bug_ms = 0; stale_ms = 0; seq = ""; last = "" }
    $1 >= from && $1 <= to && $3 ~ /^[0-9]+$/ {
      t = $1; h = $2; d = $3 + 0
      if (n == 0) { t0 = t; onset = t; empty_since = t }
      if (n > 0) {
        dt = t - pt
        if (pd > 0) db_ms += dt
        if (ph ~ /^[0-9]+ pending$/) shown_ms += dt
        if (pd > 0 && ph == "Synced" && pt - onset > grace) bug_ms += dt
        if (pd == 0 && ph ~ /^[0-9]+ pending$/ && pt - empty_since > grace) stale_ms += dt
      }
      # A new burst of unpushed rows, or the end of a sync, restarts the grace.
      if (d > 0 && (n == 0 || pd == 0)) onset = t
      if (n > 0 && ph == "Syncing..." && h != "Syncing...") onset = t
      if (d == 0 && (n == 0 || pd > 0)) empty_since = t
      if (n > 0 && ph == "Syncing..." && h != "Syncing...") empty_since = t
      if (d > 0 && first_db < 0) first_db = t
      if (d > maxdb) maxdb = d
      if (h ~ /^[0-9]+ pending$/) {
        c = h; sub(/ pending$/, "", c); c += 0
        if (first_shown < 0) first_shown = t
        if (c > maxshown) maxshown = c
        if (c == 0) zero++
      }
      if (h == "Syncing..." && first_sync < 0) first_sync = t
      if (h == "Synced" && d == 0 && first_clean < 0) first_clean = t
      if (h != last) { seq = seq (seq == "" ? "" : " → ") (h == "" ? "(none)" : h); last = h }
      pt = t; ph = h; pd = d; n++
    }
    END {
      if (length(seq) > 400) seq = substr(seq, 1, 400) " …"
      printf "TL_N=%d\nTL_IVL=%d\nTL_DB_MS=%d\nTL_MAXDB=%d\nTL_FIRST_DB=%d\nTL_FIRST_SHOWN=%d\n", \
        n, (n > 1 ? (pt - t0) / (n - 1) : 0), db_ms, maxdb, first_db, first_shown
      printf "TL_SHOWN_MS=%d\nTL_MAXSHOWN=%d\nTL_ZERO=%d\nTL_FIRST_SYNC=%d\nTL_BUG_MS=%d\nTL_STALE_MS=%d\n", \
        shown_ms, maxshown, zero, first_sync, bug_ms, stale_ms
      printf "TL_LAT=%d\nTL_FIRST_CLEAN=%d\n", \
        (first_db >= 0 && first_shown >= first_db ? first_shown - first_db : -1), first_clean
      printf "TL_SEQ=\x27%s\x27\n", seq
    }' "$SAMPLES"
}

fmt_s() { LC_ALL=C awk -v m="$1" 'BEGIN { printf "%.1f", m / 1000 }'; }

# lat_txt — how long after the first unpushed row "pending" first showed.
lat_txt() {
  if [ "$TL_LAT" -ge 0 ]; then
    printf '%s ms after the first unpushed row' "$TL_LAT"
  else
    printf 'with no unpushed row sampled before it'
  fi
}

# shown_before_sync — "N pending" was read before the first "Syncing...".
shown_before_sync() {
  [ "$TL_FIRST_SHOWN" -ge 0 ] && { [ "$TL_FIRST_SYNC" -lt 0 ] || [ "$TL_FIRST_SHOWN" -lt "$TL_FIRST_SYNC" ]; }
}

# paste_text <text> — paste at the editor's caret (the caret is already there).
paste_text() {
  printf '%s' "$1" | pbcopy
  osascript -e 'tell application "System Events" to keystroke "v" using command down'
}

db_trashed_live() { db_q "select count(*) from notes where is_trashed = 1 and _status != 'deleted'"; }
srv_trashed() { sb_rest GET "notes?select=id&is_trashed=eq.true" | jq 'length'; }
srv_live() { sb_rest GET "notes?select=id&is_trashed=eq.false" | jq 'length'; }

# The Trash list's per-row "Delete" control has text but no label. Prefer an
# element that itself reads "Delete"; otherwise take the parent of the "Delete"
# text. Exact matches only, so "Delete note" / "Delete notebook" never match.
trash_delete_btn() {
  ax_dump | jq -c '
    . as $all
    | (map(select((.desc == "Delete" or .title == "Delete") and .role != "AXStaticText" and ((.w // 0) > 0))) | first) as $direct
    | if $direct != null then $direct
      else
        (map(select(.role == "AXStaticText" and (((.value // "") == "Delete") or .desc == "Delete")) | .path | sub("/[0-9]+$"; "")) | first) as $parent
        | if $parent == null then empty
          else ($all | map(select(.path == $parent and ((.w // 0) > 0))) | first // empty)
          end
      end'
}
trash_open() { [ -n "$(trash_delete_btn)" ]; }

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

# ── A1. Throwaway account ───────────────────────────────────────────────────
step_begin A1 "Create, confirm and approve a throwaway account; seed 1 notebook + 3 trashed notes; log in"
SIGNED_UP=1
resp=$(jq -nc --arg e "$QA_EMAIL" --arg p "$QA_PASSWORD" '{email: $e, password: $p}' |
  curl -sS -X POST "$SB_URL/auth/v1/signup" -H @"$RUN_DIR/.hdr-anon" \
    -H 'Content-Type: application/json' --data-binary @- -w '\n%{http_code}')
code=${resp##*$'\n'}
# Only the error fields are logged: a success body can carry a session.
http_ok "$code" ||
  fail_step "auth sign-up returned $code: $(jq -r '.msg // .error_description // .error // "no detail"' <<< "${resp%$'\n'*}" 2> /dev/null)"
unset resp
row=$(sql_user_row) || fail_step "could not read auth.users for $QA_EMAIL (admin SQL failed)"
[ -n "$row" ] || fail_step "the sign-up created no auth.users row"
if [ -z "$(jq -r '.email_confirmed_at // empty' <<< "$row")" ]; then
  sb_sql "update auth.users set email_confirmed_at = now() where email = '$QA_EMAIL' and email_confirmed_at is null returning id" > /dev/null ||
    fail_step "could not confirm the e-mail"
fi
sb_login || fail_step "GoTrue login as the throwaway account failed: $SB_LOGIN_ERR"
QA_UID=$SB_UID
printf 'QA_UID=%q\n' "$QA_UID" >> "$RUN_DIR/state.env"
rows=$(sb_sql "update public.profiles set is_approved = true where id = '$QA_UID' and is_approved = false returning id") ||
  fail_step "approval SQL failed"
[ "$(jq 'length' <<< "$rows")" = 1 ] || fail_step "expected 1 profile updated, got: $rows"
nb=$(sb_rest POST notebooks "$(jq -nc --arg n "$NB_NAME" --arg u "$QA_UID" '{name: $n, user_id: $u}')") ||
  fail_step "seed notebook insert failed: $nb"
SEED_NB=$(jq -r '.[0].id' <<< "$nb")
notes=$(jq -nc --arg nb "$SEED_NB" --arg u "$QA_UID" '[range(1; 4) as $i | {
  notebook_id: $nb, user_id: $u, title: "Trashed 677 \($i)", is_trashed: true,
  trashed_at: (now - $i | todate),
  content: [{type: "paragraph", content: [{type: "text", text: "Trashed body \($i)", styles: {}}]}]}]')
resp=$(sb_rest POST notes "$notes") || fail_step "seed notes insert failed: $resp"
[ "$(srv_trashed)" = 3 ] || fail_step "the server does not have the 3 trashed seed notes"
log_in on_main_screen || fail_step "main window did not open after logging in; screen reads: $(ocr_text | redact)"
has_trash_seed() { [ "$(db_trashed_live)" = 3 ]; }
poll 45 has_trash_seed || fail_step "the 3 trashed seed notes never reached the local DB (has $(db_trashed_live))"
settle 45 || fail_step "indicator never settled on Synced after the first sync (now '$(sync_help)', $(db_pending) pending)"
step_end PASS "user $QA_UID approved; logged in through the UI; first sync pulled 1 notebook + 3 trashed notes; Synced, 0 pending"

# ── P0. Create a note ───────────────────────────────────────────────────────
step_begin P0 "Create a note: the indicator shows it pending before its sync"
nb_selected() { ax_has id new-note-button; }
press_until 5 nb_selected desc "$NB_NAME" || fail_step "could not select notebook '$NB_NAME'"
settle 30 || fail_step "did not settle before the test (now '$(sync_help)')"
NOTES_BEFORE=$(db_count notes)
SRV_LIVE_BEFORE=$(srv_live)
note_added() { [ "$(db_count notes)" -gt "$NOTES_BEFORE" ]; }
sampler_start P0
press_until 6 note_added id new-note-button || press_until 6 note_added desc "New note" ||
  fail_step "New note did not create a note"
poll 10 editor_present || fail_step "the note editor did not open"
poll 20 synced_idle || fail_step "not back to Synced/0 within 20 s of creating the note (now '$(sync_help)')"
sleep 2
sampler_stop
eval "$(tl_stats)"
[ "$(srv_live)" = $((SRV_LIVE_BEFORE + 1)) ] || fail_step "the new note is not on the server (live notes $SRV_LIVE_BEFORE → $(srv_live))"
if [ "$TL_ZERO" -gt 0 ]; then
  step_end FAIL "the indicator read '0 pending' ($TL_ZERO samples). Indicator: $TL_SEQ"
elif shown_before_sync; then
  step_end PASS "'$TL_MAXSHOWN pending' before Syncing..., $(lat_txt), for ~$(fmt_s "$TL_SHOWN_MS") s; then Synced and on the server. Indicator: $TL_SEQ"
else
  step_end WARN "no 'N pending' caught before Syncing... (the window is ~1 s online by design; sampling every ~${TL_IVL} ms); DB had the unpushed row for ~$(fmt_s "$TL_DB_MS") s. Indicator: $TL_SEQ"
fi

# ── P1. Slow typing ─────────────────────────────────────────────────────────
step_begin P1 "Type one character about every 0.8 s for ~10 s: 'N pending' while the DB has unpushed rows"
settle 30 || fail_step "did not settle before the test (now '$(sync_help)')"
sampler_start P1
# The marker's own write starts the burst. Each later paste is saved 0.5 s after
# it lands (autosave), so the writes stay under the 1.5 s local-edit sync
# debounce and the edit stays unpushed until the typing stops (or a 30 s tick).
type_marker "$M1" || fail_step "the typed marker never reached the local DB"
for l in $LETTERS; do
  sleep 0.55
  paste_text "$l"
done
T_LAST=$(now_ms)
# osascript returns before Drafto reads the pasteboard: clearing it at once
# would turn the last paste into an empty one.
sleep 0.6
clear_clipboard
eval "$(tl_stats 0 "$T_LAST")"
P1_DETAIL="DB had unpushed rows for ~$(fmt_s "$TL_DB_MS") s; indicator read 'N pending' for ~$(fmt_s "$TL_SHOWN_MS") s"
if [ "$TL_DB_MS" -lt 3000 ]; then
  step_end WARN "inconclusive: the typing kept rows unpushed for only ~$(fmt_s "$TL_DB_MS") s. Indicator: $TL_SEQ"
elif [ "$TL_FIRST_SHOWN" -lt 0 ]; then
  step_end FAIL "the #677 bug: $P1_DETAIL — never 'pending'. Indicator: $TL_SEQ"
elif [ "$TL_ZERO" -gt 0 ]; then
  step_end FAIL "the indicator read '0 pending' ($TL_ZERO samples); $P1_DETAIL. Indicator: $TL_SEQ"
elif [ "$TL_LAT" -gt "$GRACE_MS" ] || [ "$TL_BUG_MS" -gt 1000 ]; then
  step_end FAIL "$P1_DETAIL; first 'pending' $(lat_txt); 'Synced' with unpushed rows beyond the ${GRACE_MS} ms grace for ~$(fmt_s "$TL_BUG_MS") s. Indicator: $TL_SEQ"
else
  step_end PASS "$P1_DETAIL; first '$TL_MAXSHOWN pending' $(lat_txt); 'Synced' with unpushed rows beyond the grace ~$(fmt_s "$TL_BUG_MS") s. Indicator: $TL_SEQ"
fi

# ── P2. Stop typing ─────────────────────────────────────────────────────────
step_begin P2 "Stop typing: Syncing... then Synced, nothing unpushed, the text on the server"
FINAL="$M1$(tr -d ' ' <<< "$LETTERS")"
# The last character is saved 0.5 s after its paste (autosave).
if poll 3 db_has_marker "$FINAL"; then
  P2_NOTE="all $(wc -w <<< "$LETTERS" | tr -d ' ') characters reached the local DB"
else
  P2_NOTE="some pasted characters were dropped (checking the marker only)"
  FINAL=$M1
fi
poll_synced 30 "$FINAL" || {
  sampler_stop
  fail_step "not Synced with the text on the server within 30 s of the last key (now '$(sync_help)', $(db_pending) pending)"
}
sleep 3
sampler_stop
eval "$(tl_stats "$T_LAST")"
# Timed from the last key (T_LAST), not from when poll_synced started.
if [ "$TL_FIRST_CLEAN" -ge 0 ]; then
  P2_MS=$((TL_FIRST_CLEAN - T_LAST))
else
  P2_MS=$(($(now_ms) - T_LAST))
fi
ocr_has "Just now" && jn="'Just now' shown" || jn="(last-synced text not read)"
if [ "$TL_STALE_MS" -gt 600 ]; then
  step_end FAIL "a stale 'N pending' stayed ~$(fmt_s "$TL_STALE_MS") s after the DB emptied; $P2_NOTE. Indicator: $TL_SEQ"
elif [ "$P2_MS" -le 10000 ]; then
  step_end PASS "Synced with 0 unpushed $(fmt_s "$P2_MS") s after the last key, and the text on the server; $jn; $P2_NOTE. Indicator: $TL_SEQ"
else
  step_end WARN "Synced and on the server, but only $(fmt_s "$P2_MS") s after the last key (expected ~2–3 s); $P2_NOTE. Indicator: $TL_SEQ"
fi

# ── P3. One word ────────────────────────────────────────────────────────────
step_begin P3 "Type one word and stop: 'N pending' shows briefly, then Syncing... → Synced"
settle 30 || fail_step "did not settle before the test (now '$(sync_help)')"
sampler_start P3
type_marker "$M2" || fail_step "the typed word never reached the local DB"
clear_clipboard
poll_synced 30 "$M2" || {
  sampler_stop
  fail_step "not Synced with the word on the server within 30 s (now '$(sync_help)')"
}
sleep 3
sampler_stop
eval "$(tl_stats)"
if [ "$TL_STALE_MS" -gt 600 ]; then
  step_end FAIL "a stale 'N pending' stayed ~$(fmt_s "$TL_STALE_MS") s after the DB emptied. Indicator: $TL_SEQ"
elif shown_before_sync; then
  step_end PASS "'$TL_MAXSHOWN pending' for ~$(fmt_s "$TL_SHOWN_MS") s before Syncing..., $(lat_txt); Synced and on the server ${ELAPSED}s after the paste. Indicator: $TL_SEQ"
else
  step_end WARN "no 'N pending' caught before Syncing... (~1 s window by design; sampling every ~${TL_IVL} ms; P1 is the main check); Synced and on the server ${ELAPSED}s after the paste. Indicator: $TL_SEQ"
fi

# ── P4. Local deletions ─────────────────────────────────────────────────────
step_begin P4 "Permanently delete the 3 trashed notes about 1 s apart: the indicator counts them"
settle 30 || fail_step "did not settle before the test (now '$(sync_help)')"
press_until 5 trash_open desc "Trash" || {
  ax_dump > "$RUN_DIR/trash-ax.json" 2> /dev/null
  fail_step "the Trash list (with its Delete buttons) did not open; AX tree in trash-ax.json"
}
ax_dump > "$RUN_DIR/trash-ax.json" 2> /dev/null
sleep 1
settle 15 || fail_step "opening Trash left the indicator at '$(sync_help)'"
TRASH0=$(db_trashed_live)
# Notes that have left Trash. Unlike a count of `_status = 'deleted'` rows, a
# push can't undo it: WatermelonDB destroys deleted rows once they are synced.
removed() {
  local left _
  for _ in 1 2 3; do
    left=$(db_trashed_live)
    [ -n "$left" ] && break
    sleep 0.3
  done
  # An unreadable DB counts as "nothing new", never as a reason to press again.
  echo $((TRASH0 - ${left:-$TRASH0}))
}
sampler_start P4
presses=0
while [ "$(removed)" -lt 3 ]; do
  [ "$presses" -lt 5 ] || {
    sampler_stop
    fail_step "only $(removed) of 3 notes left Trash after $presses presses on Delete"
  }
  t_press=$(now_ms)
  before=$(removed)
  btn=$(trash_delete_btn)
  [ -n "$btn" ] || {
    sampler_stop
    fail_step "no Delete button left in Trash after $before deletion(s)"
  }
  press_el "$btn"
  presses=$((presses + 1))
  # Wait long enough that a slow write isn't mistaken for a missed press, which
  # would delete one note too many on the retry.
  removed_more() { [ "$(removed)" -gt "$before" ]; }
  poll 5 removed_more || {
    log "   Delete press $presses had no effect; pressing again"
    continue
  }
  # About one deletion a second, from press to press.
  wait_ms=$((1000 - ($(now_ms) - t_press)))
  [ "$wait_ms" -gt 0 ] && [ "$(removed)" -lt 3 ] && sleep "$(LC_ALL=C awk -v m="$wait_ms" 'BEGIN { printf "%.2f", m / 1000 }')"
done
poll 20 synced_idle || {
  sampler_stop
  fail_step "not back to Synced/0 within 20 s of the deletions (now '$(sync_help)', $(db_pending) pending)"
}
sleep 3
sampler_stop
eval "$(tl_stats)"
srv_left=$(srv_trashed)
counts=$(awk -F'\t' '$2 ~ /^[0-9]+ pending$/ { sub(/ pending$/, "", $2); if (!seen[$2]++) printf "%s%s", (n++ ? "," : ""), $2 }' "$SAMPLES")
if [ "$srv_left" != 0 ]; then
  step_end FAIL "$srv_left trashed note(s) still on the server after Synced. Indicator: $TL_SEQ"
elif [ "$TL_ZERO" -gt 0 ]; then
  step_end FAIL "the indicator read '0 pending' while deletions were unpushed: deletions are not counted. Indicator: $TL_SEQ"
elif [ "$TL_FIRST_SHOWN" -lt 0 ]; then
  step_end FAIL "the #677 bug: up to $TL_MAXDB deletion(s) unpushed for ~$(fmt_s "$TL_DB_MS") s, never 'pending'. Indicator: $TL_SEQ"
elif [ "$TL_MAXSHOWN" = "$TL_MAXDB" ] && [ "$TL_BUG_MS" -le 1000 ] && [ "$TL_STALE_MS" -le 600 ]; then
  step_end PASS "counts shown: ${counts:-none} pending (DB peaked at $TL_MAXDB unpushed); Synced and the 3 notes gone from the server. Indicator: $TL_SEQ"
elif [ "$TL_BUG_MS" -le 1000 ] && [ "$TL_STALE_MS" -le 600 ]; then
  step_end WARN "counted (shown: ${counts:-none} pending) but the sampler missed the peak of $TL_MAXDB; Synced and the 3 notes gone from the server. Indicator: $TL_SEQ"
else
  step_end FAIL "counts shown: ${counts:-none} pending, DB peaked at $TL_MAXDB; 'Synced' with unpushed rows beyond the grace ~$(fmt_s "$TL_BUG_MS") s; stale pending ~$(fmt_s "$TL_STALE_MS") s. Indicator: $TL_SEQ"
fi

# ── P5. Offline (optional) ──────────────────────────────────────────────────
step_begin P5 "Offline: an edit keeps the indicator on Offline, then syncs on reconnect"
if [ "$WITH_OFFLINE" != 1 ]; then
  step_end SKIP "not run (set WITH_OFFLINE=1; it needs sudo and takes the Mac offline)"
else
  # Back to the note: the Trash view has no editor.
  press_until 5 nb_selected desc "$NB_NAME" || fail_step "could not reselect notebook '$NB_NAME'"
  press_until 5 editor_present desc "Untitled" || press_contains_until 5 editor_present "$M1" ||
    fail_step "could not reopen the test note"
  settle 30 || fail_step "did not settle before the test"
  if ! net_wait_idle 600; then
    step_end SKIP "a build or support run stayed active for 10 min; network left alone"
  else
    net_off || fail_step "could not disable the network services"
    wait_help 20 '^Offline$' || fail_step "indicator never showed Offline (now '$(sync_help)')"
    sampler_start P5
    type_marker "$M3" || fail_step "the offline edit never reached the local DB"
    clear_clipboard
    sleep 4
    T_ON=$(now_ms)
    net_on
    synced=no
    poll 60 synced_idle && synced=yes
    sampler_stop
    secs_on=$((($(now_ms) - T_ON) / 1000))
    eval "$(tl_stats 0 "$T_ON")"
    [ "$synced" = yes ] || fail_step "not Synced within 60 s of the network returning (now '$(sync_help)')"
    net_wait_online 60 || fail_step "Supabase unreachable after re-enabling the network"
    poll 30 sb_has_marker "$M3" || fail_step "the offline edit is not on the server"
    if [ "$TL_FIRST_SHOWN" -ge 0 ]; then
      step_end WARN "while offline the indicator read 'N pending' instead of 'Offline' (a change from before); Synced ${secs_on}s after reconnect. Indicator: $TL_SEQ"
    elif [ "$secs_on" -le 10 ]; then
      step_end PASS "Offline throughout (~$(fmt_s "$TL_DB_MS") s with the edit unpushed); Synced ${secs_on}s after the network returned; edit on the server. Indicator: $TL_SEQ"
    else
      step_end WARN "Offline throughout; Synced only ${secs_on}s after the network returned (scenario: ~10 s). Indicator: $TL_SEQ"
    fi
  fi
fi

RUN_COMPLETE=1
log "All steps done. The cleanup signs the throwaway account out and deletes it; sign back in to your own account afterwards."
