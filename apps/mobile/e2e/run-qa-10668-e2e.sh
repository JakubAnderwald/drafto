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
#                         "reproduced". Exits non-zero if any of them passes,
#                         because that check can't tell a fixed build from a
#                         broken one.
#   --allow-host-offline  iOS only: the simulator has no airplane mode, so the
#                         offline legs take this whole Mac offline with
#                         apps/desktop/e2e/in-test/lib/net.sh (sudo; a root
#                         watchdog restores the network after NET_WATCHDOG_S,
#                         default 120 s). Without it the offline legs are
#                         skipped. This also cuts off anything else on the Mac,
#                         a Claude session included, until the leg ends.
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
# "Offline flows on Android". The runner refuses an installed build whose
# bundle names the production project.
#
# Contract with the flows (the env the runner passes to each one):
#   RUN_ID, E2E_TEST_EMAIL, E2E_TEST_PASSWORD   always
#   QA_KEEP_OFFLINE=1   Android offline flows: leave airplane mode on at the
#                       end (their onFlowComplete restores it only when this is
#                       unset), so the host check sees the offline screen. The
#                       runner turns it off after the check, and on exit.
#   QA_PHASE=prepare|offline|reconnect
#                       iOS offline flows: `prepare` runs online, `offline`
#                       while the Mac is offline (ending on the screen to
#                       check), `reconnect` online again. A flow ignores a
#                       phase it has no steps for.
#   QA_THEME=dark|light|system
#                       android-only/11-dark-nav-bar: the in-app theme to pick
#                       in Settings before ending on the Notebooks tab.
#   SIGN_OUT_CONFIRM=1  11-sign-out-confirm: also run the confirm leg. Only
#                       when SIGN_OUT_CONFIRM=1 is in this runner's environment:
#                       it signs the shared dev E2E user out everywhere.
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

RUN_ID="${RUN_ID:-$(date +%s)}"
MODE_LABEL=$([ "$BEFORE" = 1 ] && echo before || echo after)
OUT="${OUT:-${TMPDIR:-/tmp}/drafto-qa-10668-$PLATFORM-$MODE_LABEL-$RUN_ID}"
mkdir -p "$OUT/maestro"
OUT="$(cd "$OUT" && pwd)"
RESULTS="$OUT/results.tsv"
: > "$RESULTS"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/run.log"; }

# Maestro logs each typed text, the password included: scrub it from every
# text file the run saved. The value is read from the environment, not argv.
redact_out() {
  find "$OUT" -type f \( -name '*.log' -o -name '*.json' -o -name '*.txt' -o -name '*.html' -o -name '*.xml' \) \
    -exec perl -pi -e 's/\Q$ENV{E2E_TEST_PASSWORD}\E/[redacted]/g' {} + 2> /dev/null || true
}

# record <step> <row> <pass|fail|error|skip> <expect-before: fail|any> <detail>
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
  adb_sh() { "$ADB" -s "$DEVICE" shell "$@"; }
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
cleanup() {
  local status=$?
  set +e
  if [ "$NET_ARMED" = 1 ]; then net_restore_if_needed; fi
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
  NET_WATCHDOG_S="${NET_WATCHDOG_S:-120}"
  # shellcheck source=../../desktop/e2e/in-test/lib/net.sh
  source "$NET_SH"
  NET_ARMED=1
  log "Taking this Mac offline needs sudo; caching the timestamp now."
  sudo -v
fi

host_offline() {
  sudo -n -v 2> /dev/null || {
    log "   sudo timestamp expired; run sudo -v and retry"
    return 1
  }
  # net.sh's own net_wait_idle counts any xcodebuild, and Maestro's iOS driver
  # runs as `xcodebuild test-without-building`, so wait only for real builds,
  # releases and the support runs.
  local end=$(($(date +%s) + 600))
  while pgrep -fl 'fastlane|xcodebuild|/gym |support-agent\.sh|nightly-(support|audit)\.sh' |
    grep -v 'test-without-building' | grep -q .; do
    [ "$(date +%s)" -lt "$end" ] || {
      log "   a build or support run is still active; not taking the Mac offline"
      return 1
    }
    log "   waiting: a build or support run is active"
    sleep 20
  done
  net_off
}

host_online() {
  net_on || return 1
  local end=$(($(date +%s) + 60))
  while [ "$(date +%s)" -lt "$end" ]; do
    curl -s -o /dev/null -m 3 "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/health" && return 0
    sleep 1
  done
  return 1
}

# --- Maestro, captures and checks ---

# run_flow <step> <flow path relative to e2e/> [maestro -e args...]
# Runs a flow from $OUT (so takeScreenshot lands there). Returns its status.
run_flow() {
  local step="$1" flow="$2"
  shift 2
  local status=0
  log "-- $step: $flow $*"
  (cd "$OUT" && "$MAESTRO" --device "$DEVICE" test --test-output-dir "$OUT/maestro/$step" \
    -e RUN_ID="$RUN_ID" -e E2E_TEST_EMAIL="$E2E_TEST_EMAIL" -e E2E_TEST_PASSWORD="$E2E_TEST_PASSWORD" \
    "$@" "$E2E_DIR/$flow") > "$OUT/$step.maestro.log" 2>&1 || status=$?
  redact_out
  if [ "$status" != 0 ]; then tail -15 "$OUT/$step.maestro.log" | sed 's/^/      /'; fi
  return "$status"
}

# capture <name>: the hierarchy, a screenshot and (Android) the window dump.
capture() {
  local name="$1"
  "$MAESTRO" --device "$DEVICE" hierarchy --no-reinstall-driver > "$OUT/$name.hierarchy.json" 2> "$OUT/$name.hierarchy.log" ||
    "$MAESTRO" --device "$DEVICE" hierarchy > "$OUT/$name.hierarchy.json" 2>> "$OUT/$name.hierarchy.log" || true
  if [ "$PLATFORM" = android ]; then
    adb_sh dumpsys window > "$OUT/$name.dumpsys.txt" 2>&1 || true
    "$ADB" -s "$DEVICE" exec-out screencap -p > "$OUT/$name.png" 2> /dev/null || true
  else
    xcrun simctl io "$DEVICE" screenshot "$OUT/$name.png" > /dev/null 2>&1 || true
  fi
}

# check <step> <capture name> <expect-before> <check> [check flags...]
# Runs one host check against a capture and records it.
check() {
  local step="$1" name="$2" expect="$3" kind="$4"
  shift 4
  local args=() status=0 output
  case "$kind" in
    nav-bar-dark | nav-bar-light) args=(--screenshot "$OUT/$name.png" --dumpsys "$OUT/$name.dumpsys.txt") ;;
    fab-above-nav-bar) args=(--hierarchy "$OUT/$name.hierarchy.json" --dumpsys "$OUT/$name.dumpsys.txt") ;;
    nav-mode) args=(--dumpsys "$OUT/$name.dumpsys.txt" --density "$OUT/$name.density.txt") ;;
    *) args=(--hierarchy "$OUT/$name.hierarchy.json") ;;
  esac
  output="$(node "$CHECKS" "$kind" "${args[@]}" "$@" 2>&1)" || status=$?
  printf '%s\n' "$output" > "$OUT/$name.$kind.json"
  local reason
  reason="$(printf '%s' "$output" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).reason)}catch{console.log(s.split("\n")[0])}})')"
  case "$status" in
    0) record "$step" "$kind" pass "$expect" "$reason" ;;
    1) record "$step" "$kind" fail "$expect" "$reason" ;;
    *) record "$step" "$kind" error "$expect" "$reason" ;;
  esac
}

flow_exists() { [ -f "$E2E_DIR/$1" ]; }

# want <step> <flow>: whether to run a report step (exists, and matches --only).
want() {
  local step="$1" flow="$2"
  if [ -n "$ONLY" ] && ! printf '%s' "$flow" | grep -Eq -- "$ONLY"; then return 1; fi
  if ! flow_exists "$flow"; then
    if [ "$REQUIRE_ALL" = 1 ]; then
      record "$step" flow fail fail "flow $flow does not exist"
    else
      record "$step" flow skip fail "flow $flow does not exist yet"
    fi
    return 1
  fi
  return 0
}

# flow_step <step> <flow> <expect-before> [maestro -e args...]: a flow judged by Maestro alone.
flow_step() {
  local step="$1" flow="$2" expect="$3"
  shift 3
  want "$step" "$flow" || return 0
  if run_flow "$step" "$flow" "$@"; then
    record "$step" flow pass "$expect" "$flow"
  else
    record "$step" flow fail "$expect" "$flow failed (see $step.maestro.log)"
  fi
}

# layout_step <step> <flow> <check> [check flags...] — the flow, then a capture and a host check.
# Maestro env for the flow comes from FLOW_ENV (an array), set by the caller.
layout_step() {
  local step="$1" flow="$2" kind="$3"
  shift 3
  want "$step" "$flow" || return 0
  if run_flow "$step" "$flow" ${FLOW_ENV[@]+"${FLOW_ENV[@]}"}; then
    record "$step" flow pass fail "$flow"
  else
    record "$step" flow fail fail "$flow failed before its check point (see $step.maestro.log)"
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
  if unzip -p "$OUT/installed.apk" | LC_ALL=C grep -a -q "$PROD_REF"; then
    rm -f "$OUT/installed.apk"
    echo "ERROR: the installed APK contains the production ref ($PROD_REF). Build it against dev." >&2
    exit 2
  fi
  if ! unzip -p "$OUT/installed.apk" assets/app.config 2> /dev/null | LC_ALL=C grep -a -q "$DEV_REF"; then
    rm -f "$OUT/installed.apk"
    echo "ERROR: the installed APK's assets/app.config does not name the dev project ($DEV_REF)." >&2
    exit 2
  fi
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
  if [ -f "$app_dir/main.jsbundle" ]; then
    if grep -q "$PROD_REF" "$app_dir/main.jsbundle"; then
      echo "ERROR: the installed app's bundle points at production ($PROD_REF). Build it against dev." >&2
      exit 2
    fi
    log "Installed build: release bundle, no production ref"
  else
    log "Installed build: debug (JS from Metro on 8081)"
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
  layout_step offline-image android-only/09-offline-image.yaml image-rendered
  adb_sh cmd connectivity airplane-mode disable > /dev/null 2>&1 || true
  layout_step offline-banner android-only/10-offline-banner-header.yaml banner-clear-of-back
  adb_sh cmd connectivity airplane-mode disable > /dev/null 2>&1 || true

  # --- M-04: the nav bar follows the in-app theme ---
  # case | system night | in-app theme | expected bar | expect before the fix
  NAV_FLOW=android-only/11-dark-nav-bar.yaml
  if want dark-nav-bar "$NAV_FLOW"; then
    while read -r name night theme bar expect; do
      adb_sh cmd uimode night "$night" > /dev/null
      sleep 1
      step="dark-nav-bar-$name"
      if run_flow "$step" "$NAV_FLOW" -e QA_THEME="$theme"; then
        record "$step" flow pass "$expect" "system night=$night, app theme=$theme"
      else
        record "$step" flow fail "$expect" "$NAV_FLOW failed (see $step.maestro.log)"
      fi
      capture "$step"
      check "$step" "$step" "$expect" "nav-bar-$bar"
    done << 'CASES'
A-os-light-app-dark no dark dark fail
B-os-dark-app-light yes light light fail
C1-system-follows-dark-os yes system dark any
C2-system-follows-light-os no system light any
CASES
    adb_sh cmd uimode night no > /dev/null
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
  offline_leg() {
    local step="$1" flow="$2" expect="$3" kind="${4:-}"
    want "$step" "$flow" || return 0
    if run_flow "$step-prepare" "$flow" -e QA_PHASE=prepare; then
      record "$step" prepare pass "$expect" "online phase"
    else
      record "$step" prepare fail "$expect" "online phase failed (see $step-prepare.maestro.log)"
    fi
    if [ "$ALLOW_HOST_OFFLINE" = 0 ]; then
      record "$step" offline skip "$expect" "needs --allow-host-offline (the simulator has no airplane mode)"
      return 0
    fi
    if ! host_offline; then
      record "$step" offline error "$expect" "could not take the Mac offline"
      return 0
    fi
    if run_flow "$step-offline" "$flow" -e QA_PHASE=offline; then
      record "$step" offline pass "$expect" "offline phase"
    else
      record "$step" offline fail "$expect" "offline phase failed (see $step-offline.maestro.log)"
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
      record "$step" reconnect pass "$expect" "reconnect phase"
    else
      record "$step" reconnect fail "$expect" "reconnect phase failed (see $step-reconnect.maestro.log)"
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
android-only/10-offline-banner-header.yaml android-only/11-dark-nav-bar.yaml
android-only/05-offline-mode.yaml android-only/06-offline-notebook-sync.yaml
ios-only/08-fab-above-home-indicator.yaml ios-only/09-attach-image-offline.yaml
ios-only/10-offline-banner-header.yaml ios-only/05-offline-mode.yaml ios-only/06-offline-notebook-sync.yaml"
while IFS= read -r flow; do
  [ -n "$flow" ] || continue
  printf '%s\n' $KNOWN | grep -qxF "$flow" && continue
  flow_step "extra-$(basename "$flow" .yaml)" "$flow" any
done < <(cd "$E2E_DIR" && grep -lE '^[[:space:]]*-[[:space:]]*qa-10668[[:space:]]*$|^tags:.*qa-10668' ./*.yaml "$PLATFORM-only"/*.yaml 2> /dev/null | sed 's|^\./||' | sort)

# --- S-02: sign-out confirm, last (the confirm leg signs the E2E user out) ---
if [ "${SIGN_OUT_CONFIRM:-0}" = 1 ]; then
  flow_step sign-out-confirm 11-sign-out-confirm.yaml fail -e SIGN_OUT_CONFIRM=1
else
  flow_step sign-out-confirm 11-sign-out-confirm.yaml fail
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
for (const [step, list] of steps) {
  const failed = list.some((r) => r.status === "fail" || r.status === "error");
  const errored = list.some((r) => r.status === "error");
  const skipped = list.every((r) => r.status === "skip");
  const partial = !skipped && list.some((r) => r.status === "skip");
  const expectFail = list.some((r) => r.expect === "fail");
  let result;
  if (skipped) result = "skipped";
  else if (isBefore && expectFail) {
    if (failed) result = "reproduced";
    else {
      result = "NOT reproduced";
      bad++;
    }
  } else if (failed) {
    result = isBefore && !errored ? "failed (not a report check)" : "FAILED";
    if (!isBefore || errored) bad++;
  } else result = partial ? "passed (a leg was skipped)" : "passed";
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
