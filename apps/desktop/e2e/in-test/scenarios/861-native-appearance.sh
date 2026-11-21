#!/bin/bash
# In-Test scenario for #861: the macOS app's native chrome (title bar, NSAlert
# sheets) follows the in-app theme (View → Appearance), and System follows
# macOS again, live changes included. Menu-bar menus follow macOS whatever the
# app sets (ADR-0089), so the View menu's shade is recorded as evidence but
# never decides a step. Guide:
# docs/operations/macos-in-test-automation.md
#
#   bash scenarios/861-native-appearance.sh --preflight     read-only checks
#   bash scenarios/861-native-appearance.sh                 full run (~1 min; start it in Terminal)
#
# Negative control on a build without the fix (P1, P2 and P5 should FAIL there;
# P5 only runs when the app is signed in and reads Synced):
#   ISSUE= bash scenarios/861-native-appearance.sh
# A debug build works too: DRAFTO_APP=<path to its Drafto.app>.
#
# Unlike the other scenarios this one does not source lib/harness.sh: it needs
# no account and writes nothing to any backend. It changes two settings, the
# app's theme and macOS's Light/Dark appearance, and puts both back on exit.
# Step P5 opens the sign-out confirmation and cancels it; it runs only when the
# app is signed in and reads "Synced", and it never presses "Sign out".
#
# How the steps decide: each check captures the window (or the menu or sheet)
# and reads the mean brightness (luma, 0…1) of a region with bin/luma. Dark
# chrome reads below DARK_MAX, light chrome above LIGHT_MIN.
set -uo pipefail
# awk's printf follows the locale: under pl_PL, "%.4f" prints 0,0037, which
# bin/luma rejects. The region fractions need a decimal point. LC_ALL would
# override LC_NUMERIC, so drop it; the rest of the locale (UTF-8 for the ✓
# checkmark match) stays.
unset LC_ALL
export LC_NUMERIC=C

SCENARIO=861-native-appearance
SCENARIO_TITLE="#861 desktop native appearance"
ISSUE=${ISSUE-861}
DARK_MAX=0.4
LIGHT_MIN=0.6
SETTLE_S=8
BACKEND=none # common.sh's report header

IN_TEST_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IN_TEST_BIN=${DRAFTO_IN_TEST_BIN:-$IN_TEST_DIR/bin}
APP=${DRAFTO_APP:-/Applications/Drafto.app}
GH_REPO=JakubAnderwald/drafto
RUNS_ROOT="${DRAFTO_IN_TEST_RUNS:-$HOME/Library/Logs/drafto-in-test}/$SCENARIO"
MODE=${1:-run}
QA_EMAIL="" # app.sh's redact() reads it

case $MODE in
  run | --preflight) ;;
  *)
    echo "usage: bash $0 [--preflight]" >&2
    exit 2
    ;;
esac
if [ "${DRAFTO_UNATTENDED:-}" = 1 ]; then
  echo "This scenario drives the screen and changes macOS's appearance: run it from Terminal yourself." >&2
  exit 2
fi

RUN_DIR="$RUNS_ROOT/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_DIR/shots"

# shellcheck source=../lib/common.sh
source "$IN_TEST_DIR/lib/common.sh"
# shellcheck source=../lib/ax.sh
source "$IN_TEST_DIR/lib/ax.sh"
# shellcheck source=../lib/app.sh
source "$IN_TEST_DIR/lib/app.sh"

# ── Reading and setting the two appearances ─────────────────────────────────

se() { osascript -e "tell application \"System Events\" to $1" 2> /dev/null; }

# dp — System Events' reference to the macOS Drafto, by pid: an iOS-simulator
# Drafto has the same process name (see drafto_pid).
dp() { echo "(first process whose unix id is $(drafto_pid))"; }

os_dark() { se 'tell appearance preferences to get dark mode'; }

set_os_dark() { # set_os_dark <true|false>
  se "tell appearance preferences to set dark mode to $1" > /dev/null
}

APPEARANCE_MENU='menu "Appearance" of menu item "Appearance" of menu "View" of menu bar 1'

# app_theme — Light / Dark / System, from the View → Appearance checkmark.
app_theme() {
  local marks
  marks=$(se "tell $(dp) to get value of attribute \"AXMenuItemMarkChar\" of menu items of $APPEARANCE_MENU")
  case $marks in
    "✓, missing value, missing value") echo Light ;;
    "missing value, ✓, missing value") echo Dark ;;
    "missing value, missing value, ✓") echo System ;;
    *) echo "" ;;
  esac
}

theme_is() { [ "$(app_theme)" = "$1" ]; }

choose_theme() { # choose_theme <Light|Dark|System>
  ensure_front
  se "tell $(dp) to click menu item \"$1\" of $APPEARANCE_MENU" > /dev/null
  poll 5 theme_is "$1"
}

os_is() { [ "$(os_dark)" = "$1" ]; }

# ── Measuring ───────────────────────────────────────────────────────────────

# region_luma <png> <x0> <y0> <x1> <y1> — mean luma of a fractional region.
region_luma() { "$LUMA" "$@" 2> /dev/null | jq -r '.luma // empty'; }

# shade <luma> — dark, light or mid.
shade() {
  awk -v l="$1" -v d="$DARK_MAX" -v li="$LIGHT_MIN" \
    'BEGIN { if (l == "") print "unknown"; else if (l < d) print "dark"; else if (l > li) print "light"; else print "mid" }'
}

# window_shades <label> — capture the window and print "<titlebar> <content>
# <titlebar luma> <content luma>". The title bar is the strip 4–20 pt from the
# top (right of the title, which macOS draws left-aligned next to the traffic
# lights); the content sample is the lower right of the window, where the note
# editor or the empty state sits.
window_shades() {
  local f h y0 y1 tb ct
  f="$RUN_DIR/shots/${STEP_ID:-pre}-$1.png"
  win_capture "$f" 2> /dev/null || return 1
  # The main window (titled Drafto), the one win_capture takes: not whichever
  # window is frontmost.
  h=$(se "tell $(dp) to get item 2 of (get size of window \"Drafto\")")
  [ -n "$h" ] || return 1
  y0=$(awk -v h="$h" 'BEGIN { printf "%.4f", 4 / h }')
  y1=$(awk -v h="$h" 'BEGIN { printf "%.4f", 20 / h }')
  tb=$(region_luma "$f" 0.3 "$y0" 0.95 "$y1")
  ct=$(region_luma "$f" 0.7 0.85 0.95 0.95)
  echo "$(shade "$tb") $(shade "$ct") $tb $ct"
}

# capture_rect <label> <x> <y> <w> <h> — screen capture of a rectangle in
# points; prints the file.
capture_rect() {
  local f
  f="$RUN_DIR/shots/${STEP_ID:-pre}-$1.png"
  screencapture -x -R"$2,$3,$4,$5" "$f" 2> /dev/null || return 1
  echo "$f"
}

# view_menu_shade — open the View menu, measure it, close it.
view_menu_shade() {
  local frame f l
  ensure_front
  se "tell $(dp) to click menu bar item \"View\" of menu bar 1" > /dev/null
  sleep 0.8
  frame=$(se "tell $(dp) to get {position, size} of menu \"View\" of menu bar item \"View\" of menu bar 1")
  # "x, y, w, h"
  if [ -n "$frame" ]; then
    # shellcheck disable=SC2086
    f=$(capture_rect view-menu $(tr -d ' ' <<< "$frame" | awk -F, '{ printf "%d %d %d %d", $1, $2, $3, $4 }'))
    # The menu's middle band, clear of the rounded corners.
    [ -n "$f" ] && l=$(region_luma "$f" 0.1 0.2 0.9 0.8)
  fi
  osascript -e 'tell application "System Events" to key code 53' > /dev/null # Escape closes it
  sleep 0.5
  echo "$(shade "${l:-}") ${l:-}"
}

# expect_window <titlebar> <content> — succeeds when both match.
WIN=""
window_matches() {
  WIN=$(window_shades poll) || return 1
  [ "$(cut -d' ' -f1-2 <<< "$WIN")" = "$EXPECT" ]
}
expect_window() {
  EXPECT="$1 $2"
  poll "$SETTLE_S" window_matches
}

# ── Preflight (read-only) ───────────────────────────────────────────────────

PF_FAIL=0
pf() {
  case $1 in
    ok) log "  ✅ $2" ;;
    fail)
      log "  ❌ $2"
      PF_FAIL=1
      ;;
    *) log "  ℹ️  $2" ;;
  esac
}

preflight() {
  log "Preflight (read-only) — $SCENARIO_TITLE"
  local t
  for t in jq screencapture swiftc osascript awk gh; do
    command -v "$t" > /dev/null || pf fail "missing tool: $t"
  done
  build_helpers || pf fail "could not compile the Swift helpers into $IN_TEST_BIN"

  if [ -n "$ISSUE" ]; then
    local installed marker
    installed=$(app_plist CFBundleVersion)
    marker=$(gh api "repos/$GH_REPO/issues/$ISSUE/comments" --paginate --jq '.[].body' 2> /dev/null |
      grep -oE 'drafto-factory-intest-build:macos:[0-9]+' | tail -1 | cut -d: -f3)
    if [ -n "$installed" ] && [ "$installed" = "$marker" ]; then
      pf ok "installed Drafto build $installed = the In-Test build posted on #$ISSUE"
    else
      pf fail "installed build '${installed:-none}' ≠ In-Test build '${marker:-unknown}' — update it from TestFlight (or ISSUE= to skip)"
    fi
  fi

  if [[ "$(ioreg -n Root -d1)" == *'"IOConsoleLocked" = Yes'* ]]; then
    pf fail "the screen is locked — unlock it"
  elif [ -z "$(drafto_pid)" ]; then
    pf fail "Drafto is not running (open $APP first)"
  else
    pf ok "screen unlocked"
    # The running process must be the installed bundle, started after that
    # bundle was last written: a TestFlight update replaces the bundle under a
    # still-running old process (same check as harness.sh).
    local pid exe started written
    pid=$(drafto_pid)
    exe=$(ps -o comm= -p "$pid")
    started=$(LC_ALL=C date -j -f "%a %b %d %T %Y" "$(LC_ALL=C ps -o lstart= -p "$pid" | sed 's/[[:space:]]*$//')" +%s 2> /dev/null)
    written=$(stat -f %m "$APP/Contents/_MASReceipt/receipt" 2> /dev/null ||
      stat -f %m "$APP/Contents/Info.plist" 2> /dev/null)
    if [[ "$exe" != "$APP/"* ]]; then
      pf fail "the running Drafto (pid $pid) is $exe, not $APP"
    elif [ -n "$started" ] && [ -n "$written" ] && [ "$started" -ge "$written" ]; then
      pf ok "the running Drafto (pid $pid) was started from $APP after it was installed"
    else
      pf fail "the running Drafto started before $APP was last updated — quit and reopen it"
    fi
    local n
    n=$(ax_dump | jq 'length' 2> /dev/null)
    [ "${n:-0}" -gt 3 ] && pf ok "accessibility tree readable ($n elements)" ||
      pf fail "cannot read Drafto's accessibility tree (Accessibility permission for Terminal?)"
    local theme
    theme=$(app_theme)
    [ -n "$theme" ] && pf ok "View → Appearance readable (currently $theme)" ||
      pf fail "cannot read View → Appearance (Automation → System Events for Terminal?)"
    local f l
    f="$RUN_DIR/preflight-window.png"
    if win_capture "$f" && l=$(region_luma "$f" 0 0 1 1) && [ -n "$l" ]; then
      pf ok "window capture + luma working"
    else
      pf fail "window capture failed (Screen Recording permission for Terminal?)"
    fi
    rm -f "$f"
    if on_main_screen; then
      pf info "app is signed in (sync status '$(sync_help)'): step P5 checks the sign-out confirmation, and cancels it"
    else
      pf info "app is not on the main screen: step P5 (alert sheet) will SKIP"
    fi
  fi
  local dark
  dark=$(os_dark)
  [ -n "$dark" ] && pf ok "macOS appearance readable (dark mode: $dark)" ||
    pf fail "cannot read macOS's appearance (Automation → System Events for Terminal?)"
  return $PF_FAIL
}

if [ "$MODE" = --preflight ]; then
  preflight && log "Preflight passed." || log "Preflight FAILED."
  rm -rf "$RUN_DIR"
  exit $PF_FAIL
fi

# ── Full run ────────────────────────────────────────────────────────────────

preflight || die "preflight failed — nothing was changed"
ORIG_OS_DARK=$(os_dark)
ORIG_THEME=$(app_theme)
# Cleanup restores these, so both must be known before anything changes.
[[ "$ORIG_OS_DARK" =~ ^(true|false)$ ]] || die "could not read macOS's appearance — nothing was changed"
[[ "$ORIG_THEME" =~ ^(Light|Dark|System)$ ]] || die "could not read View → Appearance — nothing was changed"
{
  echo
  echo "This run changes, and restores at the end:"
  echo "  • macOS's appearance (now dark mode: $ORIG_OS_DARK), switched between Light and Dark"
  echo "  • Drafto's View → Appearance (now $ORIG_THEME)"
  echo "It opens the sign-out confirmation once and cancels it. Nothing is written to any backend."
  echo
} >&2
read -r -p "Type YES to run: " answer
[ "$answer" = YES ] || die "not confirmed"

cleanup() {
  local rc=$?
  set +e
  trap - EXIT INT TERM
  [ "$STEP_OPEN" = 1 ] && step_end ABORTED "the run ended (exit $rc) before this step finished"
  if [ "$RUN_COMPLETE" = 1 ]; then
    RUN_OUTCOME="all steps ran (exit $rc)"
  else
    RUN_OUTCOME="STOPPED EARLY (exit $rc) — steps after the last row did not run"
  fi
  osascript -e 'tell application "System Events" to key code 53' > /dev/null 2>&1 # close a stray menu
  [ -n "$ORIG_THEME" ] && { choose_theme "$ORIG_THEME" || log "Cleanup: could not set Drafto back to $ORIG_THEME — do it in View → Appearance"; }
  [ -n "$ORIG_OS_DARK" ] && set_os_dark "$ORIG_OS_DARK"
  log "Cleanup: Drafto theme $(app_theme), macOS dark mode $(os_dark)"
  write_report
  log "Report: $RUN_DIR/report.md"
  [ -t 1 ] && cat "$RUN_DIR/report.md"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
ln -sfn "$RUN_DIR" "$RUNS_ROOT/latest"

log "Run — $SCENARIO_TITLE — OS dark mode $ORIG_OS_DARK, app theme $ORIG_THEME"
ensure_front
sleep 1

# window_step <titlebar> <content> — judge the window; record the View menu's
# shade without judging it (menu-bar menus follow macOS, see ADR-0089).
window_step() {
  local tb=$1 ct=$2 menu
  if expect_window "$tb" "$ct"; then
    menu=$(view_menu_shade)
    step_end PASS "title bar $tb, content $ct (lumas: $(cut -d' ' -f3- <<< "$WIN")); View menu, not judged: ${menu%% *} (luma ${menu#* })"
  else
    step_end FAIL "expected title bar $tb + content $ct within ${SETTLE_S} s; got '${WIN:-no capture}' (title bar, content, lumas)"
  fi
}

step_begin P1 "macOS Light + app Dark → native chrome dark"
set_os_dark false
poll 5 os_is false || fail_step "could not switch macOS to Light"
choose_theme Dark || fail_step "could not choose View → Appearance → Dark"
window_step dark dark

step_begin P2 "macOS Dark + app Light → native chrome light"
set_os_dark true
poll 5 os_is true || fail_step "could not switch macOS to Dark"
choose_theme Light || fail_step "could not choose View → Appearance → Light"
window_step light light

step_begin P3 "app System (macOS Dark) → chrome and content follow macOS: dark"
choose_theme System || fail_step "could not choose View → Appearance → System"
window_step dark dark

step_begin P4 "app System, macOS switched to Light live → chrome and content light"
set_os_dark false
poll 5 os_is false || fail_step "could not switch macOS to Light"
window_step light light

step_begin P5 "sign-out confirmation (NSAlert sheet) follows the app theme: Dark on macOS Light"
if ! on_main_screen; then
  step_end SKIP "the app is not signed in, so there is no sign-out confirmation to open"
elif [ "$(sync_help)" != Synced ]; then
  step_end SKIP "sync status is '$(sync_help)', not Synced — not opening the sign-out confirmation"
else
  choose_theme Dark || fail_step "could not choose View → Appearance → Dark"
  open_app_menu && choose_sign_out || fail_step "could not open App menu → Sign out"
  cancel_btn=""
  sheet_frame=""
  # AX reports the sheet's final frame while it is still sliding in, so wait
  # for two equal reads 0.5 s apart, then a little more, before capturing:
  # otherwise the capture includes the (dark) window behind the sheet.
  prev_frame=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    dump=$(ax_dump)
    cancel_btn=$(jq -c 'map(select(.role == "AXButton" and .title == "Cancel")) | first // empty' <<< "$dump")
    sheet_frame=$(jq -r 'map(select(.role == "AXSheet")) | first // empty | "\(.x | floor) \(.y | floor) \(.w | floor) \(.h | floor)"' <<< "$dump")
    [ -n "$cancel_btn" ] && [ -n "$sheet_frame" ] && [ "$sheet_frame" = "$prev_frame" ] && break
    prev_frame=$sheet_frame
    sleep 0.5
  done
  sleep 0.5
  if [ -z "$cancel_btn" ] || [ -z "$sheet_frame" ]; then
    osascript -e 'tell application "System Events" to key code 53' > /dev/null
    fail_step "the sign-out confirmation did not appear as a sheet with a Cancel button"
  fi
  # shellcheck disable=SC2086
  f=$(capture_rect alert-sheet $sheet_frame)
  l=$([ -n "$f" ] && region_luma "$f" 0.05 0.05 0.95 0.95)
  ax_native_press "$cancel_btn" || osascript -e 'tell application "System Events" to key code 53' > /dev/null
  # Ask System Events, not the AX dump: axq returns [] for a child list it
  # can't read, so a partial dump could omit an open sheet. Here a failed read
  # prints nothing, which never counts as closed.
  sheet_closed() {
    [ "$(se "tell $(dp) to get count of sheets of window \"Drafto\"")" = 0 ]
  }
  poll 5 sheet_closed || fail_step "the sign-out confirmation was still open after Cancel"
  on_main_screen || fail_step "the app left the main screen after Cancel"
  if [ "$(shade "${l:-}")" = dark ]; then
    step_end PASS "sheet luma $l (dark); cancelled, still signed in"
  else
    step_end FAIL "sheet luma ${l:-none} ($(shade "${l:-}")), expected dark; cancelled, still signed in"
  fi
fi

RUN_COMPLETE=1
