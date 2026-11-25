# Test doubles for factory-agent-split.test.mjs, sourced after the extracted
# split_* functions. gh, the board CLI (factory-project.mjs) and claude
# (run-claude.mjs) are HARD stubs: split_card files public issues and moves
# cards, and without these a unit test would do that on the live repo and
# board. state-cli.mjs and factory-split.mjs run for real, against the temp
# STATE_FILE and files under $T. The knobs below are env vars the test sets.
#
#   T                 the test's temp dir (required)
#   CLAUDE_RC         run-claude's exit code (default 0); stdout is $T/claude.out
#   SESSION_LIMIT=1   check_session_limit says the run hit a session limit
#   FAIL_CREATE_AT=n  `gh issue create` fails, creating nothing, for issue n
#   LOSE_REPLY_AT=n   `gh issue create` creates issue n but fails anyway
#   FAIL_RECENT=1     the recent-issues listing fails
#   FAIL_COMMENT=1    `gh issue comment` fails
#   $T/status-<n>     the board Status ensure-item reports for issue n (JSON)
#   $T/linked         the parent's sub-issue numbers, one per line
CALLS="$T/calls"
touch "$CALLS"
[[ -f "$T/recent.json" ]] || echo '[]' >"$T/recent.json"
[[ -f "$T/counter" ]] || echo 1000 >"$T/counter"
[[ -f "$T/linked" ]] || : >"$T/linked"

log() { echo "[log] $*" >>"$CALLS"; }
logerr() { echo "[log] $*" >>"$CALLS"; }
check_session_limit() { [[ "${SESSION_LIMIT:-0}" -eq 1 ]]; }
pause_for_session_limit() { echo "[pause]" >>"$CALLS"; }

node() {
  local a line=""
  case "${1:-}" in
    */run-claude.mjs)
      for a in "${@:2}"; do
        if [[ "$a" == *$'\n'* ]]; then a="<input>"; fi
        line+=" [$a]"
      done
      echo "[claude]$line timeout=${CLAUDE_CALL_TIMEOUT_SEC:-unset}" >>"$CALLS"
      cat "$T/claude.out" 2>/dev/null || true
      return "${CLAUDE_RC:-0}"
      ;;
    */factory-project.mjs)
      echo "[project] ${*:2}" >>"$CALLS"
      if [[ "${2:-}" == "ensure-item" ]]; then
        printf '{"itemId":"ITEM_%s","status":%s,"added":false}\n' "$4" \
          "$(cat "$T/status-$4" 2>/dev/null || echo '"Backlog"')"
      fi
      return 0
      ;;
  esac
  command node "$@"
}

gh() {
  local n
  case "${1:-} ${2:-}" in
    "issue create")
      # gh issue create --repo <r> --title <t> --body-file <f>
      n=$(($(cat "$T/counter") + 1))
      echo "$n" >"$T/counter"
      echo "[gh] issue create #$n title=$6" >>"$CALLS"
      if [[ "${FAIL_CREATE_AT:-}" == "$n" ]]; then return 1; fi
      cp "$8" "$T/body-$n"
      jq --argjson n "$n" --rawfile b "$8" \
        '[{number: $n, author_association: "OWNER", body: $b}] + .' "$T/recent.json" >"$T/recent.tmp"
      mv "$T/recent.tmp" "$T/recent.json"
      if [[ "${LOSE_REPLY_AT:-}" == "$n" ]]; then return 1; fi
      echo "https://github.com/JakubAnderwald/drafto/issues/$n"
      ;;
    "issue comment")
      echo "[gh] issue comment $3" >>"$CALLS"
      { cat; echo; echo "-----"; } >>"$T/posted"
      [[ "${FAIL_COMMENT:-0}" -eq 0 ]]
      ;;
    "issue edit")
      echo "[gh] $*" >>"$CALLS"
      ;;
    "issue view")
      echo "[gh] $*" >>"$CALLS"
      printf 'status:plan-review\nfactory-oversize\n'
      ;;
    "api repos/JakubAnderwald/drafto/issues?state=all&sort=created&direction=desc&per_page=50")
      echo "[gh] api recent" >>"$CALLS"
      [[ "${FAIL_RECENT:-0}" -eq 0 ]] || return 1
      cat "$T/recent.json"
      ;;
    "api --paginate")
      echo "[gh] api sub_issues $3" >>"$CALLS"
      cat "$T/linked"
      ;;
    "api -X")
      # gh api -X POST <path> -F sub_issue_id=<id>
      echo "[gh] api $3 $4 $6" >>"$CALLS"
      ;;
    "api repos/JakubAnderwald/drafto/issues/"*)
      echo "[gh] api id ${2##*/}" >>"$CALLS"
      echo "$((${2##*/} + 7000000))"
      ;;
    *)
      echo "[gh] UNEXPECTED $*" >>"$CALLS"
      return 1
      ;;
  esac
}
