#!/bin/bash
# Logging, step bookkeeping and the report for an In-Test scenario. Expects
# RUN_DIR, APP and SCENARIO_TITLE (see harness.sh); BACKEND names what the run
# talks to in the report (default production).

: "${RUN_DIR:?}" "${APP:?}" "${SCENARIO_TITLE:?}"

# Numbers in a C format for every scenario: awk's printf follows the locale, so
# under pl_PL "%.4f" prints 0,0037, which the Swift helpers reject. LC_ALL would
# override LC_NUMERIC, so drop it, but keep what it set for everything else:
# LC_ALL beats LC_CTYPE and LANG, so copy it into LC_CTYPE (the character set,
# UTF-8 for the ✓ menu-checkmark match) and, when LANG is unset, into LANG.
if [ -n "${LC_ALL:-}" ]; then
  export LC_CTYPE="$LC_ALL"
  export LANG="${LANG:-$LC_ALL}"
  unset LC_ALL
fi
export LC_NUMERIC=C

RESULTS="$RUN_DIR/results.jsonl"
SHOT_N=0
STEP_ID=""
STEP_NAME=""
STEP_T0=0
STEP_OPEN=0
RUN_COMPLETE=0
RUN_OUTCOME=""

# app_plist <key> — from the installed bundle, read directly (`defaults read`
# goes through cfprefsd and can return a cached value).
app_plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Contents/Info.plist" 2> /dev/null; }

log() {
  printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$RUN_DIR/log.txt" >&2
}

die() {
  log "FATAL: $*"
  exit 1
}

# shot <label> — capture the Drafto window (works even when it is covered).
shot() {
  SHOT_N=$((SHOT_N + 1))
  local f
  f="$RUN_DIR/shots/$(printf '%02d' "$SHOT_N")-$1.png"
  win_capture "$f" 2> /dev/null || log "   (screenshot failed: $1)"
}

step_begin() {
  STEP_ID=$1
  STEP_NAME=$2
  STEP_T0=$(date +%s)
  STEP_OPEN=1
  log "── Step $STEP_ID: $STEP_NAME"
}

# step_end <PASS|FAIL|WARN|SKIP|ABORTED> <evidence>
step_end() {
  local status=$1 detail=$2 secs
  STEP_OPEN=0
  secs=$(($(date +%s) - STEP_T0))
  jq -nc --arg id "$STEP_ID" --arg name "$STEP_NAME" --arg status "$status" \
    --arg detail "$detail" --argjson secs "$secs" \
    '{step: $id, name: $name, status: $status, secs: $secs, detail: $detail}' >> "$RESULTS"
  log "   → $status ($secs s): $detail"
  shot "step-$STEP_ID-$status"
}

# fail_step <evidence> — record the failure and stop; the EXIT trap cleans up.
fail_step() {
  step_end FAIL "$1"
  exit 1
}

write_report() {
  local report="$RUN_DIR/report.md"
  {
    echo "# $SCENARIO_TITLE — automated In-Test run $(basename "$RUN_DIR")"
    echo
    echo "Build: Drafto $(app_plist CFBundleShortVersionString) ($(app_plist CFBundleVersion)), backend: ${BACKEND:-production}"
    echo
    echo "Run: ${RUN_OUTCOME:-unknown}"
    echo
    echo "| Step | Check | Result | Time | Evidence |"
    echo "|---|---|---|---|---|"
    if [ -s "$RESULTS" ]; then
      jq -r '"| \(.step) | \(.name) | \(.status) | \(.secs) s | \(.detail | gsub("\\|"; "/")) |"' "$RESULTS"
    fi
    echo
    if [ -s "$RESULTS" ]; then
      jq -rs '"Totals: " + (group_by(.status) | map("\(.[0].status) \(length)") | join(", "))' "$RESULTS"
    else
      echo "No steps ran."
    fi
  } > "$report"
}
