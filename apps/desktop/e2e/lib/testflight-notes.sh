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
# Sourced by run-e2e.sh and by the In-Test preflights (in-test/lib/app.sh).

# Run a command, killing it after $1 seconds: an AX query can hang while a modal is up.
with_time_limit() {
  local secs=$1
  shift
  perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
}

# limit_to <deadline> <max> — seconds left before <deadline> (a $SECONDS value), capped at <max>
# and at least 1: the time limit for one AX query, so no query outlasts the deadline.
limit_to() {
  local left=$(($1 - SECONDS))
  [ "$left" -lt "$2" ] || left=$2
  [ "$left" -ge 1 ] || left=1
  echo "$left"
}

# drafto_window_count [limit_s] — Drafto's window count, or nothing if it can't be read.
drafto_window_count() {
  with_time_limit "${1:-10}" osascript -e \
    'tell application "System Events" to if exists process "Drafto" then tell process "Drafto" to return count of windows' \
    2> /dev/null || true
}

# agent_window_count [limit_s] — how many windows CoreServicesUIAgent has up.
agent_window_count() {
  with_time_limit "${1:-10}" osascript -e \
    'tell application "System Events" to if exists process "CoreServicesUIAgent" then tell process "CoreServicesUIAgent" to return count of windows' \
    2> /dev/null || true
}

# press_testflight_page_continue <limit_s> [frame] — press Continue on the front TestFlight
# first-launch page. Prints "pressed <x>,<y>,<w>,<h>" (the page's window frame) or "none".
#
# Without a frame, the page must name Drafto: the first page (the "What to Test" notes) has a
# line reading exactly "Drafto", and it starts a flow. The later pages never name the app, so
# with a frame (the one the previous page of the flow had) a page is pressed only if it sits
# exactly there. That keeps the helper off any other CoreServicesUIAgent dialog (Gatekeeper and
# the like). A page is the front window's content group with exactly two buttons. Their titles
# aren't exposed to accessibility and are localized anyway ("Continue", "Dalej"), so Continue is
# found by position: the right-hand one.
press_testflight_page_continue() {
  with_time_limit "$1" osascript - "${2:-}" << 'EOF' 2> /dev/null || echo none
on run argv
  set wantFrame to item 1 of argv
  tell application "System Events"
    if not (exists process "CoreServicesUIAgent") then return "none"
    tell process "CoreServicesUIAgent"
      if (count of windows) is 0 then return "none"
      try
        set w to window 1
        -- Read each position and size into a variable first: `item 1 of (position of x)`
        -- is not a valid specifier inside a tell block.
        set wp to position of w
        set ws to size of w
        set frameText to ((item 1 of wp) as text) & "," & ((item 2 of wp) as text) & "," & ((item 1 of ws) as text) & "," & ((item 2 of ws) as text)
        set g to UI element 1 of w
        set btns to buttons of g
        if (count of btns) is not 2 then return "none"
        if wantFrame is "" then
          set namesDrafto to false
          repeat with t in (static texts of g)
            try
              if ((value of t) as text) is "Drafto" then set namesDrafto to true
            end try
          end repeat
          if not namesDrafto then return "none"
        else if frameText is not wantFrame then
          return "none"
        end if
        set b1 to item 1 of btns
        set b2 to item 2 of btns
        set p1 to position of b1
        set p2 to position of b2
        if (item 1 of p2) > (item 1 of p1) then
          perform action "AXPress" of b2
        else
          perform action "AXPress" of b1
        end if
        return "pressed " & frameText
      end try
    end tell
  end tell
  return "none"
end run
EOF
}

# dismiss_testflight_notes [timeout_s] — press Continue through TestFlight's first-launch pages
# (at most 5), both the ones blocking Drafto's launch and any left over from an earlier launch
# once Drafto is up (they sit over its window, where a click would land on them). Then wait for
# Drafto's window, all within timeout_s (default 30) of elapsed time. Prints a line for each page
# it dismisses. Returns 0 when Drafto isn't running, or once Drafto's window is up and nothing
# of TestFlight's is left over it. Returns 1 when Drafto still has no window at the deadline; if
# a CoreServicesUIAgent dialog that never named Drafto is what's up, it says so and leaves that
# dialog for a person.
dismiss_testflight_notes() {
  local timeout=${1:-30} deadline pages=0 frame="" last_press=0 result count
  pgrep -x Drafto > /dev/null || return 0
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$pages" -lt 5 ]; then
      result=$(press_testflight_page_continue "$(limit_to "$deadline" 20)" "$frame")
      if [ "${result%% *}" = pressed ]; then
        frame=${result#pressed }
        pages=$((pages + 1))
        last_press=$SECONDS
        echo "  ℹ  Pressed Continue on a TestFlight first-launch page ($pages)"
        sleep 1
        continue
      fi
    fi
    if [ "$pages" -eq 0 ]; then
      # Drafto is up (or its windows can't be read): nothing of TestFlight's blocks it.
      count=$(drafto_window_count "$(limit_to "$deadline" 10)")
      [ "$count" = 0 ] || return 0
      # Drafto has no window yet. Right after a launch the first page may not be up, or its
      # text not loaded, so keep looking until the deadline rather than judging it now.
      sleep 1
      continue
    fi
    # The next page of a flow can take a moment to appear: look for one for 5 s after a press
    # before settling for Drafto's window.
    if [ $((SECONDS - last_press)) -ge 5 ] || [ "$pages" -ge 5 ]; then
      count=$(drafto_window_count "$(limit_to "$deadline" 10)")
      [ "${count:-0}" -gt 0 ] 2> /dev/null && return 0
    fi
    sleep 1
  done
  if [ "$pages" -eq 0 ] && [ "$(agent_window_count 5)" -gt 0 ] 2> /dev/null; then
    echo "  ⚠  Drafto has no window and a system dialog that doesn't name Drafto is up; dismiss it by hand"
  elif [ "$pages" -eq 0 ]; then
    echo "  ⚠  Drafto has had no window for ${timeout}s"
  else
    echo "  ⚠  Drafto still has no window ${timeout}s after TestFlight's first-launch pages"
  fi
  return 1
}
