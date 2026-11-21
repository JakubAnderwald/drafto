#!/bin/bash
set -euo pipefail

# PrimeTestLab report 10668 E2E runner
#
# Runs the report's Maestro flows (each tagged `qa-10668`) on one device, and
# after the layout flows runs the host-side checks Maestro can't make itself
# (scripts/lib/maestro-layout-checks.mjs): Maestro's `below:` compares only top
# edges and `tapOn` succeeds on a half-covered button, so the FAB under the nav
# bar, the banner over the Back arrow, a broken image and a light nav bar all
# pass a Maestro assertion before the fix. The checks read `maestro hierarchy`,
# `adb shell dumpsys window` and a screenshot instead.
#
# Usage:
#   run-qa-10668-e2e.sh [android|ios] [--before] [--allow-host-offline]
#                       [--device <serial|udid>] [--out <dir>] [--only <regex>]
#                       [--require-all] [--keep-device-state]
#
#   android|ios           platform (default: android)
#   --before              run against a build without the fixes: every report
#                         check is expected to FAIL, and is listed as
#                         "reproduced" only when it measured the element and
#                         found it wrong. Exits non-zero if any of them passes,
#                         because that check can't tell a fixed build from a
#                         broken one, and if any could not measure (a check
#                         error, the element missing, a missing flow, a flow
#                         Maestro exited on before any of its commands
#                         failed): "NOT MEASURED" proves nothing either way.
#   --allow-host-offline  iOS only: the simulator has no airplane mode, so the
#                         offline legs take this whole Mac offline with
#                         apps/desktop/e2e/in-test/lib/net.sh (sudo, kept alive
#                         for the run; a root watchdog restores the network
#                         after NET_WATCHDOG_S, default 300 s here, which covers
#                         a leg's offline phase and capture). Without it the
#                         offline legs are skipped. This also cuts off anything
#                         else on the Mac, a Claude session included, until
#                         the leg ends.
#   --device              adb serial or simulator UDID (default: the only
#                         emulator, or the booted simulator)
#   --out                 where screenshots, hierarchy dumps, logs and the
#                         summary go (default: a new folder under $TMPDIR).
#                         Screenshots show note content: don't commit them.
#   --only                run only the report steps whose flow path matches
#   --require-all         fail a step whose flow doesn't exist yet, instead of
#                         skipping it
#   --keep-device-state   Android: leave the nav mode and night mode as the run
#                         set them (default: restore them on exit)
#
# Prerequisites: the build under test installed on a booted emulator or
# simulator, `maestro` on PATH (or MAESTRO=<path>), node, and the E2E test
# account in apps/web/.env.local (E2E_TEST_EMAIL / E2E_TEST_PASSWORD, dev
# project; QA_ENV_FILE=<file> reads another file). Offline legs on Android
# need a release APK built against dev, because a debug build loses Metro
# (10.0.2.2:8081) in airplane mode; see docs/architecture/testing.md,
# "Offline flows on Android". The runner refuses an installed build (APK or
# .app, debug or release) that names the production project anywhere, or
# whose expo-constants app.config doesn't name the dev project.
#
# Contract with the flows (the env the runner passes to each one):
#   RUN_ID, E2E_TEST_EMAIL   always, as -e arguments
#   MAESTRO_E2E_TEST_PASSWORD
#                       always, in the environment and never in argv (where
#                       `ps` shows it): Maestro hands every MAESTRO_* shell
#                       variable to the flow. A flow that also runs under
#                       `-e E2E_TEST_PASSWORD=…` reads it as 01-login.yaml does.
#   QA_KEEP_OFFLINE=1   Android offline flows: leave airplane mode on at the
#                       end (their onFlowComplete restores it only when this is
#                       unset), so the host check sees the offline screen. The
#                       runner turns it off after the check, and on exit.
#   QA_PHASE=prepare|offline|reconnect
#                       iOS offline flows: `prepare` runs online, `offline`
#                       while the Mac is offline (ending on the screen to
#                       check), `reconnect` online again. A flow ignores a
#                       phase it has no steps for.
#   QA_NO_PROBES=1      android-only/09-offline-image, --before only: the build
#                       has no E2E image probes (EXPO_PUBLIC_E2E_PROBES), so
#                       the flow skips its probe waits and still ends offline
#                       on the note for the host check.
#   QA_THEME=dark|light|system
#                       android-only/11-dark-nav-bar: the in-app theme to pick
#                       in Settings before ending on the Notebooks tab.
#                       android-only/12-delete-dialog-nav-bar picks it the same
#                       way, then ends with the delete-account dialog open.
#   SIGN_OUT_CONFIRM=1  11-sign-out-confirm: also run the confirm leg. Only
#                       when SIGN_OUT_CONFIRM=1 is in this runner's environment.
#                       Mobile sign-out is global, so the leg signs in as a
#                       dedicated dev account first (E2E_SIGNOUT_EMAIL /
#                       E2E_SIGNOUT_PASSWORD in the env file, required then)
#                       and signs that one out, never the shared E2E user whose
#                       session web CI's Playwright run uses.
#   E2E_SIGNOUT_EMAIL   with SIGN_OUT_CONFIRM=1, or --before when the env file
#                       has the account (otherwise --before skips the step), as
#                       an -e argument to that step, which then runs on it;
#                       MAESTRO_E2E_SIGNOUT_PASSWORD in the environment, never
#                       argv, like MAESTRO_E2E_TEST_PASSWORD.
# Each layout flow ends with the app on the screen its host check reads.

PLATFORM=android
BEFORE=0
ALLOW_HOST_OFFLINE=0
DEVICE=""
OUT=""
ONLY=""
REQUIRE_ALL=0
KEEP_DEVICE_STATE=0

usage() {
  sed -n '/^# Usage:/,/^# Prerequisites:/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    android | ios) PLATFORM="$1" ;;
    --before) BEFORE=1 ;;
    --allow-host-offline) ALLOW_HOST_OFFLINE=1 ;;
    --device)
      [ $# -ge 2 ] || usage
      DEVICE="$2"
      shift
      ;;
    --out)
      [ $# -ge 2 ] || usage
      OUT="$2"
      shift
      ;;
    --only)
      [ $# -ge 2 ] || usage
      ONLY="$2"
      shift
      ;;
    --require-all) REQUIRE_ALL=1 ;;
    --keep-device-state) KEEP_DEVICE_STATE=1 ;;
    -h | --help) usage ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
  shift
done

if [ "$ALLOW_HOST_OFFLINE" = 1 ] && [ "$PLATFORM" != ios ]; then
  echo "--allow-host-offline is for iOS; Android flows use airplane mode." >&2
  exit 2
fi
# An --only that grep can't compile would match no flow, and the run would
# report OK without running a single report step.
if [ -n "$ONLY" ]; then
  only_status=0
  printf '' | grep -Eq -- "$ONLY" 2> /dev/null || only_status=$?
  if [ "$only_status" -gt 1 ]; then
    echo "ERROR: --only '$ONLY' is not a valid extended regular expression" >&2
    exit 2
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
E2E_DIR="$SCRIPT_DIR"
CHECKS="$REPO_ROOT/scripts/lib/maestro-layout-checks.mjs"
NET_SH="$REPO_ROOT/apps/desktop/e2e/in-test/lib/net.sh"
APP_ID="eu.drafto.mobile"
PROD_REF="tbmjbxxseonkciqovnpl"
DEV_REF="huhzactreblzcogqkbsd"

MAESTRO="${MAESTRO:-$(command -v maestro || true)}"
[ -n "$MAESTRO" ] || MAESTRO="$HOME/.maestro/bin/maestro"
if [ ! -x "$MAESTRO" ]; then
  echo "ERROR: maestro not found on PATH or at $MAESTRO (brew install maestro, or set MAESTRO)" >&2
  exit 2
fi
command -v node > /dev/null || {
  echo "ERROR: node is required for the host checks" >&2
  exit 2
}
# redact_out scrubs the test passwords with perl; without it, Maestro's logs
# would keep them, so refuse to start.
command -v perl > /dev/null || {
  echo "ERROR: perl is required to scrub the test passwords from the saved logs" >&2
  exit 2
}

if [ "$PLATFORM" = android ]; then
  ADB="${ADB:-$(command -v adb || true)}"
  [ -n "$ADB" ] || ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
  [ -x "$ADB" ] || {
    echo "ERROR: adb not found (set ADB or ANDROID_HOME)" >&2
    exit 2
  }
fi

# --- Test account: loaded from the web env file, never printed ---
ENV_FILE="${QA_ENV_FILE:-$REPO_ROOT/apps/web/.env.local}"
[ -f "$ENV_FILE" ] || {
  echo "ERROR: $ENV_FILE is missing (run scripts/worktree-bootstrap.sh)" >&2
  exit 2
}
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
for var in E2E_TEST_EMAIL E2E_TEST_PASSWORD NEXT_PUBLIC_SUPABASE_URL; do
  [ -n "${!var:-}" ] || {
    echo "ERROR: $var is not set in $ENV_FILE" >&2
    exit 2
  }
done
case "$NEXT_PUBLIC_SUPABASE_URL" in
  *"$PROD_REF"*)
    echo "ERROR: $ENV_FILE points at the production project; E2E runs use dev" >&2
    exit 2
    ;;
esac
export E2E_TEST_PASSWORD
export MAESTRO_E2E_TEST_PASSWORD="$E2E_TEST_PASSWORD"

# --- The sign-out account: SIGN_OUT_CONFIRM=1, or --before ---
# 11-sign-out-confirm signs its account out on every device when it confirms
# (the app's sign-out is global), and so does a build without the fix at the
# first tap. On the shared E2E user that ends the session web CI's Playwright
# run shares, mid-run (it failed #877's E2E on 2026-11-21), so in both cases
# the flow runs on a dedicated dev account. SIGN_OUT_CONFIRM=1 refuses without
# one; --before without one skips that step (below).
SIGNOUT_ACCOUNT=0
if [ "${SIGN_OUT_CONFIRM:-0}" = 1 ]; then
  for var in E2E_SIGNOUT_EMAIL E2E_SIGNOUT_PASSWORD; do
    [ -n "${!var:-}" ] || {
      echo "ERROR: SIGN_OUT_CONFIRM=1 needs $var in $ENV_FILE: a dedicated, approved dev account, never the shared E2E user (apps/mobile/e2e/README.md)" >&2
      exit 2
    }
  done
  SIGNOUT_ACCOUNT=1
elif [ "$BEFORE" = 1 ] && [ -n "${E2E_SIGNOUT_EMAIL:-}" ] && [ -n "${E2E_SIGNOUT_PASSWORD:-}" ]; then
  SIGNOUT_ACCOUNT=1
fi
if [ "$SIGNOUT_ACCOUNT" = 1 ]; then
  # Trimmed and lower-cased, as the app's login trims the email: a stray space
  # would otherwise let the shared user through.
  norm_email() { printf '%s' "$1" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'; }
  if [ "$(norm_email "$E2E_SIGNOUT_EMAIL")" = "$(norm_email "$E2E_TEST_EMAIL")" ]; then
    echo "ERROR: E2E_SIGNOUT_EMAIL is the shared E2E user; the sign-out step would sign it out everywhere" >&2
    exit 2
  fi
  export E2E_SIGNOUT_PASSWORD
  export MAESTRO_E2E_SIGNOUT_PASSWORD="$E2E_SIGNOUT_PASSWORD"
fi

RUN_ID="${RUN_ID:-$(date +%s)}"
MODE_LABEL=$([ "$BEFORE" = 1 ] && echo before || echo after)
OUT="${OUT:-${TMPDIR:-/tmp}/drafto-qa-10668-$PLATFORM-$MODE_LABEL-$RUN_ID}"
mkdir -p "$OUT/maestro"
OUT="$(cd "$OUT" && pwd)"
RESULTS="$OUT/results.tsv"
: > "$RESULTS"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/run.log"; }

# Maestro logs each typed text, the passwords included (its --debug-output,
# which run_flow points under $OUT, keeps the commands it ran): scrub them from
# every file under $OUT that contains one, whatever its name. The commands JSON
# holds them JSON-escaped (a `"` as `\"`, a `\` as `\\`), so both forms go.
# grep and perl read each value from a pipe and the environment, never argv:
# only the variable's name is passed (REDACT_VAR). The longer value goes first,
# so one that contains the other can't leave its tail behind.
redact_out() {
  local var order signout="${E2E_SIGNOUT_PASSWORD:-}"
  order="E2E_TEST_PASSWORD E2E_SIGNOUT_PASSWORD"
  [ "${#signout}" -le "${#E2E_TEST_PASSWORD}" ] || order="E2E_SIGNOUT_PASSWORD E2E_TEST_PASSWORD"
  for var in $order; do
    [ -n "${!var:-}" ] || continue
    # The JSON form is JSON::PP's (core perl): quotes, backslashes and control
    # characters escaped the way Maestro's commands JSON has them.
    {
      REDACT_VAR="$var" perl -MJSON::PP -e '$p = $ENV{$ENV{REDACT_VAR}}; print "$p\n", substr(JSON::PP->new->allow_nonref->encode($p), 1, -1), "\n"' |
        LC_ALL=C grep -r -l -F --null -f - "$OUT" 2> /dev/null || true
    } |
      REDACT_VAR="$var" xargs -0 -r perl -MJSON::PP -pi -e 'BEGIN { $p = $ENV{$ENV{REDACT_VAR}}; $j = substr(JSON::PP->new->allow_nonref->encode($p), 1, -1) } s/\Q$j\E/[redacted]/g; s/\Q$p\E/[redacted]/g' 2> /dev/null || true
  done
}

# record <step> <row> <pass|fail|error|skip> <expect-before: fail|any> <detail>
# expect-before `fail` marks the row that measures a report bug (a host check,
# or a flow that is its own check): --before needs it to fail cleanly. Rows
# that only get the app to a screen are `any`.
record() {
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$(printf '%s' "$5" | tr '\t\n' '  ')" >> "$RESULTS"
  log "   [$3] $1 / $2${5:+ — $5}"
}

# --- Device ---
if [ "$PLATFORM" = android ]; then
  if [ -z "$DEVICE" ]; then
    DEVICE="$("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
    [ "$(printf '%s\n' "$DEVICE" | grep -c .)" = 1 ] || {
      echo "ERROR: pass --device: found $(printf '%s\n' "$DEVICE" | grep -c .) adb devices" >&2
      exit 2
    }
  fi
  # `adb shell` reads stdin: never let it eat a caller's here-doc or loop input.
  adb_sh() { "$ADB" -s "$DEVICE" shell "$@" < /dev/null; }
else
  if [ -z "$DEVICE" ]; then
    DEVICE="$(xcrun simctl list devices booted | grep -Eo '\([0-9A-F-]{36}\)' | tr -d '()' || true)"
    [ "$(printf '%s\n' "$DEVICE" | grep -c .)" = 1 ] || {
      echo "ERROR: pass --device: found $(printf '%s\n' "$DEVICE" | grep -c .) booted simulators" >&2
      exit 2
    }
  fi
fi

# --- Restore everything the run changed, however it ends ---
ORIG_NAV_MODE=""
ORIG_NIGHT=""
NET_ARMED=0
SUDO_KEEPALIVE_PID=""
cleanup() {
  local status=$?
  set +e
  if [ "$NET_ARMED" = 1 ]; then
    net_restore_if_needed
    rm -f "$RUN_DIR/.hdr-anon"
  fi
  if [ -n "$SUDO_KEEPALIVE_PID" ]; then kill "$SUDO_KEEPALIVE_PID" 2> /dev/null; fi
  if [ "$PLATFORM" = android ]; then
    adb_sh cmd connectivity airplane-mode disable > /dev/null 2>&1
    if [ "$KEEP_DEVICE_STATE" = 0 ]; then
      [ -n "$ORIG_NIGHT" ] && adb_sh cmd uimode night "$ORIG_NIGHT" > /dev/null 2>&1
      case "$ORIG_NAV_MODE" in
        0) adb_sh cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton > /dev/null 2>&1 ;;
        1) adb_sh cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.twobutton > /dev/null 2>&1 ;;
        2) adb_sh cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.gestural > /dev/null 2>&1 ;;
      esac
    fi
  fi
  redact_out
  exit "$status"
}
trap cleanup EXIT

# --- Host network (iOS offline legs) ---
if [ "$ALLOW_HOST_OFFLINE" = 1 ]; then
  RUN_DIR="$OUT/net"
  mkdir -p "$RUN_DIR"
  # The watchdog starts at net_off and must outlast the whole offline part of a
  # leg: a fresh Maestro iOS driver, two cold starts with 30 s waits, a 15 s
  # banner wait, then `maestro hierarchy` for the capture. That can pass 120 s
  # (net.sh's default), and a network that comes back early makes the app
  # reconnect and the check read the wrong screen.
  NET_WATCHDOG_S="${NET_WATCHDOG_S:-300}"
  # net_wait_online's inputs: the Supabase URL and a header file.
  SB_URL="$NEXT_PUBLIC_SUPABASE_URL"
  (
    umask 077
    if [ -n "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ]; then
      printf 'apikey: %s\n' "$NEXT_PUBLIC_SUPABASE_ANON_KEY" > "$RUN_DIR/.hdr-anon"
    else
      : > "$RUN_DIR/.hdr-anon"
    fi
  )
  # shellcheck source=../../desktop/e2e/in-test/lib/net.sh
  source "$NET_SH"
  NET_ARMED=1
  log "Taking this Mac offline needs sudo; caching the timestamp now."
  sudo -v
  # Keep it alive for the run (as the in-test harness does): the first
  # offline leg comes several Maestro runs in, past sudo's 5-minute default.
  (while kill -0 $$ 2> /dev/null; do
    sudo -n true 2> /dev/null
    sleep 45
  done) > /dev/null 2>&1 &
  SUDO_KEEPALIVE_PID=$!
fi

NET_LEG=0
host_offline() {
  # A leg whose restore failed still owns its list of disabled services, which
  # the EXIT trap and its watchdog need: never replace it with a new leg's.
  if [ -s "$NET_DISABLED_FILE" ]; then
    log "   an earlier leg's network services are not restored yet; not taking the Mac offline again"
    return 1
  fi
  sudo -n -v 2> /dev/null || {
    log "   sudo timestamp expired; run sudo -v and retry"
    return 1
  }
  # net_busy skips Maestro's own iOS driver (`xcodebuild test-without-building`).
  net_wait_idle 600 || {
    log "   a build or support run is still active; not taking the Mac offline"
    return 1
  }
  # Each leg gets its own list and restored flag. With one shared flag, the
  # next leg's net_off deletes it, and an earlier leg's watchdog, waking during
  # that leg's offline phase, would find no flag and turn the network back on
  # mid-measurement.
  NET_LEG=$((NET_LEG + 1))
  mkdir -p "$RUN_DIR/leg-$NET_LEG"
  NET_DISABLED_FILE="$RUN_DIR/leg-$NET_LEG/net-disabled-services"
  NET_RESTORED_FLAG="$RUN_DIR/leg-$NET_LEG/net-restored"
  net_off
}

host_online() {
  net_on || return 1
  net_wait_online 60
}

# --- Maestro, captures and checks ---

# run_flow <step> <flow path relative to e2e/> [maestro -e args...]
# Runs a flow from $OUT (so takeScreenshot lands there). Returns its status.
run_flow() {
  local step="$1" flow="$2"
  shift 2
  local status=0
  log "-- $step: $flow $*"
  # A reused --out keeps an earlier run's commands JSON here, and a stale
  # "FAILED" in it would make this attempt's driver failure look like a failed
  # command (flow_command_failed). Step names are unique within a run.
  rm -rf "$OUT/maestro/$step"
  # --debug-output keeps Maestro's commands JSON and log (typed text included)
  # under $OUT, where redact_out scrubs them, instead of ~/.maestro/tests.
  (cd "$OUT" && "$MAESTRO" --device "$DEVICE" test --test-output-dir "$OUT/maestro/$step" \
    --debug-output "$OUT/maestro/$step" \
    -e RUN_ID="$RUN_ID" -e E2E_TEST_EMAIL="$E2E_TEST_EMAIL" \
    "$@" "$E2E_DIR/$flow") < /dev/null > "$OUT/$step.maestro.log" 2>&1 || status=$?
  redact_out
  if [ "$status" != 0 ]; then tail -15 "$OUT/$step.maestro.log" | sed 's/^/      /'; fi
  return "$status"
}

# capture <name>: the hierarchy, a screenshot and (Android) the window dump.
capture() {
  local name="$1"
  "$MAESTRO" --device "$DEVICE" hierarchy --no-reinstall-driver < /dev/null > "$OUT/$name.hierarchy.json" 2> "$OUT/$name.hierarchy.log" ||
    "$MAESTRO" --device "$DEVICE" hierarchy < /dev/null > "$OUT/$name.hierarchy.json" 2>> "$OUT/$name.hierarchy.log" || true
  if [ "$PLATFORM" = android ]; then
    # A dump before and after the screenshot: the nav-bar checks measure only
    # when both show the same state, so the pixels and the flags agree.
    adb_sh dumpsys window > "$OUT/$name.dumpsys.txt" 2>&1 || true
    "$ADB" -s "$DEVICE" exec-out screencap -p < /dev/null > "$OUT/$name.png" 2> /dev/null || true
    adb_sh dumpsys window > "$OUT/$name.dumpsys-after.txt" 2>&1 || true
  else
    xcrun simctl io "$DEVICE" screenshot "$OUT/$name.png" < /dev/null > /dev/null 2>&1 || true
  fi
}

# check <step> <capture name> <expect-before> <check> [check flags...]
# Runs one host check against a capture and records it.
check() {
  local step="$1" name="$2" expect="$3" kind="$4"
  shift 4
  local args=() status=0 output
  case "$kind" in
    nav-bar-dark | nav-bar-light)
      args=(--screenshot "$OUT/$name.png" --dumpsys "$OUT/$name.dumpsys.txt"
        --dumpsys-after "$OUT/$name.dumpsys-after.txt")
      ;;
    fab-above-nav-bar) args=(--hierarchy "$OUT/$name.hierarchy.json" --dumpsys "$OUT/$name.dumpsys.txt") ;;
    nav-mode) args=(--dumpsys "$OUT/$name.dumpsys.txt" --density "$OUT/$name.density.txt") ;;
    *) args=(--hierarchy "$OUT/$name.hierarchy.json") ;;
  esac
  output="$(node "$CHECKS" "$kind" "${args[@]}" "$@" 2>&1 < /dev/null)" || status=$?
  printf '%s\n' "$output" > "$OUT/$name.$kind.json"
  local reason
  reason="$(printf '%s' "$output" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).reason)}catch{console.log(s.split("\n")[0])}})')"
  case "$status" in
    0) record "$step" "$kind" pass "$expect" "$reason" ;;
    1) record "$step" "$kind" fail "$expect" "$reason" ;;
    # 2: bad input, or nothing to measure (the element or a precondition is
    # missing). Never a reproduction.
    *) record "$step" "$kind" error "$expect" "$reason" ;;
  esac
}

flow_exists() { [ -f "$E2E_DIR/$1" ]; }

# flow_command_failed <step>: whether Maestro ran the step's flow and one of
# its commands failed, as its log says ("Assert that … FAILED", or a command
# with "status": "FAILED" in the commands JSON). A Maestro that exits non-zero
# without one never measured anything: its driver didn't start, the YAML
# didn't parse, the device went away.
flow_command_failed() {
  LC_ALL=C grep -r -q -E '[[:space:]]FAILED[[:space:]]*$|"status"[[:space:]]*:[[:space:]]*"FAILED"' \
    "$OUT/$1.maestro.log" "$OUT/maestro/$1" 2> /dev/null
}

# want <step> <flow>: whether to run a report step (exists, and matches --only).
want() {
  local step="$1" flow="$2"
  if [ -n "$ONLY" ] && ! printf '%s' "$flow" | grep -Eq -- "$ONLY"; then return 1; fi
  if ! flow_exists "$flow"; then
    if [ "$REQUIRE_ALL" = 1 ]; then
      record "$step" flow error fail "flow $flow does not exist"
    else
      record "$step" flow skip fail "flow $flow does not exist yet"
    fi
    return 1
  fi
  return 0
}

# flow_step <step> <flow> <expect-before> [maestro -e args...]: a flow judged by Maestro alone.
# A failure counts as `fail` only when one of the flow's commands failed;
# otherwise Maestro never got to the flow's checks, and it is an `error`
# (under --before, NOT MEASURED rather than reproduced).
flow_step() {
  local step="$1" flow="$2" expect="$3" status=0
  shift 3
  want "$step" "$flow" || return 0
  run_flow "$step" "$flow" "$@" || status=$?
  if [ "$status" = 0 ]; then
    record "$step" flow pass "$expect" "$flow"
  elif flow_command_failed "$step"; then
    record "$step" flow fail "$expect" "$flow failed (see $step.maestro.log)"
  else
    record "$step" flow error "$expect" "maestro exited $status before any command of $flow failed: a driver, parse or setup error (see $step.maestro.log)"
  fi
}

# layout_step <step> <flow> <check> [check flags...] — the flow, then a capture and a host check.
# Maestro env for the flow comes from FLOW_ENV (an array), set by the caller.
# The host check is the measurement (expect-before fail); the flow only gets
# the app to the screen, so its row is `any`.
layout_step() {
  local step="$1" flow="$2" kind="$3"
  shift 3
  want "$step" "$flow" || return 0
  if run_flow "$step" "$flow" ${FLOW_ENV[@]+"${FLOW_ENV[@]}"}; then
    record "$step" flow pass any "$flow"
  else
    record "$step" flow fail any "$flow failed before its check point (see $step.maestro.log)"
  fi
  capture "$step"
  check "$step" "$step" fail "$kind" "$@"
}

ensure_signed_in() {
  if run_flow setup-login 01-login.yaml; then
    record setup-login flow pass any "signed in as the E2E user"
  else
    record setup-login flow error any "01-login failed; later steps may fail for that reason"
  fi
}

log "=== PrimeTestLab 10668 E2E ($PLATFORM, $MODE_LABEL the fixes) ==="
log "RUN_ID=$RUN_ID device=$DEVICE out=$OUT"
log "maestro=$MAESTRO"

# --- Platform setup ---
if [ "$PLATFORM" = android ]; then
  # A production bundle in the installed APK would run this suite against prod.
  # A debug APK has no bundle (Metro serves it), which is fine.
  apk_path="$(adb_sh pm path "$APP_ID" 2> /dev/null | sed -n 's/^package://p' | grep -m1 'base.apk' | tr -d '\r' || true)"
  if [ -z "$apk_path" ]; then
    echo "ERROR: $APP_ID is not installed on $DEVICE" >&2
    exit 2
  fi
  "$ADB" -s "$DEVICE" pull "$apk_path" "$OUT/installed.apk" > /dev/null
  # The Supabase URL is not inlined into the Hermes bundle: it ships in
  # assets/app.config (expo-constants `extra`). So grep the whole APK for the
  # prod ref, and require the dev ref in app.config.
  # Each extraction goes to a file before grep reads it: in `unzip -p | grep -q`
  # grep exits at the first match, unzip dies of SIGPIPE (141), and pipefail
  # turns the match into "no match", which would let a production APK through.
  # Only exit 0 is a complete read: Info-ZIP exits 1 after skipping an entry it
  # can't extract, which the prod-ref scan would then never see.
  apk_text="$OUT/installed.apk.contents"
  unzip_status=0
  unzip -p "$OUT/installed.apk" > "$apk_text" 2> /dev/null || unzip_status=$?
  if [ "$unzip_status" != 0 ]; then
    rm -f "$OUT/installed.apk" "$apk_text"
    echo "ERROR: could not read the installed APK (unzip exit $unzip_status)." >&2
    exit 2
  fi
  if LC_ALL=C grep -a -q -F "$PROD_REF" "$apk_text"; then
    rm -f "$OUT/installed.apk" "$apk_text"
    echo "ERROR: the installed APK contains the production ref ($PROD_REF). Build it against dev." >&2
    exit 2
  fi
  unzip -p "$OUT/installed.apk" assets/app.config > "$apk_text" 2> /dev/null || : > "$apk_text"
  if ! LC_ALL=C grep -a -q -F "$DEV_REF" "$apk_text"; then
    rm -f "$OUT/installed.apk" "$apk_text"
    echo "ERROR: the installed APK's assets/app.config does not name the dev project ($DEV_REF)." >&2
    exit 2
  fi
  rm -f "$apk_text"
  if unzip -l "$OUT/installed.apk" assets/index.android.bundle > /dev/null 2>&1; then
    log "Installed build: release bundle, dev project, no production ref"
  else
    log "Installed build: debug (JS from Metro at 10.0.2.2:8081; offline legs will lose it)"
  fi
  rm -f "$OUT/installed.apk"

  ORIG_NAV_MODE="$(adb_sh settings get secure navigation_mode | tr -d '\r')"
  ORIG_NIGHT="$(adb_sh cmd uimode night | sed -n 's/^Night mode: //p' | tr -d '\r')"
  log "Device state before: navigation_mode=$ORIG_NAV_MODE night=$ORIG_NIGHT"
  # The report's device used 3-button navigation, a light system theme.
  adb_sh cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton > /dev/null
  # The overlay applies asynchronously, several seconds later on a cold emulator.
  # The nav-bar checks measure the 3-button contrast scrim, which gesture
  # navigation doesn't draw, and the FAB check the 3-button bar's height, so a
  # run still in gesture mode would pass them without measuring the bug. Wait
  # for it. If it never applies, stop when one of those steps is selected, and
  # only warn otherwise.
  NAV_MODE=""
  for _ in $(seq 1 "${QA_NAV_MODE_WAIT_S:-20}"); do
    NAV_MODE="$(adb_sh settings get secure navigation_mode | tr -d '\r')"
    [ "$NAV_MODE" = 0 ] && break
    sleep 1
  done
  if [ "$NAV_MODE" != 0 ]; then
    msg="3-button navigation did not take effect (navigation_mode=$NAV_MODE)"
    if [ -z "$ONLY" ] || printf '%s\n' android-only/08-fab-above-nav-bar.yaml \
      android-only/11-dark-nav-bar.yaml android-only/12-delete-dialog-nav-bar.yaml |
      grep -Eq -- "$ONLY"; then
      log "ERROR: $msg"
      echo "ERROR: $msg" >&2
      exit 2
    fi
    log "WARNING: $msg; no selected step measures the nav bar"
  fi
  adb_sh cmd uimode night no > /dev/null
  adb_sh cmd connectivity airplane-mode disable > /dev/null 2>&1 || true
  sleep 2
  adb_sh wm density > "$OUT/setup.density.txt" 2>&1
  adb_sh dumpsys window > "$OUT/setup.dumpsys.txt" 2>&1
  check setup setup any nav-mode
else
  app_dir="$(xcrun simctl get_app_container "$DEVICE" "$APP_ID" 2> /dev/null || true)"
  if [ -z "$app_dir" ]; then
    echo "ERROR: $APP_ID is not installed on $DEVICE" >&2
    exit 2
  fi
  # As on Android, the Supabase URL ships in expo-constants' app.config
  # (EXConstants.bundle/app.config), not in main.jsbundle, and debug builds
  # carry it too. So grep the whole .app for the prod ref, and require the dev
  # ref in app.config, whatever the build.
  prod_status=0
  LC_ALL=C grep -r -a -q -F "$PROD_REF" "$app_dir" 2> /dev/null || prod_status=$?
  case "$prod_status" in
    0)
      echo "ERROR: the installed app contains the production ref ($PROD_REF). Build it against dev." >&2
      exit 2
      ;;
    1) ;;
    *)
      echo "ERROR: could not read the installed app at $app_dir (grep exit $prod_status)." >&2
      exit 2
      ;;
  esac
  app_config="$(find "$app_dir" -path '*/EXConstants.bundle/app.config' -print 2> /dev/null | head -1)"
  if [ -z "$app_config" ] || ! LC_ALL=C grep -a -q -F "$DEV_REF" "$app_config"; then
    echo "ERROR: the installed app's EXConstants.bundle/app.config does not name the dev project ($DEV_REF)." >&2
    exit 2
  fi
  if [ -f "$app_dir/main.jsbundle" ]; then
    log "Installed build: release bundle, dev project, no production ref"
  else
    log "Installed build: debug (JS from Metro on 8081), dev project, no production ref"
  fi
  xcrun simctl privacy "$DEVICE" grant photos "$APP_ID" > /dev/null 2>&1 || true
  xcrun simctl ui "$DEVICE" appearance light > /dev/null 2>&1 || true
fi

# --- S-01: show / hide password (runs signed out, so it goes first) ---
flow_step password-visibility 09-password-visibility.yaml fail
ensure_signed_in

# --- S-03: swipe hint ---
flow_step swipe-hint 10-swipe-hint.yaml fail

if [ "$PLATFORM" = android ]; then
  # --- M-01: the notebook's "+" sits above the 3-button nav bar ---
  FLOW_ENV=()
  layout_step fab-above-nav-bar android-only/08-fab-above-nav-bar.yaml fab-above-nav-bar

  # --- M-02 / M-03: offline image, offline banner (airplane mode) ---
  FLOW_ENV=(-e QA_KEEP_OFFLINE=1)
  # A --before build (1.4.7) has no E2E image probes: without QA_NO_PROBES the
  # flow stops at its first probe wait, online, and the check would measure
  # the online image instead of the offline one.
  if [ "$BEFORE" = 1 ]; then FLOW_ENV+=(-e QA_NO_PROBES=1); fi
  layout_step offline-image android-only/09-offline-image.yaml image-rendered
  adb_sh cmd connectivity airplane-mode disable > /dev/null 2>&1 || true
  FLOW_ENV=(-e QA_KEEP_OFFLINE=1)
  layout_step offline-banner android-only/10-offline-banner-header.yaml banner-clear-of-back
  adb_sh cmd connectivity airplane-mode disable > /dev/null 2>&1 || true

  # nav_bar_cases <step prefix> <flow>: runs the nav-bar cases read from stdin,
  # one per line: case | system night | in-app theme | expected bar | expect
  # before the fix. Each case sets the OS theme, runs the flow with that in-app
  # theme, then checks the focused window's bar.
  nav_bar_cases() {
    local prefix="$1" flow="$2" name night theme bar expect step
    while read -r name night theme bar expect; do
      adb_sh cmd uimode night "$night" > /dev/null
      sleep 1
      step="$prefix-$name"
      if run_flow "$step" "$flow" -e QA_THEME="$theme"; then
        record "$step" flow pass any "system night=$night, app theme=$theme"
      else
        record "$step" flow fail any "$flow failed (see $step.maestro.log)"
      fi
      capture "$step"
      check "$step" "$step" "$expect" "nav-bar-$bar"
    done
    adb_sh cmd uimode night no > /dev/null
  }

  # --- M-04: the nav bar follows the in-app theme ---
  NAV_FLOW=android-only/11-dark-nav-bar.yaml
  if want dark-nav-bar "$NAV_FLOW"; then
    nav_bar_cases dark-nav-bar "$NAV_FLOW" << 'CASES'
A-os-light-app-dark no dark dark fail
B-os-dark-app-light yes light light fail
C1-system-follows-dark-os yes system dark any
C2-system-follows-light-os no system light any
CASES
  fi

  # --- #862: the same, with the delete-account dialog open ---
  # The old dialog was an RN Modal in a window of its own, whose bar followed the OS.
  NAV_DIALOG_FLOW=android-only/12-delete-dialog-nav-bar.yaml
  if want delete-dialog-nav-bar "$NAV_DIALOG_FLOW"; then
    nav_bar_cases delete-dialog-nav-bar "$NAV_DIALOG_FLOW" << 'CASES'
D-os-light-app-dark no dark dark fail
E-os-dark-app-light yes light light fail
CASES
  fi

  # --- Regression: the offline-mode flows the report's fixes touch ---
  flow_step offline-mode android-only/05-offline-mode.yaml any
  flow_step offline-notebook-sync android-only/06-offline-notebook-sync.yaml any
  adb_sh cmd connectivity airplane-mode disable > /dev/null 2>&1 || true
else
  # --- M-01: the notebook's "+" sits above the home indicator ---
  FLOW_ENV=()
  layout_step fab-above-home-indicator ios-only/08-fab-above-home-indicator.yaml fab-above-home-indicator

  # --- M-02 / M-03 and the offline-mode regressions: the Mac goes offline ---
  # offline_leg <step> <flow> <expect-before> [<check>]
  # With a check, the check is the measurement and the phases are `any`;
  # without one (the regression flows) <expect-before> is `any` anyway. The
  # skip row stands in for the measurement it skips, so a --before run counts
  # the step as skipped, not as "NOT reproduced".
  offline_leg() {
    local step="$1" flow="$2" expect="$3" kind="${4:-}"
    want "$step" "$flow" || return 0
    # Before prepare: it creates test data that only the reconnect phase
    # deletes, so a leg that can't go offline must not start.
    if [ "$ALLOW_HOST_OFFLINE" = 0 ]; then
      record "$step" offline skip "$expect" "needs --allow-host-offline (the simulator has no airplane mode)"
      return 0
    fi
    if run_flow "$step-prepare" "$flow" -e QA_PHASE=prepare; then
      record "$step" prepare pass any "online phase"
    else
      record "$step" prepare fail any "online phase failed (see $step-prepare.maestro.log)"
    fi
    if ! host_offline; then
      record "$step" offline error "$expect" "could not take the Mac offline"
      # net_off may have disabled some services before it failed: turn them
      # back on. If that fails too, the list stays for the EXIT trap and the
      # watchdog, and host_offline refuses every later leg.
      if ! net_on; then
        record "$step" network error "$expect" "a partial disable could not be undone; the watchdog restores it within ${NET_WATCHDOG_S}s"
      fi
      return 0
    fi
    if run_flow "$step-offline" "$flow" -e QA_PHASE=offline; then
      record "$step" offline pass any "offline phase"
    else
      record "$step" offline fail any "offline phase failed (see $step-offline.maestro.log)"
    fi
    if [ -n "$kind" ]; then
      capture "$step"
      check "$step" "$step" "$expect" "$kind"
    fi
    if ! host_online; then
      record "$step" network error "$expect" "the network did not come back; the watchdog restores it within ${NET_WATCHDOG_S}s"
      return 0
    fi
    if run_flow "$step-reconnect" "$flow" -e QA_PHASE=reconnect; then
      record "$step" reconnect pass any "reconnect phase"
    else
      record "$step" reconnect fail any "reconnect phase failed (see $step-reconnect.maestro.log)"
    fi
  }
  offline_leg offline-image ios-only/09-attach-image-offline.yaml fail image-rendered
  offline_leg offline-banner ios-only/10-offline-banner-header.yaml fail banner-clear-of-back
  offline_leg offline-mode ios-only/05-offline-mode.yaml any
  offline_leg offline-notebook-sync ios-only/06-offline-notebook-sync.yaml any
fi

# --- Any other qa-10668 flow for this platform, judged by Maestro alone ---
KNOWN="09-password-visibility.yaml 10-swipe-hint.yaml 11-sign-out-confirm.yaml
android-only/08-fab-above-nav-bar.yaml android-only/09-offline-image.yaml
android-only/10-offline-banner-header.yaml android-only/11-dark-nav-bar.yaml android-only/12-delete-dialog-nav-bar.yaml
android-only/05-offline-mode.yaml android-only/06-offline-notebook-sync.yaml
ios-only/08-fab-above-home-indicator.yaml ios-only/09-attach-image-offline.yaml
ios-only/10-offline-banner-header.yaml ios-only/05-offline-mode.yaml ios-only/06-offline-notebook-sync.yaml"
while IFS= read -r flow; do
  [ -n "$flow" ] || continue
  printf '%s\n' $KNOWN | grep -qxF "$flow" && continue
  flow_step "extra-$(basename "$flow" .yaml)" "$flow" any
done < <(cd "$E2E_DIR" && grep -lE '^[[:space:]]*-[[:space:]]*qa-10668[[:space:]]*$|^tags:.*qa-10668' ./*.yaml "$PLATFORM-only"/*.yaml 2> /dev/null | sed 's|^\./||' | sort)

# --- S-02: sign-out confirm, last (the confirm leg leaves the device signed out) ---
SIGN_OUT_ENV=()
[ "${SIGN_OUT_CONFIRM:-0}" = 1 ] && SIGN_OUT_ENV+=(-e SIGN_OUT_CONFIRM=1)
[ "$SIGNOUT_ACCOUNT" = 1 ] && SIGN_OUT_ENV+=(-e E2E_SIGNOUT_EMAIL="$E2E_SIGNOUT_EMAIL")
if [ "$BEFORE" = 1 ] && [ "$SIGNOUT_ACCOUNT" = 0 ]; then
  # A build without the fix signs out at the first tap: on the shared user
  # that is a global sign-out, so never run it there.
  if want sign-out-confirm 11-sign-out-confirm.yaml; then
    record sign-out-confirm flow skip fail "--before needs E2E_SIGNOUT_EMAIL / E2E_SIGNOUT_PASSWORD in $ENV_FILE: a build without the fix signs out at the first tap, which on the shared E2E user ends every session"
  fi
else
  flow_step sign-out-confirm 11-sign-out-confirm.yaml fail ${SIGN_OUT_ENV[@]+"${SIGN_OUT_ENV[@]}"}
fi

# --- Summary ---
redact_out
SUMMARY="$OUT/summary.md"
node - "$RESULTS" "$BEFORE" "$SUMMARY" "$PLATFORM" "$RUN_ID" << 'NODE'
const fs = require("node:fs");
const [, , results, before, summaryPath, platform, runId] = process.argv;
const rows = fs
  .readFileSync(results, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [step, row, status, expect, detail] = line.split("\t");
    return { step, row, status, expect, detail };
  });
const steps = new Map();
for (const r of rows) {
  if (!steps.has(r.step)) steps.set(r.step, []);
  steps.get(r.step).push(r);
}
const isBefore = before === "1";
let bad = 0;
const lines = [
  `# PrimeTestLab 10668 E2E: ${platform}, ${isBefore ? "before" : "after"} the fixes (RUN_ID ${runId})`,
  "",
  "| Step | Result | Checks |",
  "| --- | --- | --- |",
];
// A step's measurements are its expect-before `fail` rows. In --before, only
// a measurement that ran and failed cleanly (exit 1, or a flow command that
// failed) is a reproduction. An error (a check's exit 2: bad input or the
// element missing; a flow that doesn't exist under --require-all; a flow
// Maestro exited on before any command failed) measured nothing, so it
// proves nothing either way and counts as bad. A step whose measurements were all skipped is
// skipped, not "NOT reproduced".
for (const [step, list] of steps) {
  const failed = list.some((r) => r.status === "fail" || r.status === "error");
  const errored = list.some((r) => r.status === "error");
  const skipped = list.every((r) => r.status === "skip");
  const partial = !skipped && list.some((r) => r.status === "skip");
  const measures = list.filter((r) => r.expect === "fail");
  const reportCheck = measures.length > 0;
  const measureSkipped = reportCheck && measures.every((r) => r.status === "skip");
  let result;
  if (skipped) result = "skipped";
  else if (isBefore && reportCheck) {
    if (errored) {
      result = "NOT MEASURED";
      bad++;
    } else if (measures.some((r) => r.status === "fail")) result = "reproduced";
    else if (measureSkipped) result = "skipped (its check didn't run)";
    else {
      result = "NOT reproduced";
      bad++;
    }
  } else if (failed) {
    result = isBefore && !errored ? "failed (not a report check)" : "FAILED";
    if (!isBefore || errored) bad++;
  } else if (measureSkipped) result = "skipped (its check didn't run)";
  else result = partial ? "passed (a leg was skipped)" : "passed";
  const checks = list.map((r) => `${r.row}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`).join("<br>");
  lines.push(`| ${step} | ${result} | ${checks.replace(/\|/g, "\\|")} |`);
}
const skippedCount = [...steps.values()].filter((list) => list.some((r) => r.status === "skip")).length;
lines.push(
  "",
  `${bad === 0 ? "OK" : `${bad} step(s) need attention`}; ${skippedCount} step(s) skipped in whole or part.`,
);
fs.writeFileSync(summaryPath, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
process.exit(bad === 0 ? 0 : 1);
NODE
