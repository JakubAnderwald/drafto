#!/bin/bash
# Drafto dark-factory agent — launchd entrypoint.
#
# Modeled on scripts/support-agent.sh. Modes:
#
#   --plan       Read Status=Ready items, validate spec, invoke Claude to
#                propose a plan, advance card to Plan Review (or Blocked).
#                Works in every phase. Phase A's only meaningful mode.
#
#   --implement  Pick up Status=In Progress items. Phase A: post a stub
#                "phase=A; implementation skipped" comment per card and
#                stop. Phase B+: claim a worktree slot, invoke Claude
#                against the approved plan, push a PR, advance to
#                In Review. (Phase B+ NOT YET IMPLEMENTED in Wave 3 —
#                logs and exits 0.)
#
#   --release    Approved → Released. Migration gate, squash-merge,
#                beta-channel dispatch. (Phase B+ NOT YET IMPLEMENTED in
#                Wave 3 — logs and exits 0.)
#
#   --watch      In Review → In Test. Poll CI, resolve review comments,
#                detect Vercel preview, advance card. (Phase B+ NOT YET
#                IMPLEMENTED in Wave 3 — logs and exits 0.)
#
# Each mode acquires its own PID-file lock so multiple modes can run
# back-to-back in one launchd tick without contending. --implement also
# claims a per-slot lock (slot0|slot1) for the worktree it owns; the
# other modes are I/O-bound and use a single mode-wide lock.
#
# Phase gate: --phase A|B|C|D. Refusing to operate outside the requested
# phase is the prompt's job (the bundle includes config.phase); bash
# enforces the structural gate (e.g. "Phase A skips --release entirely").
#
# Kill switches honoured on every cycle:
#   - `logs/factory-state.json::paused === true` (set via
#     `state-cli.mjs factory:pause`) — exit 0 silently.
#   - `factory-pause` label on a board item — bash filters it out before
#     handing the queue to mode-specific work.
#
# Failure trap (exit code != 0): file a `factory-failure`-labelled GitHub
# issue (mirrors the `nightly-failure` pattern in support-agent.sh /
# nightly-support.sh).

set -euo pipefail

# ── PATH / locale (launchd provides minimal env) ────────────────────────────
export PATH="$HOME/.local/bin:$PATH"
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

# ── Claude call timeout ─────────────────────────────────────────────────────
# Same single source of truth as support-agent.sh. scripts/lib/run-claude.mjs
# reads this from the env. Defining it here keeps the bash log lines and the
# wrapper's enforced cap in sync.
export CLAUDE_CALL_TIMEOUT_SEC="${CLAUDE_CALL_TIMEOUT_SEC:-180}"

# ── Args ────────────────────────────────────────────────────────────────────
MODE_PLAN=0
MODE_IMPLEMENT=0
MODE_RELEASE=0
MODE_WATCH=0
PHASE="A"
DRY_RUN=0
usage() {
  cat <<EOF
Usage: $0 (--plan | --implement | --release | --watch) [--phase <A|B|C|D>] [--dry-run]

Exactly one of --plan, --implement, --release, --watch is required.

  --plan       Ready → Plan Review (or Blocked). Real work in every phase.
  --implement  In Progress → In Review. Phase A: stub comment only.
               Phase B+ NOT YET IMPLEMENTED in Wave 3.
  --release    Approved → Released. Phase B+ NOT YET IMPLEMENTED in Wave 3.
  --watch      In Review → In Test. Phase B+ NOT YET IMPLEMENTED in Wave 3.
  --phase X    Override the phase advertised to Claude (default: A).
  --dry-run    Build context bundles and print them; no board / issue
               mutations and no Claude invocation. Useful for golden-run
               testing.
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan) MODE_PLAN=1; shift ;;
    --implement) MODE_IMPLEMENT=1; shift ;;
    --release) MODE_RELEASE=1; shift ;;
    --watch) MODE_WATCH=1; shift ;;
    --phase)
      if [[ -z "${2:-}" || "${2:0:2}" == "--" ]]; then
        echo "ERROR: --phase requires a value (A|B|C|D)" >&2
        usage >&2
        exit 2
      fi
      PHASE="$2"
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

MODE_COUNT=$((MODE_PLAN + MODE_IMPLEMENT + MODE_RELEASE + MODE_WATCH))
if [[ "$MODE_COUNT" -eq 0 ]]; then
  echo "ERROR: must specify exactly one of --plan, --implement, --release, --watch." >&2
  usage >&2
  exit 2
fi
if [[ "$MODE_COUNT" -gt 1 ]]; then
  echo "ERROR: --plan / --implement / --release / --watch are mutually exclusive." >&2
  echo "       Run the launchd entry as multiple sequential invocations." >&2
  exit 2
fi
case "$PHASE" in
  A|B|C|D) ;;
  *) echo "ERROR: --phase must be one of A, B, C, D (got '$PHASE')" >&2; exit 2 ;;
esac

if [[ "$MODE_PLAN" -eq 1 ]]; then MODE_NAME="plan"
elif [[ "$MODE_IMPLEMENT" -eq 1 ]]; then MODE_NAME="implement"
elif [[ "$MODE_RELEASE" -eq 1 ]]; then MODE_NAME="release"
else MODE_NAME="watch"
fi

# ── Allowlist env (single source of truth, shared with support-agent.sh) ────
# The factory uses the same secrets file because the household autopilot
# (allowlisted reporters can advance state via email) is the support-agent's
# territory — keeping one allowlist avoids drift.
if [[ -f "$HOME/drafto-secrets/support-env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/drafto-secrets/support-env.sh"
fi
SUPPORT_ALLOWLIST="${SUPPORT_ALLOWLIST:-jakub@anderwald.info,joanna@anderwald.info}"
ADMIN_EMAIL="${SUPPORT_ADMIN_EMAIL:-jakub@anderwald.info}"
OAUTH_FILE="$HOME/drafto-secrets/zoho-oauth.json"
OAUTH_USER_EMAIL=""
if [[ -f "$OAUTH_FILE" ]]; then
  OAUTH_USER_EMAIL=$(jq -r '.primary_email // empty' "$OAUTH_FILE" 2>/dev/null || echo "")
fi
OAUTH_USER_EMAIL="${OAUTH_USER_EMAIL:-support@drafto.eu}"

# ── Paths, logs, lock ───────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
umask 077
LOG_DIR="$REPO_ROOT/logs/factory"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/factory-agent-$MODE_NAME-$(date +%Y-%m-%d).log"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
find "$LOG_DIR" -type f -name 'factory-agent-*.log' -mtime +30 -delete 2>/dev/null || true

# Per-mode lock. Portable PID-file lock (macOS does not ship flock). Stale
# locks (PID no longer alive) are reaped automatically — matches the pattern
# in support-agent.sh.
LOCK_FILE="$REPO_ROOT/logs/factory-$MODE_NAME.lock"
if [[ -f "$LOCK_FILE" ]]; then
  EXISTING_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] Another factory-agent --$MODE_NAME run is in progress (pid=$EXISTING_PID), exiting." \
      | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi
echo "$$" > "$LOCK_FILE"

STATE_FILE="$REPO_ROOT/logs/factory-state.json"

cd "$REPO_ROOT"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# ── Failure notification (mirrors support-agent.sh) ─────────────────────────
cleanup() {
  local exit_code=$?
  rm -f "$LOCK_FILE"
  if [[ $exit_code -ne 0 ]]; then
    log "ERROR: factory-agent --$MODE_NAME exiting with code $exit_code"
    # IMPORTANT: the regex intentionally drops any line that lacks a
    # `[HH:MM:SS]` log() prefix — including any JSON bundles printed in
    # --dry-run mode, which contain issue bodies / customer emails (PII).
    # Don't loosen this filter without redacting bundle contents first.
    local sanitized_log
    sanitized_log=$(grep -E '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' "$LOG_FILE" 2>/dev/null | tail -20 \
      || echo "No log available")
    if command -v gh &>/dev/null; then
      gh issue create \
        --repo JakubAnderwald/drafto \
        --title "factory-agent --$MODE_NAME failed ($(date +%Y-%m-%d))" \
        --label "factory-failure" \
        --body "$(cat <<EOF
The Drafto dark-factory agent (mode: \`--$MODE_NAME\`, phase: \`$PHASE\`) exited with code \`$exit_code\` on $(date '+%Y-%m-%d at %H:%M:%S').

### Script log (timestamped entries only)

\`\`\`
$sanitized_log
\`\`\`

Full log on the Mac mini: \`logs/factory/factory-agent-$MODE_NAME-$(date +%Y-%m-%d).log\` (gitignored).

See \`docs/operations/factory-runbook.md\` for triage steps.
EOF
        )" 2>/dev/null || log "WARNING: failed to file factory-failure issue"
    else
      log "WARNING: gh CLI unavailable, no failure issue filed"
    fi
  fi
}
trap cleanup EXIT

START_TIME=$(date +%s)
log "=== factory-agent --$MODE_NAME run started (phase=$PHASE, dry-run=$DRY_RUN) ==="

# ── Pre-flight: required CLIs ───────────────────────────────────────────────
for required in gh jq node; do
  if ! command -v "$required" >/dev/null 2>&1; then
    log "ERROR: $required not on PATH (PATH=$PATH)"
    exit 1
  fi
done
# --plan invokes Claude per Ready card. --implement Phase A doesn't.
if [[ "$MODE_PLAN" -eq 1 && "$DRY_RUN" -eq 0 ]] && ! command -v claude >/dev/null 2>&1; then
  log "ERROR: --plan requires the claude CLI on PATH"
  exit 1
fi

# ── Pause check ─────────────────────────────────────────────────────────────
# `state-cli factory:paused?` exits 0 when paused; flip the bash sense so the
# guard reads naturally. Exit 0 silently (NOT non-zero) so the failure trap
# doesn't file a bogus issue — pause is an explicit operator action, not a
# fault.
if node "$SCRIPT_DIR/lib/state-cli.mjs" factory:paused? --state-file "$STATE_FILE" 2>/dev/null; then
  REASON=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:status --state-file "$STATE_FILE" 2>/dev/null \
    | jq -r '.pausedReason // empty' 2>/dev/null || echo "")
  log "Factory is paused${REASON:+ (reason: $REASON)}; exiting."
  exit 0
fi

# ── Phase A skip-modes ──────────────────────────────────────────────────────
# Phase B+ work for --release / --watch isn't part of Wave 3. The script
# accepts the flags so the launchd plist stays stable across waves, but the
# bodies are no-ops in Phase A.
if [[ "$PHASE" == "A" && ( "$MODE_RELEASE" -eq 1 || "$MODE_WATCH" -eq 1 ) ]]; then
  log "Phase A: --$MODE_NAME is a no-op (gated until Phase B)"
  log "=== factory-agent --$MODE_NAME completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi
# Phase B+ work for --implement isn't part of Wave 3 either. Phase A
# --implement (the stub comment) IS implemented below.
if [[ "$PHASE" != "A" && "$MODE_IMPLEMENT" -eq 1 ]]; then
  log "Phase $PHASE --implement is NOT YET IMPLEMENTED (Wave 3 ships Phase A only); exiting 0"
  log "=== factory-agent --$MODE_NAME completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi
if [[ "$PHASE" != "A" && ( "$MODE_RELEASE" -eq 1 || "$MODE_WATCH" -eq 1 ) ]]; then
  log "Phase $PHASE --$MODE_NAME is NOT YET IMPLEMENTED (Wave 3 ships Phase A only); exiting 0"
  log "=== factory-agent --$MODE_NAME completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# ── Project board lookup ────────────────────────────────────────────────────
# Cache the projectId in the env so child `factory-project.mjs` invocations
# don't repeat the lookup (factory-project.mjs reads FACTORY_PROJECT_ID).
if [[ -z "${FACTORY_PROJECT_ID:-}" ]]; then
  if ! PROJECT_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" find-project 2>>"$LOG_FILE"); then
    # Transient lookup failures shouldn't file a noise issue. Skip this tick.
    log "WARNING: factory-project find-project failed (transient?); skipping this --$MODE_NAME tick"
    exit 0
  fi
  if [[ -z "$PROJECT_JSON" || "$PROJECT_JSON" == "null" ]]; then
    log "ERROR: Project v2 board not found. Run scripts/setup-factory-board.sh first."
    exit 1
  fi
  FACTORY_PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.projectId')
  export FACTORY_PROJECT_ID
  log "Resolved project board: $(echo "$PROJECT_JSON" | jq -r '.projectUrl') (id=$FACTORY_PROJECT_ID)"
fi

# ── Helpers ─────────────────────────────────────────────────────────────────

# Status field option name (board side) → status:* label name (issue side).
# Used by transition_status so a board move always co-emits the matching
# label as a transition side-effect (observability, per the proposal).
status_label_for() {
  case "$1" in
    Ready)         echo "status:ready" ;;
    Planning)      echo "status:planning" ;;
    "Plan Review") echo "status:plan-review" ;;
    "In Progress") echo "status:in-progress" ;;
    "In Review")   echo "status:in-review" ;;
    "In Test")     echo "status:in-test" ;;
    Approved)      echo "status:approved" ;;
    Released)      echo "status:released" ;;
    Done)          echo "status:done" ;;
    Blocked)       echo "status:blocked" ;;
    *)             echo "" ;;
  esac
}

# All status:* labels — needed so transition_status can strip the previous
# label without knowing which one it was.
ALL_STATUS_LABELS="status:ready,status:planning,status:plan-review,status:in-progress,status:in-review,status:in-test,status:approved,status:released,status:done,status:blocked"

# transition_status <item-id> <issue-number> <new-status>
#
# Sets the board Status field AND swaps the issue's status:* label. The two
# writes are not atomic (GitHub's API doesn't give us a transaction), but
# the board write happens first — if the label write fails, a subsequent
# tick can re-emit the label without re-doing the board work.
transition_status() {
  local item_id="$1"
  local issue_num="$2"
  local new_status="$3"
  local new_label
  new_label=$(status_label_for "$new_status")
  if [[ -z "$new_label" ]]; then
    log "ERROR: transition_status: unknown status '$new_status'"
    return 1
  fi
  if ! node "$SCRIPT_DIR/lib/factory-project.mjs" set-status \
      --item-id "$item_id" --status "$new_status" >>"$LOG_FILE" 2>&1; then
    log "ERROR: factory-project set-status failed for issue #$issue_num → $new_status"
    return 1
  fi
  # gh issue edit accepts multiple --remove-label flags. The current label may
  # not exist (e.g. first transition from Ready, which is human-set), so we
  # remove every status:* label defensively and let `gh` no-op on absent ones.
  local remove_args=()
  IFS=',' read -ra _all_status <<< "$ALL_STATUS_LABELS"
  for lbl in "${_all_status[@]}"; do
    if [[ "$lbl" != "$new_label" ]]; then
      remove_args+=(--remove-label "$lbl")
    fi
  done
  if ! gh issue edit "$issue_num" --repo JakubAnderwald/drafto \
      --add-label "$new_label" "${remove_args[@]}" >>"$LOG_FILE" 2>&1; then
    log "WARNING: gh issue edit failed for issue #$issue_num (label swap → $new_label); board state still advanced"
  fi
  # Record the transition for the runbook's `factory:status` view.
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field \
    "$issue_num" lastStatus "$new_status" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
}

# Spec validation — the bash structural gate before invoking Claude. The
# semantic check (does the "What" describe a coherent change?) is the
# planner's job; bash only enforces that the template's required sections
# are non-empty.
#
# Returns "" on pass, or a short reason string on fail. We deliberately
# accept the parsed spec from factory-bundle.mjs (single source of truth)
# rather than re-parsing in bash.
spec_missing_section() {
  local spec_json="$1"
  if [[ -z "$(echo "$spec_json" | jq -r '.what')" ]]; then
    echo "What"
    return 0
  fi
  if [[ -z "$(echo "$spec_json" | jq -r '.acceptance')" ]]; then
    echo "Acceptance criteria"
    return 0
  fi
  if [[ -z "$(echo "$spec_json" | jq -r '.outOfScope')" ]]; then
    echo "Out of scope"
    return 0
  fi
  # schemaChanges is required (yes|no); null means the dropdown wasn't set.
  if [[ "$(echo "$spec_json" | jq -r '.schemaChanges')" == "null" ]]; then
    echo "Schema changes?"
    return 0
  fi
  # Affected platforms requires at least one checkbox.
  local platforms_count
  platforms_count=$(echo "$spec_json" | jq '.affectedPlatforms | length')
  if [[ "$platforms_count" == "0" ]]; then
    echo "Affected platforms"
    return 0
  fi
  echo ""
}

# Build the per-issue context bundle by piping a JSON envelope into
# factory-bundle.mjs (mirrors how support-agent.sh uses build-bundle.mjs).
build_plan_bundle() {
  local issue_entry="$1"
  local comments_json="$2"
  local repo_head_ref
  repo_head_ref=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  jq -n \
    --argjson issue "$issue_entry" \
    --argjson comments "$comments_json" \
    --arg allowlist "$SUPPORT_ALLOWLIST" \
    --arg oauthUserEmail "$OAUTH_USER_EMAIL" \
    --arg phase "$PHASE" \
    --arg repoNwo "JakubAnderwald/drafto" \
    --arg headRef "$repo_head_ref" \
    '{
       kind: "factory_plan",
       issue: $issue,
       comments: $comments,
       config: {
         phase: $phase,
         allowlist: ($allowlist | split(",") | map(ascii_downcase | sub("^\\s+";"") | sub("\\s+$";""))),
         oauthUserEmail: $oauthUserEmail
       },
       repo: { nameWithOwner: $repoNwo, headRef: $headRef }
     }' \
    | node "$SCRIPT_DIR/lib/factory-bundle.mjs"
}

# Fetch the issue body + labels + comments via gh. The board-item shape we get
# from factory-project.mjs has number/title/url/labels but not the body, so
# we pull the full record once per item.
fetch_issue_record() {
  local issue_num="$1"
  gh issue view "$issue_num" --repo JakubAnderwald/drafto \
    --json number,title,body,state,labels,createdAt 2>>"$LOG_FILE" \
    | jq '{
        number: .number,
        title: .title,
        body: (.body // ""),
        state: .state,
        labels: (.labels | map(.name)),
        createdAt: .createdAt
      }'
}

# Fetch issue comments via the API (gh issue view truncates to 100).
fetch_issue_comments() {
  local issue_num="$1"
  gh api --paginate "repos/JakubAnderwald/drafto/issues/$issue_num/comments" 2>>"$LOG_FILE" \
    | jq '[ .[] | {
        id: .id,
        user: { login: .user.login },
        body: (.body // ""),
        createdAt: .created_at
      } ]'
}

# Has the issue already been planned (marker comment present)? Used for
# idempotency — if a prior tick already posted the plan but the status
# transition failed, we don't re-invoke Claude.
issue_already_planned() {
  local comments_json="$1"
  # The marker is FACTORY_PLAN_MARKER from factory-bundle.mjs:
  #   <!-- drafto-factory-plan -->
  if echo "$comments_json" | jq -e \
      'any(.[]; .body | test("<!-- drafto-factory-plan -->"))' >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Has the issue already received the Phase A implement-stub comment? Used so
# the --implement loop doesn't spam the comment every 5 minutes.
issue_already_impl_stubbed() {
  local comments_json="$1"
  if echo "$comments_json" | jq -e \
      'any(.[]; .body | test("<!-- drafto-factory-impl-phase-a -->"))' >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# ── --plan mode ─────────────────────────────────────────────────────────────
if [[ "$MODE_PLAN" -eq 1 ]]; then
  PROMPT_FILE="$SCRIPT_DIR/factory-plan-prompt.md"
  if [[ "$DRY_RUN" -eq 0 && ! -f "$PROMPT_FILE" ]]; then
    log "ERROR: prompt file missing: $PROMPT_FILE"
    exit 1
  fi

  # Pull the Ready queue from the board. Transient lookup → skip this tick.
  if ! READY_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items \
      --status Ready 2>>"$LOG_FILE"); then
    log "WARNING: query-status-items Ready failed (transient?); skipping this --plan tick"
    exit 0
  fi
  READY_COUNT=$(echo "$READY_JSON" | jq 'length' 2>/dev/null || echo "0")
  if ! [[ "$READY_COUNT" =~ ^[0-9]+$ ]]; then
    log "ERROR: unexpected non-numeric READY_COUNT='$READY_COUNT'"
    exit 1
  fi
  log "--plan: $READY_COUNT Ready item(s) on the board"

  if [[ "$READY_COUNT" -eq 0 ]]; then
    log "=== factory-agent --plan completed in $(( $(date +%s) - START_TIME ))s ==="
    exit 0
  fi

  PROMPT_TEXT=""
  if [[ "$DRY_RUN" -eq 0 ]]; then PROMPT_TEXT=$(cat "$PROMPT_FILE"); fi

  for IDX in $(seq 0 $((READY_COUNT - 1))); do
    ITEM=$(echo "$READY_JSON" | jq ".[${IDX}]")
    ITEM_ID=$(echo "$ITEM" | jq -r '.itemId')
    ISSUE_NUM=$(echo "$ITEM" | jq -r '.issueNumber')
    ITEM_LABELS=$(echo "$ITEM" | jq -r '.labels // [] | join(",")')

    # `factory-pause` label on a single card opts that card out of automation.
    # The global pause flag covers the whole agent; this is the per-card knob.
    if [[ ",$ITEM_LABELS," == *",factory-pause,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (factory-pause label set)"
      continue
    fi

    log "Issue #$ISSUE_NUM: planning"

    if ! ISSUE_RECORD=$(fetch_issue_record "$ISSUE_NUM"); then
      log "ERROR: fetch_issue_record failed for #$ISSUE_NUM"
      continue
    fi
    if ! COMMENTS_JSON=$(fetch_issue_comments "$ISSUE_NUM"); then
      log "ERROR: fetch_issue_comments failed for #$ISSUE_NUM"
      continue
    fi

    if issue_already_planned "$COMMENTS_JSON"; then
      log "Issue #$ISSUE_NUM: plan marker already present; advancing to Plan Review without re-invoking claude"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
      fi
      continue
    fi

    # Build the bundle (factory-bundle.mjs parses the spec out of the body).
    if ! BUNDLE=$(build_plan_bundle "$ISSUE_RECORD" "$COMMENTS_JSON"); then
      log "ERROR: build_plan_bundle failed for #$ISSUE_NUM"
      continue
    fi

    # Structural spec check before mutating board state.
    SPEC=$(echo "$BUNDLE" | jq '.spec')
    MISSING=$(spec_missing_section "$SPEC")
    if [[ -n "$MISSING" ]]; then
      log "Issue #$ISSUE_NUM: spec incomplete (missing: $MISSING)"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Spec incomplete: \`$MISSING\` is empty.**

Please fill in the missing section using the [factory-feature template]\
(https://github.com/JakubAnderwald/drafto/issues/new?template=factory-feature.yml) \
and drag the card back to **Ready**.

See \`docs/features/dark-factory.md\` for the spec contract.

<!-- drafto-factory-spec-incomplete -->" >>"$LOG_FILE" 2>&1 \
          || log "WARNING: failed to post spec-incomplete comment on #$ISSUE_NUM"
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field \
          "$ISSUE_NUM" lastError "spec-incomplete: $MISSING" --state-file "$STATE_FILE" \
          >>"$LOG_FILE" 2>&1 || true
      fi
      continue
    fi

    # Advance to Planning (Status field + label) so the operator can see
    # in-flight work without watching the launchd log. If this step fails the
    # card stays Ready and we'll retry next tick.
    if [[ "$DRY_RUN" -eq 0 ]]; then
      if ! transition_status "$ITEM_ID" "$ISSUE_NUM" "Planning"; then
        log "ERROR: failed to transition #$ISSUE_NUM to Planning; skipping"
        continue
      fi
    fi

    if [[ "$DRY_RUN" -eq 1 ]]; then
      # PII surface: the bundle includes the issue body + comments. The
      # rotating logs/factory/*.log files are 0600 + 30-day retention but we
      # still print bundles to stdout only, never tee'd into LOG_FILE.
      log "DRY-RUN: bundle for #$ISSUE_NUM (printed to stdout only; not logged)"
      echo "$BUNDLE"
      continue
    fi

    CLAUDE_INPUT=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
      "$PROMPT_TEXT" "$BUNDLE")
    log "Invoking claude for #$ISSUE_NUM (--plan, phase=$PHASE)"
    CLAUDE_OUTPUT_FILE=$(mktemp -t factory-agent-out.XXXXXX)
    EXIT_CODE=0
    node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT" --dangerously-skip-permissions \
        >"$CLAUDE_OUTPUT_FILE" 2>>"$LOG_FILE" || EXIT_CODE=$?

    if [[ $EXIT_CODE -eq 124 ]]; then
      log "WARNING: claude timed out (>${CLAUDE_CALL_TIMEOUT_SEC}s) for #$ISSUE_NUM --plan — skipping; next tick retries"
      rm -f "$CLAUDE_OUTPUT_FILE"
      # Leave card at Planning so next tick picks it up.
      continue
    elif [[ $EXIT_CODE -ne 0 ]]; then
      log "ERROR: claude exited non-zero ($EXIT_CODE) for #$ISSUE_NUM --plan"
      cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE" 2>/dev/null || true
      rm -f "$CLAUDE_OUTPUT_FILE"
      # Bump the retry counter; if we exceed budget the next tick will refuse
      # to invoke claude.
      ATTEMPTS=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" \
        --state-file "$STATE_FILE" 2>>"$LOG_FILE" | jq -r '.attempts // 0' || echo "0")
      if [[ "$ATTEMPTS" -ge 5 ]]; then
        log "Issue #$ISSUE_NUM: retry budget exhausted ($ATTEMPTS attempts); advancing to Blocked"
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Planning retry budget exhausted ($ATTEMPTS attempts).**

The factory tried to plan this issue $ATTEMPTS times and each invocation \
of claude failed. Investigate via \`logs/factory/factory-agent-plan-*.log\` \
on the Mac mini, then run \`node scripts/lib/state-cli.mjs factory:reset-attempts $ISSUE_NUM\` \
and drag the card back to **Ready** to retry.

<!-- drafto-factory-retry-exhausted -->" >>"$LOG_FILE" 2>&1 || true
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
      fi
      continue
    fi

    cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE"
    # Strict regex matches the prompt's contract. Anything looser would let
    # mid-stream reasoning that quotes `issue=` slip through and corrupt state.
    SUMMARY_LINE=$(grep -E '^issue=[0-9]+ action=[a-z]+ plan-comment=[^ ]+$' "$CLAUDE_OUTPUT_FILE" | tail -1 || true)
    rm -f "$CLAUDE_OUTPUT_FILE"
    if [[ -z "$SUMMARY_LINE" ]]; then
      log "WARNING: no well-formed summary line returned by claude for #$ISSUE_NUM --plan"
      # Don't transition; next tick will retry. Bump attempts so we eventually
      # surface this to the operator.
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" \
        --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      continue
    fi
    log "Claude summary: $SUMMARY_LINE"
    ACTION=$(echo "$SUMMARY_LINE" | sed -E 's/.*action=([^ ]+).*/\1/')

    case "$ACTION" in
      planned)
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field \
          "$ISSUE_NUM" lastPlanAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        ;;
      blocked)
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field \
          "$ISSUE_NUM" lastError "planner returned blocked" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        ;;
      noop)
        # Idempotency hit: marker comment already existed when claude looked.
        # Advance to Plan Review anyway (the marker IS the plan-posted signal).
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
        ;;
      *)
        log "WARNING: unrecognised action '$ACTION' from claude for #$ISSUE_NUM --plan"
        ;;
    esac
  done

  log "=== factory-agent --plan completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# ── --implement mode (Phase A only in Wave 3) ───────────────────────────────
if [[ "$MODE_IMPLEMENT" -eq 1 ]]; then
  # Phase B+ falls through to the "NOT YET IMPLEMENTED" guard above and never
  # reaches here. By this point PHASE == "A".

  if ! INPROG_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items \
      --status "In Progress" 2>>"$LOG_FILE"); then
    log "WARNING: query-status-items In Progress failed (transient?); skipping this --implement tick"
    exit 0
  fi
  INPROG_COUNT=$(echo "$INPROG_JSON" | jq 'length' 2>/dev/null || echo "0")
  if ! [[ "$INPROG_COUNT" =~ ^[0-9]+$ ]]; then
    log "ERROR: unexpected non-numeric INPROG_COUNT='$INPROG_COUNT'"
    exit 1
  fi
  log "--implement (Phase A): $INPROG_COUNT In Progress item(s)"

  for IDX in $(seq 0 $((INPROG_COUNT - 1))); do
    ITEM=$(echo "$INPROG_JSON" | jq ".[${IDX}]")
    ISSUE_NUM=$(echo "$ITEM" | jq -r '.issueNumber')
    ITEM_LABELS=$(echo "$ITEM" | jq -r '.labels // [] | join(",")')
    if [[ ",$ITEM_LABELS," == *",factory-pause,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (factory-pause label set)"
      continue
    fi

    if ! COMMENTS_JSON=$(fetch_issue_comments "$ISSUE_NUM"); then
      log "WARNING: fetch_issue_comments failed for #$ISSUE_NUM; skipping"
      continue
    fi
    if issue_already_impl_stubbed "$COMMENTS_JSON"; then
      # Comment already posted on a prior tick — nothing more to do in Phase A.
      continue
    fi

    log "Issue #$ISSUE_NUM: posting Phase A implement-stub comment"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "DRY-RUN: would post implement-stub comment on #$ISSUE_NUM"
      continue
    fi
    if ! gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
        --body "🏭 **Phase A: implementation skipped.**

The Drafto factory is running in observation mode (Phase A — plan-only). \
Your approved plan was recorded, but no code will be written until the \
factory is promoted to Phase B.

See \`docs/operations/factory-runbook.md\` for phase-promotion criteria.

<!-- drafto-factory-impl-phase-a -->" >>"$LOG_FILE" 2>&1; then
      log "WARNING: gh issue comment failed for #$ISSUE_NUM"
      continue
    fi
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field \
      "$ISSUE_NUM" lastImplementAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  done

  log "=== factory-agent --implement (Phase A stub) completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# All reachable modes have returned above. Anything that lands here is a bug.
log "ERROR: factory-agent reached unreachable tail (mode=$MODE_NAME phase=$PHASE)"
exit 1
