#!/bin/bash
# TestFlight's first-launch pages, which block a new build from finishing its launch.
#
# The first time a TestFlight build launches, macOS shows TestFlight's onboarding before the app
# gets a window: the build's "What to Test" notes ("From the developer … Continue"), then a
# "Share feedback" page (screenshot with ⇧⌘4), each with "More information" on the left and
# "Continue" on the right. CoreServicesUIAgent owns these windows, not Drafto. Until the last
# Continue is pressed, the Drafto process runs with no window at all, so a script that waits for
# Drafto's window, or reads `window 1` of it, waits forever or reads nothing.
#
# Sourced by run-e2e.sh and by the In-Test harness (in-test/lib/harness.sh).

# Run a command, killing it after $1 seconds: an AX query can hang while a modal is up.
with_time_limit() {
  local secs=$1
  shift
  perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
}

drafto_window_count() {
  with_time_limit 10 osascript -e \
    'tell application "System Events" to if exists process "Drafto" then tell process "Drafto" to return count of windows' \
    2> /dev/null || true
}

# press_testflight_page_continue [named] — press Continue on the front TestFlight first-launch
# page. Prints "pressed-named" (the page names Drafto), "pressed" or "none". With "named", only
# a page that names Drafto is pressed.
#
# The page is the front CoreServicesUIAgent window whose content group holds exactly two
# buttons. Its button titles aren't exposed to accessibility and are localized anyway
# ("Continue", "Dalej"), so Continue is found by position: the right-hand one. Only the first
# page (the "What to Test" notes) names the app, in a line reading exactly "Drafto", so
# dismiss_testflight_notes presses an unnamed page only while it is inside the flow: Drafto
# has no window yet, or the page right before was a Drafto page. That keeps it off any other
# CoreServicesUIAgent dialog (Gatekeeper and the like).
press_testflight_page_continue() {
  with_time_limit 20 osascript - "${1:-any}" << 'EOF' 2> /dev/null || echo none
on run argv
  set pressMode to item 1 of argv
  tell application "System Events"
    if not (exists process "CoreServicesUIAgent") then return "none"
    tell process "CoreServicesUIAgent"
      if (count of windows) is 0 then return "none"
      try
        set g to UI element 1 of window 1
        set btns to buttons of g
        if (count of btns) is not 2 then return "none"
        set namesDrafto to false
        repeat with t in (static texts of g)
          try
            if ((value of t) as text) is "Drafto" then set namesDrafto to true
          end try
        end repeat
        if pressMode is "named" and not namesDrafto then return "none"
        set b1 to item 1 of btns
        set b2 to item 2 of btns
        -- Read each position into a variable first: `item 1 of (position of b)` is not a
        -- valid specifier inside a tell block.
        set p1 to position of b1
        set p2 to position of b2
        if (item 1 of p2) > (item 1 of p1) then
          perform action "AXPress" of b2
        else
          perform action "AXPress" of b1
        end if
        if namesDrafto then return "pressed-named"
        return "pressed"
      end try
    end tell
  end tell
  return "none"
end run
EOF
}

# dismiss_testflight_notes [timeout_s] — press Continue through TestFlight's first-launch pages
# (at most 5): the ones blocking Drafto's launch, and any left over from an earlier launch once
# Drafto is up (they sit over its window, where a click would land on them). Then wait up to
# timeout_s (default 30) for Drafto's window. Prints a line for each page it dismisses. Returns 1
# if it pressed something and Drafto still has no window when the time is up, 0 otherwise
# (nothing to dismiss, Drafto not running, or Drafto's window is up).
dismiss_testflight_notes() {
  local timeout=${1:-30} pages=0 waited=0 in_flow=false result
  pgrep -x Drafto > /dev/null || return 0
  while [ "$pages" -lt 5 ]; do
    if [ "$(drafto_window_count)" = 0 ] || [ "$in_flow" = true ]; then
      result=$(press_testflight_page_continue any)
    else
      result=$(press_testflight_page_continue named)
    fi
    [ "$result" != none ] || break
    # A Drafto page starts a flow; the pages after it don't name the app.
    in_flow=true
    pages=$((pages + 1))
    echo "  ℹ  Pressed Continue on a TestFlight first-launch page ($pages)"
    sleep 1.5
  done
  [ "$pages" -gt 0 ] || return 0
  while [ "$waited" -lt "$timeout" ]; do
    [ "$(drafto_window_count)" -gt 0 ] 2> /dev/null && return 0
    sleep 1
    waited=$((waited + 1))
  done
  echo "  ⚠  Drafto still has no window ${timeout}s after TestFlight's first-launch pages"
  return 1
}
