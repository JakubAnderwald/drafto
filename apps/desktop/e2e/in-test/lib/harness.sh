#!/bin/bash
# Shared entry point for an In-Test scenario: argument parsing, the run
# directory, the libraries, preflight, the production confirmation, the
# throwaway account's credentials, and the EXIT trap that cleans up.
# Guide: docs/operations/macos-in-test-automation.md
#
# A scenario sets these, then runs `source "$IN_TEST_DIR/lib/harness.sh" "$@"`:
#   SCENARIO            slug for the runs directory, e.g. 458-sync-gating
#   SCENARIO_TITLE      report heading, e.g. "#458 desktop sync gating"
#   QA_TAG              goes into the throwaway e-mail, e.g. 458
#   ISSUE, PR           optional: preflight then checks the In-Test markers
#                       (default them as ${ISSUE-<n>} so `ISSUE= PR=` skips that
#                       once the card has shipped)
#   TOGGLES_NETWORK     1 when a step takes the Mac offline (needs sudo)
#   PRODUCTION_SUMMARY  bullet lines naming the scenario's own production writes
# and may define scenario_preflight() for extra read-only checks.
#
# Modes (the scenario's first argument):
#   --preflight     read-only checks, then exit (safe to run any time)
#   (none)          the full run; returns to the scenario once set up
#   --cleanup-only  delete the last run's throwaway account, restore the network
#
# Overrides: DRAFTO_APP (/Applications/Drafto.app), DRAFTO_REPO (this checkout),
# DRAFTO_IN_TEST_RUNS (~/Library/Logs/drafto-in-test), DRAFTO_IN_TEST_BIN
# (in-test/bin), DRAFTO_IN_TEST_EMAIL (jakub+draftoe2e@anderwald.info; the run
# appends -<QA_TAG>-<timestamp> to the local part).
set -uo pipefail

: "${SCENARIO:?}" "${SCENARIO_TITLE:?}" "${QA_TAG:?}"
ISSUE=${ISSUE:-}
PR=${PR:-}
TOGGLES_NETWORK=${TOGGLES_NETWORK:-0}
PRODUCTION_SUMMARY=${PRODUCTION_SUMMARY:-}

IN_TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IN_TEST_BIN=${DRAFTO_IN_TEST_BIN:-$IN_TEST_DIR/bin}
REPO=${DRAFTO_REPO:-$(git -C "$IN_TEST_DIR" rev-parse --show-toplevel)}
APP=${DRAFTO_APP:-/Applications/Drafto.app}
GH_REPO=JakubAnderwald/drafto
RUNS_ROOT="${DRAFTO_IN_TEST_RUNS:-$HOME/Library/Logs/drafto-in-test}/$SCENARIO"
MODE=${1:-run}

case $MODE in
  run | --preflight | --cleanup-only) ;;
  *)
    echo "usage: bash $0 [--preflight | --cleanup-only]" >&2
    exit 2
    ;;
esac

if [ "$MODE" = --cleanup-only ]; then
  RUN_DIR=$(readlink "$RUNS_ROOT/latest" 2> /dev/null || true)
  [ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ] || {
    echo "No previous run found under $RUNS_ROOT." >&2
    exit 1
  }
else
  RUN_DIR="$RUNS_ROOT/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$RUN_DIR/shots"
fi

# shellcheck source=common.sh
source "$IN_TEST_DIR/lib/common.sh"
# shellcheck source=ax.sh
source "$IN_TEST_DIR/lib/ax.sh"
# shellcheck source=db.sh
source "$IN_TEST_DIR/lib/db.sh"
# shellcheck source=prod.sh
source "$IN_TEST_DIR/lib/prod.sh"
# shellcheck source=net.sh
source "$IN_TEST_DIR/lib/net.sh"
# shellcheck source=app.sh
source "$IN_TEST_DIR/lib/app.sh"

QA_EMAIL=""
QA_PASSWORD=""
QA_UID=""
SIGNED_UP=0
ACCOUNT_DELETED=0
BG_PIDS=""

# ── Preflight (read-only) ───────────────────────────────────────────────────

PF_FAIL=0
pf() { # pf <ok|fail|info> <message>
  case $1 in
    ok) log "  ✅ $2" ;;
    fail)
      log "  ❌ $2"
      PF_FAIL=1
      ;;
    *) log "  ℹ️  $2" ;;
  esac
}

# Compile the Swift helpers into IN_TEST_BIN when missing or older than the source.
build_helpers() {
  local name
  mkdir -p "$IN_TEST_BIN" || return 1
  for name in axq ocr; do
    if [ ! -x "$IN_TEST_BIN/$name" ] || [ "$IN_TEST_DIR/lib/$name.swift" -nt "$IN_TEST_BIN/$name" ]; then
      swiftc -O -o "$IN_TEST_BIN/$name" "$IN_TEST_DIR/lib/$name.swift" || return 1
    fi
  done
}

preflight() {
  log "Preflight (read-only) — $SCENARIO_TITLE"
  local t
  for t in cliclick jq sqlite3 curl screencapture gh perl openssl supabase swiftc; do
    command -v "$t" > /dev/null || pf fail "missing tool: $t"
  done
  build_helpers || pf fail "could not compile the Swift helpers into $IN_TEST_BIN"

  # The build under test is the one the factory posted for this card.
  if [ -n "$ISSUE" ]; then
    local installed marker_build marker_sha head labels comments
    installed=$(app_plist CFBundleVersion)
    comments=$(gh api "repos/$GH_REPO/issues/$ISSUE/comments" --paginate --jq '.[].body' 2> /dev/null)
    marker_build=$(grep -oE 'drafto-factory-intest-build:macos:[0-9]+' <<< "$comments" | tail -1 | cut -d: -f3)
    marker_sha=$(grep -oE 'drafto-factory-scenario-sha:[0-9a-f]{40}' <<< "$comments" | tail -1 | cut -d: -f2)
    labels=$(gh issue view "$ISSUE" --repo "$GH_REPO" --json labels -q '.labels[].name' 2> /dev/null)
    if [ -n "$installed" ] && [ "$installed" = "$marker_build" ]; then
      pf ok "installed Drafto build $installed = the In-Test build posted on #$ISSUE"
    else
      pf fail "installed build '${installed:-none}' ≠ In-Test build '${marker_build:-unknown}' — update it from TestFlight"
    fi
    if [ -n "$PR" ]; then
      head=$(gh pr view "$PR" --repo "$GH_REPO" --json headRefOid -q .headRefOid 2> /dev/null)
      if [ -n "$head" ] && [ "$head" = "$marker_sha" ]; then
        pf ok "PR #$PR head ${head:0:12} = the commit the scenario was written for"
      else
        pf fail "PR #$PR head '${head:0:12}' ≠ scenario commit '${marker_sha:0:12}' — the card has moved on"
      fi
    fi
    grep -qx 'status:in-test' <<< "$labels" && pf ok "#$ISSUE is status:in-test" || pf fail "#$ISSUE is not status:in-test"
  fi

  # Match on captured output: with pipefail, `ioreg | grep -q` fails on SIGPIPE.
  if [[ "$(ioreg -n Root -d1)" == *'"IOConsoleLocked" = Yes'* ]]; then
    pf fail "the screen is locked — unlock it (the UI can't be driven or captured while locked)"
  elif [ -z "$(drafto_pid)" ]; then
    pf fail "Drafto is not running (open $APP first)"
  else
    pf ok "screen unlocked"
    # The run drives the running process, so it must be the installed bundle,
    # started after that bundle was last written (a TestFlight update replaces
    # the bundle under a still-running old process).
    local pid exe started written
    pid=$(drafto_pid)
    exe=$(ps -o comm= -p "$pid")
    started=$(LC_ALL=C date -j -f "%a %b %d %T %Y" "$(LC_ALL=C ps -o lstart= -p "$pid" | sed 's/[[:space:]]*$//')" +%s 2> /dev/null)
    written=$(stat -f %m "$APP/Contents/Info.plist" 2> /dev/null)
    if [[ "$exe" != "$APP/"* ]]; then
      pf fail "the running Drafto (pid $pid) is $exe, not $APP"
    elif [ -n "$started" ] && [ -n "$written" ] && [ "$started" -ge "$written" ]; then
      pf ok "the running Drafto was started from $APP after it was installed"
    else
      pf fail "the running Drafto started before $APP was last updated — quit and reopen it"
    fi
    local n
    n=$(ax_dump | jq 'length' 2> /dev/null)
    [ "${n:-0}" -gt 3 ] && pf ok "accessibility tree readable ($n elements)" || pf fail "cannot read Drafto's accessibility tree (Accessibility permission for Terminal?)"
    if win_capture "$RUN_DIR/preflight-window.png" && [ "$("$OCR" "$RUN_DIR/preflight-window.png" | jq '.items | length')" -gt 3 ]; then
      pf ok "window capture + OCR working"
    else
      pf fail "window capture/OCR failed (Screen Recording permission for Terminal?)"
    fi
    rm -f "$RUN_DIR/preflight-window.png"
    if ax_has desc "Sync status"; then
      pf info "app is signed in; sync status '$(sync_help)', $(db_pending) pending local change(s) — a full run signs it out only at Synced/0"
    elif ax_has desc "Log in"; then
      pf info "app is on the login screen"
    else
      pf info "app is on neither the main nor the login screen"
    fi
  fi
  [ -n "$(db_count notes)" ] && pf ok "local WatermelonDB readable" || pf fail "cannot read $WDB (Full Disk Access for Terminal?)"

  if prod_load_env; then
    pf ok "prod Supabase URL/anon key loaded from apps/desktop/.env.production"
    curl -s -o /dev/null -m 5 -H @"$RUN_DIR/.hdr-anon" "$SB_URL/auth/v1/health" && pf ok "prod auth reachable" || pf fail "prod auth unreachable"
  else
    pf fail "apps/desktop/.env.production missing or not pointing at $PROD_REF (run scripts/worktree-bootstrap.sh?)"
  fi
  if supabase projects list -o json 2> /dev/null | jq -e --arg r "$PROD_REF" 'any(.[]; .id == $r or .ref == $r)' > /dev/null; then
    pf ok "Supabase CLI logged in (its token is used for the admin SQL)"
  else
    pf fail "Supabase CLI not logged in (supabase login)"
  fi
  security find-generic-password -s "Supabase CLI" -a supabase > /dev/null 2>&1 || [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] ||
    pf fail "no Supabase CLI token in the keychain and no SUPABASE_ACCESS_TOKEN"

  if [ "$TOGGLES_NETWORK" = 1 ]; then
    local services
    services=$(net_active_services | paste -sd, -)
    [ -n "$services" ] && pf info "the network step will disable: $services" || pf fail "no active network service found"
    net_busy && pf info "a build or support run is active right now — the network step waits for it" || pf ok "no build/support run active"
  fi
  if declare -F scenario_preflight > /dev/null; then
    scenario_preflight
  fi
  rm -f "$RUN_DIR"/.hdr-*
  return $PF_FAIL
}

# ── Cleanup (EXIT trap) ─────────────────────────────────────────────────────

cleanup() {
  local rc=$?
  set +e
  trap - EXIT INT TERM
  # A run that stops outside fail_step (Ctrl-C, die, an unset variable) must
  # not read as a shorter green run.
  [ "$STEP_OPEN" = 1 ] && step_end ABORTED "the run ended (exit $rc) before this step finished"
  if [ "$RUN_COMPLETE" = 1 ]; then
    RUN_OUTCOME="all steps ran (exit $rc)"
  else
    RUN_OUTCOME="STOPPED EARLY (exit $rc) — steps after the last row did not run"
  fi
  net_restore_if_needed
  if [ "$SIGNED_UP" = 1 ] && [ "$ACCOUNT_DELETED" != 1 ]; then
    log "Cleanup: removing the throwaway account $QA_EMAIL"
    # Leave the app on the login screen (it is signed in as the throwaway account).
    if on_main_screen; then
      sign_out_via_menu
    elif on_waiting_screen; then
      press_until 20 on_login_screen desc "Sign out"
    fi
    if [ -s "$RUN_DIR/.hdr-mgmt" ]; then
      local rows
      rows=$(sb_sql "delete from auth.users where email = '$QA_EMAIL' returning id")
      log "Cleanup: deleted $(jq 'length' <<< "${rows:-[]}" 2> /dev/null) auth user(s) for $QA_EMAIL"
    else
      log "Cleanup: no admin token — delete $QA_EMAIL by hand"
    fi
  fi
  clear_clipboard
  local p
  for p in $BG_PIDS; do kill "$p" 2> /dev/null; done
  rm -f "$RUN_DIR"/.hdr-*
  [ "$ACCOUNT_DELETED" = 1 ] && rm -f "$RUN_DIR/state.env"
  write_report
  log "Report: $RUN_DIR/report.md"
  [ -t 1 ] && cat "$RUN_DIR/report.md"
  exit "$rc"
}

# ── --cleanup-only ──────────────────────────────────────────────────────────

if [ "$MODE" = --cleanup-only ]; then
  trap 'rm -f "$RUN_DIR"/.hdr-*' EXIT
  if [ -f "$RUN_DIR/state.env" ]; then
    # shellcheck source=/dev/null
    source "$RUN_DIR/state.env"
  else
    log "No state.env in $RUN_DIR: that run created no account, or already deleted it."
  fi
  [ -s "$NET_DISABLED_FILE" ] && { sudo -v && net_on; }
  if [ -n "$QA_EMAIL" ]; then
    mgmt_init || die "no Supabase CLI token"
    rows=$(sb_sql "delete from auth.users where email = '$QA_EMAIL' returning id") || die "delete failed"
    log "Deleted $(jq 'length' <<< "$rows") auth user(s) for $QA_EMAIL"
  fi
  rm -f "$RUN_DIR"/.hdr-*
  exit 0
fi

# ── Preflight-only ──────────────────────────────────────────────────────────

if [ "$MODE" = --preflight ]; then
  preflight && log "Preflight passed." || log "Preflight FAILED."
  exit $PF_FAIL
fi

# ── Full run: confirm, then set up ──────────────────────────────────────────

# Header files hold secrets from here on; the full cleanup trap replaces this
# one once the run is confirmed.
trap 'rm -f "$RUN_DIR"/.hdr-*' EXIT
trap 'exit 130' INT TERM
preflight || die "preflight failed — nothing was changed"
prod_load_env || die "prod env"

RUN_TAG=$(date +%s)
EMAIL_BASE=${DRAFTO_IN_TEST_EMAIL:-jakub+draftoe2e@anderwald.info}
QA_EMAIL="${EMAIL_BASE%@*}-$QA_TAG-$RUN_TAG@${EMAIL_BASE#*@}"

{
  echo
  echo "This run works against PRODUCTION (Supabase $PROD_REF) and this Mac."
  echo "Throwaway account: $QA_EMAIL"
  [ -n "$PRODUCTION_SUMMARY" ] && printf '%s\n' "$PRODUCTION_SUMMARY"
  if [ "$TOGGLES_NETWORK" = 1 ]; then
    echo "  • disables then re-enables network services ($(net_active_services | paste -sd, -)),"
    echo "    for ~30–60 s, with sudo — the factory and support agent lose the network too"
  fi
  echo "  • deletes the throwaway account at the end (fallback:"
  echo "    delete from auth.users where email = '<that exact e-mail>')"
  echo "Your own account's data is never read or written."
  echo
} >&2
read -r -p "Type YES to run: " answer
[ "$answer" = YES ] || die "not confirmed"
if [ "$TOGGLES_NETWORK" = 1 ]; then
  sudo -v || die "sudo is needed for the network step"
  (while kill -0 $$ 2> /dev/null; do
    sudo -n true 2> /dev/null
    sleep 45
  done) &
  BG_PIDS="$BG_PIDS $!"
  disown $!
fi

mgmt_init || die "could not read the Supabase CLI token"
[ "$(sb_sql 'select 1 as ok' | jq '.[0].ok' 2> /dev/null)" = 1 ] || die "admin SQL check failed"

QA_PASSWORD="Qa-$(openssl rand -hex 8)-Zz"
(
  umask 077
  printf 'QA_EMAIL=%q\nQA_PASSWORD=%q\n' "$QA_EMAIL" "$QA_PASSWORD" > "$RUN_DIR/state.env"
)
# --cleanup-only follows this link, so it moves only once a run has credentials.
ln -sfn "$RUN_DIR" "$RUNS_ROOT/latest"

trap cleanup EXIT
trap 'exit 130' INT TERM

caffeinate -dimsu -w $$ &
BG_PIDS="$BG_PIDS $!"
disown $!
# /usr/bin/log explicitly: common.sh's log() shadows the command.
/usr/bin/log stream --level info --style compact --predicate 'subsystem == "com.facebook.react.log"' > "$RUN_DIR/app.log" 2>&1 &
BG_PIDS="$BG_PIDS $!"
disown $!

log "Run $RUN_TAG — $SCENARIO_TITLE — throwaway account $QA_EMAIL"
ensure_front
sleep 2
