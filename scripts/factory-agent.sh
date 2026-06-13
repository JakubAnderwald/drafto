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
#                stop. Phase B+: claim a worktree slot, create the worktree
#                from origin/main, invoke Claude against the approved plan,
#                run the parity post-check on the opened PR, advance to
#                In Review. The slot + worktree persist for --watch.
#
#   --watch      In Review → In Test. For each open factory PR: poll CI and
#                unresolved review comments; when something is failing,
#                resume the worktree and invoke Claude (factory-watch-prompt)
#                to push a fix; when CI is green AND a Vercel preview is
#                reachable, advance the card to In Test and post the preview
#                URL. Also runs a cleanup sweep that releases slots +
#                removes worktrees for cards that have left In Review/In Test.
#
#   --release    Approved → Released. Migration gate, squash-merge,
#                beta-channel dispatch. DEFERRED in the staged Phase B
#                rollout (--implement + --watch ship first; the operator
#                merges the PR by hand at the Approved drag). Logs and
#                exits 0 in every phase until --release is built.
#
# Each mode acquires its own PID-file lock so multiple modes can run
# back-to-back in one launchd tick without contending. --implement and
# --watch additionally track per-issue worktree slots (slot0|slot1) in
# logs/factory-state.json; because only one --implement and one --watch
# process can run at a time (the mode-wide lock), the state file is the
# slot source of truth and no separate per-slot flock is needed.
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

# --plan is read-only and quick (180s is plenty). --implement and --watch run
# Claude through edits + the verification matrix (lint/typecheck/test), which
# is minutes of work — they override the cap per-call. run-claude.mjs reads
# CLAUDE_CALL_TIMEOUT_SEC from the env at spawn time, so an inline prefix on
# the node invocation is enough.
IMPLEMENT_TIMEOUT_SEC="${FACTORY_IMPLEMENT_TIMEOUT_SEC:-1800}"
WATCH_TIMEOUT_SEC="${FACTORY_WATCH_TIMEOUT_SEC:-900}"

# Retry budget shared by --plan / --implement / --watch. After this many failed
# Claude invocations on one issue, the card is parked in Blocked for a human.
FACTORY_MAX_ATTEMPTS="${FACTORY_MAX_ATTEMPTS:-5}"

# pnpm install in a fresh worktree. node_modules is seeded from the main
# checkout by clonefile first (seed_worktree_node_modules), so this is a near-
# instant offline reconcile; the cap only fires on a pathological hang (e.g. the
# store volume vanished). Bounding it stops a stuck install from holding the
# implement lock for hours and starving every other card (#451).
INSTALL_TIMEOUT_SEC="${FACTORY_INSTALL_TIMEOUT_SEC:-600}"

# Minimum free disk (whole GiB) on the worktree volume before the factory will
# start implementing a card. Below this, the card is parked in Blocked with a
# comment rather than failing mid-build on a full disk (#451). The clonefile
# seed adds ~0 bytes, so this mainly protects the build/test phase.
FACTORY_MIN_FREE_DISK_GB="${FACTORY_MIN_FREE_DISK_GB:-3}"

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
               Phase B+: worktree + Claude + PR + parity post-check.
  --watch      In Review → In Test. Phase B+: CI/preview poll + fix loop.
  --release    Approved → Released. DEFERRED (staged Phase B); no-op for now.
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

# ── Phase / mode gates ──────────────────────────────────────────────────────
# Phase A: --release and --watch are no-ops (plan-only observation phase).
# --implement falls through to its Phase A stub body below.
if [[ "$PHASE" == "A" && ( "$MODE_RELEASE" -eq 1 || "$MODE_WATCH" -eq 1 ) ]]; then
  log "Phase A: --$MODE_NAME is a no-op (gated until Phase B)"
  log "=== factory-agent --$MODE_NAME completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi
# --release is DEFERRED in the staged Phase B rollout: --implement and --watch
# ship first so plan→implement→preview quality can be proven on real web issues
# before the factory is granted autonomous merge-to-main. Until --release is
# built, the operator merges the PR by hand at the Approved drag. No-op here in
# every phase so the launchd loop can keep the flag wired without effect.
if [[ "$MODE_RELEASE" -eq 1 ]]; then
  log "--release is deferred (staged Phase B ships --implement + --watch first); exiting 0"
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
#
# When $3 is a non-empty JSON object, it's forwarded as the `replan` field —
# factory-bundle.mjs envelopes the prior plan body and drops it through to
# the planner so it can edit-in-place instead of posting a new comment.
build_plan_bundle() {
  local issue_entry="$1"
  local comments_json="$2"
  local replan_json="${3:-null}"
  local repo_head_ref
  repo_head_ref=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  jq -n \
    --argjson issue "$issue_entry" \
    --argjson comments "$comments_json" \
    --argjson replan "$replan_json" \
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
     }
     + (if $replan == null then {} else { replan: $replan } end)' \
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
# `authorAssociation` is required by the replan detector — only OWNER comments
# newer than the plan marker count as a revision trigger. Without it, a
# customer reply forwarded by the support agent would still be OWNER (the
# Mac mini's gh identity), so we cannot use the login alone.
fetch_issue_comments() {
  local issue_num="$1"
  gh api --paginate "repos/JakubAnderwald/drafto/issues/$issue_num/comments" 2>>"$LOG_FILE" \
    | jq '[ .[] | {
        id: .id,
        user: { login: .user.login },
        body: (.body // ""),
        createdAt: .created_at,
        authorAssociation: (.author_association // "NONE")
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

# Extract the (most recent) factory-plan comment as a JSON object with id,
# url-suffix, body, and createdAt. Prints "null" if no plan comment exists.
# Newest-first match — if the operator manually re-posted a plan, we edit the
# most recent one.
extract_plan_comment() {
  local comments_json="$1"
  echo "$comments_json" | jq -c '
    map(select(.body | test("<!-- drafto-factory-plan -->")))
    | sort_by(.createdAt)
    | .[-1] // null
  '
}

# Pull out the comment IDs that the planner has already acknowledged via
# `<!-- drafto-factory-replan-ack:<id> -->` markers inside the plan body. The
# detector skips any OWNER comment whose ID is in this set, so a successful
# replan doesn't re-trigger on the same comment next tick.
extract_acked_comment_ids() {
  local plan_body="$1"
  # Use python via node to avoid bash regex traps with large IDs / weird
  # whitespace. The IDs are numeric GitHub comment ids (int64), which jq
  # would round when crossing 2^53 — we want them as strings.
  echo "$plan_body" | node -e '
    let buf = "";
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => {
      const re = /<!--\s*drafto-factory-replan-ack:([^\s>]+)\s*-->/g;
      const ids = [];
      let m;
      while ((m = re.exec(buf)) !== null) ids.push(m[1]);
      process.stdout.write(JSON.stringify(ids));
    });
  '
}

# Compute the list of OWNER-association comment IDs that are NEWER than the
# plan comment AND not present in the acked-ids set. The result is a JSON
# array of stringified comment IDs (kept as strings to dodge int64 rounding).
# Bots and non-owner commenters are ignored — a customer reply forwarded by
# support-agent step 4.5 IS posted under the Mac mini's gh identity (OWNER),
# so the email-replan path still works without a separate check.
unacked_owner_comments() {
  local comments_json="$1"
  local plan_created_at="$2"
  local acked_json="$3"
  echo "$comments_json" | jq -c \
    --arg planAt "$plan_created_at" \
    --argjson acked "$acked_json" \
    '
      map(select(
        (.authorAssociation == "OWNER")
        and ((.createdAt) > $planAt)
        and (((.id | tostring)) as $id | ($acked | index($id)) | not)
      ))
      | map(.id | tostring)
    '
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

# ── Phase B+ helpers (implement / watch) ────────────────────────────────────

# Build the factory_implement bundle. $2 is the approved-plan comment object
# (from extract_plan_comment: {id,user,body,createdAt}) or "null"; $3 is the
# prior-PR object or "null"; $4 is the attempts counter.
build_implement_bundle() {
  local issue_entry="$1"
  local approved_plan="${2:-null}"
  local prior_pr="${3:-null}"
  local attempts="${4:-0}"
  local revision_comments="${5:-[]}"
  local repo_head_ref
  repo_head_ref=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  jq -n \
    --argjson issue "$issue_entry" \
    --argjson plan "$approved_plan" \
    --argjson priorPr "$prior_pr" \
    --arg attempts "$attempts" \
    --argjson revisionComments "$revision_comments" \
    --arg allowlist "$SUPPORT_ALLOWLIST" \
    --arg oauthUserEmail "$OAUTH_USER_EMAIL" \
    --arg phase "$PHASE" \
    --arg repoNwo "JakubAnderwald/drafto" \
    --arg headRef "$repo_head_ref" \
    '{
       kind: "factory_implement",
       issue: $issue,
       approvedPlan: (if $plan == null then null else {
         commentId: ($plan.id),
         url: ("https://github.com/JakubAnderwald/drafto/issues/" + ($issue.number|tostring) + "#issuecomment-" + ($plan.id|tostring)),
         body: ($plan.body // ""),
         createdAt: ($plan.createdAt // null)
       } end),
       priorPr: $priorPr,
       attempts: ($attempts | tonumber? // 0),
       comments: [],
       revisionComments: $revisionComments,
       config: {
         phase: $phase,
         allowlist: ($allowlist | split(",") | map(ascii_downcase | sub("^\\s+";"") | sub("\\s+$";""))),
         oauthUserEmail: $oauthUserEmail
       },
       repo: { nameWithOwner: $repoNwo, headRef: $headRef }
     }' \
    | node "$SCRIPT_DIR/lib/factory-bundle.mjs"
}

# OWNER comments strictly newer than <since-iso>, excluding the factory's own
# marker comments (so a "revising"/"in-test" comment we posted can't be read
# back as fresh feedback). Customer replies forwarded by support-agent land
# under the Mac mini's gh identity (OWNER) with no factory marker, so they're
# included. Prints a JSON array of {id,user,body,createdAt}; "[]" if since is
# empty (no baseline yet → nothing counts as feedback).
owner_comments_since() {
  local comments_json="$1"
  local since="$2"
  if [[ -z "$since" || "$since" == "null" ]]; then echo "[]"; return 0; fi
  echo "$comments_json" | jq -c --arg since "$since" \
    '[ .[] | select(
         (.authorAssociation == "OWNER")
         and ((.createdAt) > $since)
         and (((.body // "") | test("<!-- drafto-factory")) | not)
       ) ]'
}

# Is a comment body pure approval / acknowledgement noise (so it must NOT
# trigger a code revision)? Strips to lowercase alphanumerics and matches a
# small set of approving words; emoji-only / ≤2-char comments are noise too.
# Per the agreed model, approval is the Approved drag — these are skipped, not
# treated as ship signals.
is_noise_comment() {
  local norm
  norm=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')
  case "$norm" in
    ""|thanks|thankyou|ty|thx|lgtm|looksgood|looksgreat|great|greatwork|perfect|nice|cool|\
ship|shipit|approved|approve|done|ok|okay|okthanks|yes|yep|yeah|awesome|love|loveit)
      return 0 ;;
  esac
  [[ ${#norm} -le 2 ]]
}

# Build the factory_watch bundle. $2 approved-plan obj|null, $3 prior-PR obj,
# $4 CI summary text, $5 unresolved-comments JSON array, $6 attempts.
build_watch_bundle() {
  local issue_entry="$1"
  local approved_plan="${2:-null}"
  local prior_pr="${3:-null}"
  local ci_summary="${4:-}"
  local unresolved="${5:-[]}"
  local attempts="${6:-0}"
  local repo_head_ref
  repo_head_ref=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  jq -n \
    --argjson issue "$issue_entry" \
    --argjson plan "$approved_plan" \
    --argjson priorPr "$prior_pr" \
    --arg ciSummary "$ci_summary" \
    --argjson unresolved "$unresolved" \
    --arg attempts "$attempts" \
    --arg allowlist "$SUPPORT_ALLOWLIST" \
    --arg oauthUserEmail "$OAUTH_USER_EMAIL" \
    --arg phase "$PHASE" \
    --arg repoNwo "JakubAnderwald/drafto" \
    --arg headRef "$repo_head_ref" \
    '{
       kind: "factory_watch",
       issue: $issue,
       approvedPlan: (if $plan == null then null else {
         commentId: ($plan.id),
         url: ("https://github.com/JakubAnderwald/drafto/issues/" + ($issue.number|tostring) + "#issuecomment-" + ($plan.id|tostring)),
         body: ($plan.body // ""),
         createdAt: ($plan.createdAt // null)
       } end),
       priorPr: $priorPr,
       ciSummary: $ciSummary,
       unresolvedComments: $unresolved,
       comments: [],
       attempts: ($attempts | tonumber? // 0),
       config: {
         phase: $phase,
         allowlist: ($allowlist | split(",") | map(ascii_downcase | sub("^\\s+";"") | sub("\\s+$";""))),
         oauthUserEmail: $oauthUserEmail
       },
       repo: { nameWithOwner: $repoNwo, headRef: $headRef }
     }' \
    | node "$SCRIPT_DIR/lib/factory-bundle.mjs"
}

# Find the factory PR for an issue (head branch factory/issue-<n>). Prints the
# {number,url,headRef,state} object or "null". Looks at all states so a retry
# can find an existing OPEN PR (or a CLOSED one to reopen-by-push).
find_prior_pr() {
  local issue_num="$1"
  gh pr list --repo JakubAnderwald/drafto --head "factory/issue-$issue_num" \
    --state all --json number,url,headRefName,state --limit 1 2>>"$LOG_FILE" \
    | jq -c '(.[0] // null) | if . == null then null else
        { number: .number, url: .url, headRef: .headRefName, state: .state } end'
}

# Copy the gitignored env files CLAUDE.md lists into a fresh worktree. Phase B
# is web-only so the mobile/desktop envs are usually absent — copy what exists,
# never fail the run on a missing optional file.
copy_worktree_env() {
  local wt="$1"
  local f
  for f in \
    apps/web/.env.local apps/web/.env.production \
    apps/mobile/.env apps/mobile/.env.production \
    apps/desktop/.env apps/desktop/.env.production; do
    if [[ -f "$REPO_ROOT/$f" ]]; then
      mkdir -p "$wt/$(dirname "$f")"
      cp "$REPO_ROOT/$f" "$wt/$f" 2>>"$LOG_FILE" || log "WARNING: failed to copy $f into worktree"
    fi
  done
  if [[ -f "$REPO_ROOT/apps/mobile/android/local.properties" ]]; then
    mkdir -p "$wt/apps/mobile/android"
    cp "$REPO_ROOT/apps/mobile/android/local.properties" \
      "$wt/apps/mobile/android/local.properties" 2>>"$LOG_FILE" || true
  fi
}

# Seed a fresh worktree's node_modules from the main checkout via APFS clonefile
# (`cp -c`: O(1), copy-on-write, same volume). The pnpm store lives on an
# external volume on the Mac mini, so a cold `pnpm install` cross-device-copies
# ~2000 packages and ran for 3.5+ hours on #451. Cloning the main checkout's
# already-materialized trees turns the subsequent install into a fast offline
# reconcile that adds ~0 bytes. Best-effort: on any failure the partial dir is
# removed and `pnpm install` repopulates it normally. Only the pnpm workspace
# roots (repo root + apps/* + packages/*) are seeded — never the factory's own
# worktrees/ checkouts.
seed_worktree_node_modules() {
  local wt="$1" src rel
  for src in "$REPO_ROOT"/node_modules "$REPO_ROOT"/apps/*/node_modules "$REPO_ROOT"/packages/*/node_modules; do
    [[ -d "$src" ]] || continue
    rel="${src#"$REPO_ROOT"/}"
    [[ -e "$wt/$rel" ]] && continue
    mkdir -p "$wt/$(dirname "$rel")"
    if ! cp -c -R "$src" "$wt/$rel" 2>>"$LOG_FILE"; then
      log "WARNING: clonefile seed of $rel failed; pnpm install will repopulate it"
      rm -rf "$wt/$rel" 2>/dev/null || true
    fi
  done
}

# Install deps in a worktree with a wall-clock cap (run-with-timeout.mjs, exit
# 124 on cap) so a hung install can't hold the implement lock for hours (#451).
# Ladder: fast offline reconcile (node_modules already seeded) → frozen online
# (fetch only drifted tarballs, keep the lockfile) → unfrozen online as a last
# resort for genuine lockfile drift. Returns 0 on the first attempt that
# succeeds, non-zero if all fail / time out.
run_pnpm_install() {
  local wt="$1"
  ( cd "$wt" && node "$SCRIPT_DIR/lib/run-with-timeout.mjs" "$INSTALL_TIMEOUT_SEC" \
      pnpm install --frozen-lockfile --offline --prefer-offline >>"$LOG_FILE" 2>&1 ) && return 0
  log "WARNING: offline reconcile failed/timed out; retrying frozen online"
  ( cd "$wt" && node "$SCRIPT_DIR/lib/run-with-timeout.mjs" "$INSTALL_TIMEOUT_SEC" \
      pnpm install --frozen-lockfile >>"$LOG_FILE" 2>&1 ) && return 0
  log "WARNING: frozen install failed/timed out; retrying unfrozen online"
  ( cd "$wt" && node "$SCRIPT_DIR/lib/run-with-timeout.mjs" "$INSTALL_TIMEOUT_SEC" \
      pnpm install >>"$LOG_FILE" 2>&1 )
}

# Free space (whole GiB) on the volume backing the repo/worktrees. POSIX
# `df -Pk` guarantees a single data row in 1024-byte blocks; $4 is available.
free_disk_gb() {
  df -Pk "$REPO_ROOT" 2>/dev/null | awk 'NR==2 { print int($4 / 1024 / 1024) }'
}

# Pick the slot index (0|1) to use for <issue>: the slot already assigned to it
# (retry/continuation) if any, else the first free slot. Prints "" if both
# slots are taken by other issues.
slot_for_issue() {
  local issue_num="$1"
  local status_all
  status_all=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-status \
    --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo '{"slots":{}}')
  local existing
  existing=$(echo "$status_all" | jq -r --arg i "$issue_num" \
    '.slots | to_entries | map(select(.value.issueNumber == $i)) | (.[0].key // "")')
  if [[ -n "$existing" ]]; then echo "$existing"; return 0; fi
  echo "$status_all" | jq -r \
    '.slots | to_entries | map(select(.value.issueNumber == null)) | (.[0].key // "")'
}

# Parity / phase post-check on a PR's changed files. Args:
#   $1 affected-platforms CSV (e.g. "web,mobile")
#   $2 parity override ("web-only"|"mobile-only"|"desktop-only"|"")
#   $3 newline-separated changed file paths (gh pr diff --name-only)
# Prints a violation reason, or "" when the diff satisfies the mandate.
parity_violation() {
  local platforms_csv="$1"
  local override="$2"
  local diff_files="$3"
  # Phase B hard rule: web only. Any mobile/desktop file is a violation,
  # regardless of what platforms the spec claimed.
  if [[ "$PHASE" == "B" ]] && echo "$diff_files" | grep -qE '^apps/(mobile|desktop)/'; then
    echo "Phase B is web-only but the PR changes files under apps/mobile or apps/desktop"
    return 0
  fi
  # A parity:*-only override authorises a single-platform PR — skip the
  # cross-platform mandate entirely.
  if [[ -n "$override" ]]; then echo ""; return 0; fi
  local plat
  IFS=',' read -ra _plats <<< "$platforms_csv"
  for plat in "${_plats[@]}"; do
    [[ -z "$plat" ]] && continue
    case "$plat" in
      web)
        echo "$diff_files" | grep -qE '^apps/web/' \
          || { echo "claimed platform 'web' has no apps/web changes"; return 0; } ;;
      mobile)
        echo "$diff_files" | grep -qE '^apps/mobile/' \
          || { echo "claimed platform 'mobile' has no apps/mobile changes"; return 0; } ;;
      desktop)
        echo "$diff_files" | grep -qE '^apps/desktop/' \
          || { echo "claimed platform 'desktop' has no apps/desktop changes"; return 0; } ;;
    esac
  done
  echo ""
}

# ── --plan mode ─────────────────────────────────────────────────────────────
if [[ "$MODE_PLAN" -eq 1 ]]; then
  PROMPT_FILE="$SCRIPT_DIR/factory-plan-prompt.md"
  if [[ "$DRY_RUN" -eq 0 && ! -f "$PROMPT_FILE" ]]; then
    log "ERROR: prompt file missing: $PROMPT_FILE"
    exit 1
  fi

  # ── Orphaned-Planning rescue sweep ──────────────────────────────────────────
  # "Planning" is a transient, factory-owned status: both the Ready sweep and
  # the replan sweep below park a card there only for the span of a single
  # claude invocation, then move it on (→ Plan Review, or → Blocked). Every
  # --plan tick holds the per-mode lock (logs/factory-plan.lock), so no other
  # planner can be mid-flight when this tick begins — which means ANY card
  # already sitting in Planning right now is an orphan a previous tick left
  # behind after dying between "→ Planning" and its follow-up move. That
  # happens when the tick is killed mid-transition (a launchd SIGTERM during
  # the set-status write stranded #418 this way), or when a claude call times
  # out / errors and the card is left parked at Planning. Planning is in
  # neither the Ready queue nor the Plan Review queue, so nothing else would
  # ever pick these up — we rescue them here, BEFORE the Ready sweep parks any
  # fresh card in Planning, which guarantees we only ever touch real orphans.
  #
  #   • plan comment present → the plan was produced; only the Planning →
  #     Plan Review hop is missing. Re-emit it. The replan sweep later in THIS
  #     same tick then handles any operator feedback already waiting on it.
  #   • no plan comment      → the planner never posted. Send the card back to
  #     Ready so this tick's Ready sweep re-plans from scratch, bumping the
  #     attempts counter (claude timeouts don't, so this is what bounds a
  #     persistently-dying card) so it ends up Blocked rather than looping.
  if RESCUE_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items \
      --status Planning 2>>"$LOG_FILE"); then
    RESCUE_COUNT=$(echo "$RESCUE_JSON" | jq 'length' 2>/dev/null || echo "0")
    if ! [[ "$RESCUE_COUNT" =~ ^[0-9]+$ ]]; then RESCUE_COUNT=0; fi
    if [[ "$RESCUE_COUNT" -gt 0 ]]; then
      log "--plan rescue sweep: $RESCUE_COUNT orphaned Planning item(s) on the board"
    fi
    for ((IDX=0; IDX<RESCUE_COUNT; IDX++)); do
      ITEM=$(echo "$RESCUE_JSON" | jq ".[${IDX}]")
      ITEM_ID=$(echo "$ITEM" | jq -r '.itemId')
      ISSUE_NUM=$(echo "$ITEM" | jq -r '.issueNumber')
      ITEM_LABELS=$(echo "$ITEM" | jq -r '.labels // [] | join(",")')

      if [[ ",$ITEM_LABELS," == *",factory-pause,"* ]]; then
        log "Issue #$ISSUE_NUM: skipping rescue (factory-pause label set)"
        continue
      fi

      if ! COMMENTS_JSON=$(fetch_issue_comments "$ISSUE_NUM"); then
        log "WARNING: fetch_issue_comments failed for #$ISSUE_NUM (rescue sweep); skipping"
        continue
      fi

      if issue_already_planned "$COMMENTS_JSON"; then
        if [[ "$DRY_RUN" -eq 1 ]]; then
          log "DRY-RUN: would rescue orphaned #$ISSUE_NUM (plan comment present) → Plan Review"
          continue
        fi
        log "Issue #$ISSUE_NUM: orphaned in Planning with a plan comment → restoring to Plan Review"
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        continue
      fi

      if [[ "$DRY_RUN" -eq 1 ]]; then
        log "DRY-RUN: would rescue orphaned #$ISSUE_NUM (no plan comment) → Ready"
        continue
      fi
      ATTEMPTS=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" \
        --state-file "$STATE_FILE" 2>>"$LOG_FILE" | jq -r '.attempts // 0' || echo "0")
      if [[ "$ATTEMPTS" -ge 5 ]]; then
        log "Issue #$ISSUE_NUM: orphaned in Planning, no plan comment, retry budget exhausted ($ATTEMPTS) → Blocked"
        # Idempotent: post the exhaustion notice at most once. If a prior tick
        # already posted it but the → Blocked transition then failed (leaving
        # the card in Planning with attempts still ≥5), this guard stops every
        # subsequent rescue tick re-posting the same comment. Same marker-based
        # check the issue_already_* helpers use.
        if ! echo "$COMMENTS_JSON" | jq -e \
            'any(.[]; .body | test("<!-- drafto-factory-retry-exhausted -->"))' >/dev/null 2>&1; then
          gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
            --body "🏭 **Planning stalled ($ATTEMPTS attempts).**

The factory kept starting to plan this issue but never managed to post a plan — \
claude timed out or the tick was killed mid-flight each time. Investigate via \
\`logs/factory/factory-agent-plan-*.log\` on the Mac mini, then run \
\`node scripts/lib/state-cli.mjs factory:reset-attempts $ISSUE_NUM\` and drag the \
card back to **Ready**.

<!-- drafto-factory-retry-exhausted -->" >>"$LOG_FILE" 2>&1 || true
        fi
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
      else
        log "Issue #$ISSUE_NUM: orphaned in Planning with no plan comment → returning to Ready for a fresh plan"
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Ready" || true
      fi
    done
  else
    log "WARNING: query-status-items Planning failed (transient?); skipping rescue sweep this tick"
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

  # PROMPT_TEXT is needed by BOTH the Ready loop and the Plan Review replan
  # sweep below. Load it once up front so the replan sweep still runs even
  # when there are zero Ready cards (an early-exit here would skip replans
  # entirely on a board that has only Plan Review work).
  PROMPT_TEXT=""
  if [[ "$DRY_RUN" -eq 0 ]]; then PROMPT_TEXT=$(cat "$PROMPT_FILE"); fi

  for ((IDX=0; IDX<READY_COUNT; IDX++)); do
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
      # Leave card at Planning; the next tick's rescue sweep (top of --plan)
      # returns it to Ready — it has no plan comment yet — so planning restarts.
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

  # ── Plan Review sweep: in-place replan on new OWNER comments ──────────────
  # The Ready sweep handled first-time planning. Now scan Plan Review cards
  # for operator feedback. Any new comment from an OWNER (which includes
  # email replies forwarded by support-agent step 4.5 — those land via the
  # Mac mini's gh identity, also OWNER) triggers a re-invocation that edits
  # the existing plan comment in place. Acked comment IDs are stamped into
  # the plan body so a successful replan doesn't loop.
  if ! REVIEW_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items \
      --status "Plan Review" 2>>"$LOG_FILE"); then
    log "WARNING: query-status-items 'Plan Review' failed (transient?); skipping replan sweep this tick"
    log "=== factory-agent --plan completed in $(( $(date +%s) - START_TIME ))s ==="
    exit 0
  fi
  REVIEW_COUNT=$(echo "$REVIEW_JSON" | jq 'length' 2>/dev/null || echo "0")
  if ! [[ "$REVIEW_COUNT" =~ ^[0-9]+$ ]]; then
    log "ERROR: unexpected non-numeric REVIEW_COUNT='$REVIEW_COUNT'"
    exit 1
  fi
  log "--plan replan sweep: $REVIEW_COUNT Plan Review item(s) on the board"

  for ((IDX=0; IDX<REVIEW_COUNT; IDX++)); do
    ITEM=$(echo "$REVIEW_JSON" | jq ".[${IDX}]")
    ITEM_ID=$(echo "$ITEM" | jq -r '.itemId')
    ISSUE_NUM=$(echo "$ITEM" | jq -r '.issueNumber')
    ITEM_LABELS=$(echo "$ITEM" | jq -r '.labels // [] | join(",")')

    if [[ ",$ITEM_LABELS," == *",factory-pause,"* ]]; then
      continue
    fi

    if ! ISSUE_RECORD=$(fetch_issue_record "$ISSUE_NUM"); then
      log "WARNING: fetch_issue_record failed for #$ISSUE_NUM (replan sweep); skipping"
      continue
    fi
    if ! COMMENTS_JSON=$(fetch_issue_comments "$ISSUE_NUM"); then
      log "WARNING: fetch_issue_comments failed for #$ISSUE_NUM (replan sweep); skipping"
      continue
    fi

    PLAN_COMMENT_JSON=$(extract_plan_comment "$COMMENTS_JSON")
    if [[ -z "$PLAN_COMMENT_JSON" || "$PLAN_COMMENT_JSON" == "null" ]]; then
      # Card sits in Plan Review with no plan comment — likely operator-driven
      # state (e.g. moved manually without ever running --plan). Skip; the
      # Ready sweep is the right place to (re-)plan from scratch.
      continue
    fi
    PLAN_COMMENT_ID=$(echo "$PLAN_COMMENT_JSON" | jq -r '.id | tostring')
    PLAN_CREATED_AT=$(echo "$PLAN_COMMENT_JSON" | jq -r '.createdAt')
    PLAN_BODY=$(echo "$PLAN_COMMENT_JSON" | jq -r '.body')

    ACKED_JSON=$(extract_acked_comment_ids "$PLAN_BODY")
    if [[ -z "$ACKED_JSON" ]]; then ACKED_JSON='[]'; fi
    UNACKED_JSON=$(unacked_owner_comments "$COMMENTS_JSON" "$PLAN_CREATED_AT" "$ACKED_JSON")
    UNACKED_COUNT=$(echo "$UNACKED_JSON" | jq 'length' 2>/dev/null || echo "0")
    if [[ "$UNACKED_COUNT" -eq 0 ]]; then
      continue
    fi

    log "Issue #$ISSUE_NUM: $UNACKED_COUNT unacked OWNER comment(s) → replanning in place"

    REPLAN_JSON=$(jq -n \
      --arg id "$PLAN_COMMENT_ID" \
      --arg issueNum "$ISSUE_NUM" \
      --arg body "$PLAN_BODY" \
      --argjson triggers "$UNACKED_JSON" \
      '{
         planCommentId: $id,
         planCommentUrl: ("https://github.com/JakubAnderwald/drafto/issues/" + $issueNum + "#issuecomment-" + $id),
         planCommentBody: $body,
         triggerCommentIds: $triggers
       }')

    if ! BUNDLE=$(build_plan_bundle "$ISSUE_RECORD" "$COMMENTS_JSON" "$REPLAN_JSON"); then
      log "ERROR: build_plan_bundle (replan) failed for #$ISSUE_NUM"
      continue
    fi

    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "DRY-RUN: replan bundle for #$ISSUE_NUM (printed to stdout only; not logged)"
      echo "$BUNDLE"
      continue
    fi

    # Transition to Planning so an observer can see in-flight work, just like
    # the Ready path. If it fails we still try — claude can edit the comment
    # without a status hop, but the board state would be confusing without it.
    if ! transition_status "$ITEM_ID" "$ISSUE_NUM" "Planning"; then
      log "WARNING: failed to transition #$ISSUE_NUM Plan Review → Planning for replan; continuing anyway"
    fi

    CLAUDE_INPUT=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
      "$PROMPT_TEXT" "$BUNDLE")
    log "Invoking claude for #$ISSUE_NUM (--plan replan, phase=$PHASE)"
    CLAUDE_OUTPUT_FILE=$(mktemp -t factory-agent-out.XXXXXX)
    EXIT_CODE=0
    node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT" --dangerously-skip-permissions \
        >"$CLAUDE_OUTPUT_FILE" 2>>"$LOG_FILE" || EXIT_CODE=$?

    if [[ $EXIT_CODE -eq 124 ]]; then
      log "WARNING: claude timed out (>${CLAUDE_CALL_TIMEOUT_SEC}s) for #$ISSUE_NUM --plan replan — skipping; next tick retries"
      rm -f "$CLAUDE_OUTPUT_FILE"
      # Restore Plan Review status so the operator's card doesn't appear stuck
      # in Planning forever.
      transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
      continue
    elif [[ $EXIT_CODE -ne 0 ]]; then
      log "ERROR: claude exited non-zero ($EXIT_CODE) for #$ISSUE_NUM --plan replan"
      cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE" 2>/dev/null || true
      rm -f "$CLAUDE_OUTPUT_FILE"
      transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
      ATTEMPTS=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" \
        --state-file "$STATE_FILE" 2>>"$LOG_FILE" | jq -r '.attempts // 0' || echo "0")
      if [[ "$ATTEMPTS" -ge 5 ]]; then
        log "Issue #$ISSUE_NUM: replan retry budget exhausted ($ATTEMPTS attempts); advancing to Blocked"
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Replan retry budget exhausted ($ATTEMPTS attempts).**

The factory tried to revise the plan $ATTEMPTS times and each invocation \
of claude failed. Investigate via \`logs/factory/factory-agent-plan-*.log\` \
on the Mac mini, then run \`node scripts/lib/state-cli.mjs factory:reset-attempts $ISSUE_NUM\` \
and drag the card back to **Plan Review** (or **Ready** for a full restart).

<!-- drafto-factory-retry-exhausted -->" >>"$LOG_FILE" 2>&1 || true
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
      fi
      continue
    fi

    cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE"
    SUMMARY_LINE=$(grep -E '^issue=[0-9]+ action=[a-z]+ plan-comment=[^ ]+$' "$CLAUDE_OUTPUT_FILE" | tail -1 || true)
    rm -f "$CLAUDE_OUTPUT_FILE"
    if [[ -z "$SUMMARY_LINE" ]]; then
      log "WARNING: no well-formed summary line returned by claude for #$ISSUE_NUM --plan replan"
      transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" \
        --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      continue
    fi
    log "Claude summary (replan): $SUMMARY_LINE"
    ACTION=$(echo "$SUMMARY_LINE" | sed -E 's/.*action=([^ ]+).*/\1/')

    case "$ACTION" in
      replanned)
        # Claude edited the existing comment in place and appended ack markers.
        # Card returns to Plan Review for the operator to look again.
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field \
          "$ISSUE_NUM" lastReplanAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        ;;
      blocked)
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field \
          "$ISSUE_NUM" lastError "replanner returned blocked" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        ;;
      noop)
        # Claude decided no plan change was warranted (e.g. the operator's
        # comment was a thank-you). The prompt contract still required Claude
        # to PATCH the plan comment with the ack markers appended, so the
        # next tick will not re-trigger on the same comments. If Claude
        # skipped the PATCH we'd loop — surface that loudly.
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
        ;;
      planned)
        # Tolerated: a planner that posted a fresh comment instead of editing.
        # Treat like first-plan completion.
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        ;;
      *)
        log "WARNING: unrecognised replan action '$ACTION' for #$ISSUE_NUM"
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
        ;;
    esac
  done

  log "=== factory-agent --plan completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# ── --implement mode ────────────────────────────────────────────────────────
# Phase A: post a one-time stub comment per In Progress card (observation
# mode). Phase B+: the real engine — slot → worktree → Claude → PR → parity
# post-check → In Review, with the slot + worktree persisting for --watch.
if [[ "$MODE_IMPLEMENT" -eq 1 ]]; then
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
  log "--implement (phase=$PHASE): $INPROG_COUNT In Progress item(s)"
  if [[ "$INPROG_COUNT" -eq 0 ]]; then
    log "=== factory-agent --implement completed in $(( $(date +%s) - START_TIME ))s ==="
    exit 0
  fi

  # Phase B+ needs the implementer prompt + the claude / pnpm / git toolchain.
  PROMPT_TEXT=""
  if [[ "$PHASE" != "A" ]]; then
    PROMPT_FILE="$SCRIPT_DIR/factory-prompt.md"
    if [[ "$DRY_RUN" -eq 0 && ! -f "$PROMPT_FILE" ]]; then
      log "ERROR: prompt file missing: $PROMPT_FILE"; exit 1
    fi
    if [[ "$DRY_RUN" -eq 0 ]]; then
      for required in claude pnpm git; do
        if ! command -v "$required" >/dev/null 2>&1; then
          log "ERROR: --implement (Phase B+) requires '$required' on PATH"; exit 1
        fi
      done
      PROMPT_TEXT=$(cat "$PROMPT_FILE")
    fi
  fi

  for ((IDX=0; IDX<INPROG_COUNT; IDX++)); do
    ITEM=$(echo "$INPROG_JSON" | jq ".[${IDX}]")
    ITEM_ID=$(echo "$ITEM" | jq -r '.itemId')
    ISSUE_NUM=$(echo "$ITEM" | jq -r '.issueNumber')
    ITEM_LABELS=$(echo "$ITEM" | jq -r '.labels // [] | join(",")')
    if [[ ",$ITEM_LABELS," == *",factory-pause,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (factory-pause label set)"
      continue
    fi

    # ── Phase A: one-time stub comment ──
    if [[ "$PHASE" == "A" ]]; then
      if ! COMMENTS_JSON=$(fetch_issue_comments "$ISSUE_NUM"); then
        log "WARNING: fetch_issue_comments failed for #$ISSUE_NUM; skipping"
        continue
      fi
      if issue_already_impl_stubbed "$COMMENTS_JSON"; then continue; fi
      log "Issue #$ISSUE_NUM: posting Phase A implement-stub comment"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        log "DRY-RUN: would post implement-stub comment on #$ISSUE_NUM"; continue
      fi
      if ! gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Phase A: implementation skipped.**

The Drafto factory is running in observation mode (Phase A — plan-only). \
Your approved plan was recorded, but no code will be written until the \
factory is promoted to Phase B.

See \`docs/operations/factory-runbook.md\` for phase-promotion criteria.

<!-- drafto-factory-impl-phase-a -->" >>"$LOG_FILE" 2>&1; then
        log "WARNING: gh issue comment failed for #$ISSUE_NUM"; continue
      fi
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field \
        "$ISSUE_NUM" lastImplementAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      continue
    fi

    # ── Phase B+: real implementation ──
    log "Issue #$ISSUE_NUM: implementing (phase=$PHASE)"

    # Retry budget — park over-budget cards in Blocked for a human.
    ATTEMPTS=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-attempts "$ISSUE_NUM" \
      --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo "0")
    [[ "$ATTEMPTS" =~ ^[0-9]+$ ]] || ATTEMPTS=0
    if [[ "$ATTEMPTS" -ge "$FACTORY_MAX_ATTEMPTS" ]]; then
      log "Issue #$ISSUE_NUM: retry budget exhausted ($ATTEMPTS); advancing to Blocked"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Implementation retry budget exhausted ($ATTEMPTS attempts).**

Each attempt to implement the approved plan failed. Investigate via \
\`logs/factory/factory-agent-implement-*.log\` on the Mac mini, then run \
\`node scripts/lib/state-cli.mjs factory:reset-attempts $ISSUE_NUM\` and drag \
the card back to **In Progress** to retry.

<!-- drafto-factory-retry-exhausted -->" >>"$LOG_FILE" 2>&1 || true
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
      fi
      continue
    fi

    if ! ISSUE_RECORD=$(fetch_issue_record "$ISSUE_NUM"); then
      log "ERROR: fetch_issue_record failed for #$ISSUE_NUM"; continue
    fi
    if ! COMMENTS_JSON=$(fetch_issue_comments "$ISSUE_NUM"); then
      log "ERROR: fetch_issue_comments failed for #$ISSUE_NUM"; continue
    fi

    # Free-disk guard — don't start disk-heavy implementation we can't finish.
    # The clonefile seed adds ~0 bytes, but the build/test phase needs headroom;
    # on a near-full disk, park the card in Blocked with a comment rather than
    # fail mid-build (#451). Recover by reclaiming space and dragging the card
    # back to In Progress.
    FREE_GB=$(free_disk_gb)
    if [[ "$FREE_GB" =~ ^[0-9]+$ ]] && [[ "$FREE_GB" -lt "$FACTORY_MIN_FREE_DISK_GB" ]]; then
      log "Issue #$ISSUE_NUM: only ${FREE_GB}GB free (< ${FACTORY_MIN_FREE_DISK_GB}GB threshold); advancing to Blocked"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        if ! echo "$COMMENTS_JSON" | jq -e 'any(.[]?; (.body // "") | contains("drafto-factory-disk-low"))' >/dev/null 2>&1; then
          gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
            --body "🏭 **Paused — low disk on the build machine.**

Only ${FREE_GB} GB free on the factory volume (need ≥ ${FACTORY_MIN_FREE_DISK_GB} GB). \
Reclaim space on the Mac mini, then drag this card back to **In Progress** to retry.

<!-- drafto-factory-disk-low -->" >>"$LOG_FILE" 2>&1 || true
        fi
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
      fi
      continue
    fi

    # The approved plan must be present — In Progress means a human (or an
    # allowlisted reporter's email) approved it. No plan → Blocked.
    PLAN_COMMENT_JSON=$(extract_plan_comment "$COMMENTS_JSON")
    if [[ -z "$PLAN_COMMENT_JSON" || "$PLAN_COMMENT_JSON" == "null" ]]; then
      log "Issue #$ISSUE_NUM: no approved plan comment; advancing to Blocked"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **No approved plan found.**

This card is In Progress but has no factory plan comment to implement from. \
Drag it back to **Ready** so the factory can plan it first.

<!-- drafto-factory-no-plan -->" >>"$LOG_FILE" 2>&1 || true
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
      fi
      continue
    fi

    PRIOR_PR=$(find_prior_pr "$ISSUE_NUM"); [[ -n "$PRIOR_PR" ]] || PRIOR_PR="null"

    # Revision feedback: when a PR already exists, new OWNER comments since the
    # last consumed feedback are change requests from the In Test preview to
    # apply on the same branch. Fresh implementations have none — the approved
    # plan is the source of truth there.
    REVISION_COMMENTS="[]"
    IS_REVISION=0
    if [[ "$PRIOR_PR" != "null" ]]; then
      FEEDBACK_HWM=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$ISSUE_NUM" \
        --state-file "$STATE_FILE" 2>>"$LOG_FILE" | jq -r '.lastFeedbackAt // ""' 2>/dev/null || echo "")
      REVISION_COMMENTS=$(owner_comments_since "$COMMENTS_JSON" "$FEEDBACK_HWM")
      [[ -n "$REVISION_COMMENTS" ]] || REVISION_COMMENTS="[]"
      REV_COUNT=$(echo "$REVISION_COMMENTS" | jq 'length' 2>/dev/null || echo "0")
      [[ "$REV_COUNT" =~ ^[0-9]+$ ]] || REV_COUNT=0
      if [[ "$REV_COUNT" -gt 0 ]]; then
        IS_REVISION=1
        log "Issue #$ISSUE_NUM: revision run ($REV_COUNT new feedback comment(s) on the open PR)"
      fi
    fi

    # Acquire a slot (reuse the issue's own slot on a retry / revision).
    SLOT=$(slot_for_issue "$ISSUE_NUM")
    if [[ -z "$SLOT" ]]; then
      log "Issue #$ISSUE_NUM: both worktree slots busy; deferring to a later tick"
      break
    fi

    if ! BUNDLE=$(build_implement_bundle "$ISSUE_RECORD" "$PLAN_COMMENT_JSON" "$PRIOR_PR" "$ATTEMPTS" "$REVISION_COMMENTS"); then
      log "ERROR: build_implement_bundle failed for #$ISSUE_NUM"; continue
    fi
    AFFECTED=$(echo "$BUNDLE" | jq -r '.spec.affectedPlatforms // [] | join(",")')
    PARITY_OVERRIDE=$(echo "$BUNDLE" | jq -r '.parityOverride // ""')

    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "DRY-RUN: implement bundle for #$ISSUE_NUM (slot $SLOT; printed to stdout only)"
      echo "$BUNDLE"
      continue
    fi

    # Claim the slot, create the worktree, copy env, install deps.
    if ! node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-acquire "$SLOT" "$ISSUE_NUM" "$$" \
        --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1; then
      log "WARNING: slot-acquire $SLOT for #$ISSUE_NUM failed; deferring"; continue
    fi
    if ! WT_JSON=$(node "$SCRIPT_DIR/lib/worktree-cli.mjs" add --issue "$ISSUE_NUM" \
        --root "$REPO_ROOT" --base origin/main 2>>"$LOG_FILE"); then
      log "ERROR: worktree add failed for #$ISSUE_NUM; releasing slot $SLOT"
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-release "$SLOT" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      continue
    fi
    WT_PATH=$(echo "$WT_JSON" | jq -r '.path')
    copy_worktree_env "$WT_PATH"
    seed_worktree_node_modules "$WT_PATH"

    log "Issue #$ISSUE_NUM: seeding node_modules (clonefile) + reconciling deps (slot $SLOT, cap ${INSTALL_TIMEOUT_SEC}s)"
    if ! run_pnpm_install "$WT_PATH"; then
      log "ERROR: pnpm install failed/timed out for #$ISSUE_NUM; releasing slot + worktree"
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-release "$SLOT" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      node "$SCRIPT_DIR/lib/worktree-cli.mjs" remove --issue "$ISSUE_NUM" --root "$REPO_ROOT" --force >>"$LOG_FILE" 2>&1 || true
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      continue
    fi

    # Invoke claude inside the worktree with the implementer prompt + bundle.
    CLAUDE_INPUT=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
      "$PROMPT_TEXT" "$BUNDLE")
    log "Invoking claude for #$ISSUE_NUM (--implement, slot $SLOT, cap ${IMPLEMENT_TIMEOUT_SEC}s)"
    CLAUDE_OUTPUT_FILE=$(mktemp -t factory-agent-out.XXXXXX)
    EXIT_CODE=0
    ( cd "$WT_PATH" && CLAUDE_CALL_TIMEOUT_SEC="$IMPLEMENT_TIMEOUT_SEC" \
        node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT" --dangerously-skip-permissions ) \
        >"$CLAUDE_OUTPUT_FILE" 2>>"$LOG_FILE" || EXIT_CODE=$?

    if [[ $EXIT_CODE -eq 124 ]]; then
      log "WARNING: claude timed out (>${IMPLEMENT_TIMEOUT_SEC}s) for #$ISSUE_NUM; keeping slot for retry"
      rm -f "$CLAUDE_OUTPUT_FILE"
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      continue
    elif [[ $EXIT_CODE -ne 0 ]]; then
      log "ERROR: claude exited non-zero ($EXIT_CODE) for #$ISSUE_NUM --implement"
      cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE" 2>/dev/null || true
      rm -f "$CLAUDE_OUTPUT_FILE"
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      continue
    fi

    cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE"
    SUMMARY_LINE=$(grep -E '^issue=[0-9]+ action=[a-z]+ pr=[^ ]+$' "$CLAUDE_OUTPUT_FILE" | tail -1 || true)
    rm -f "$CLAUDE_OUTPUT_FILE"
    if [[ -z "$SUMMARY_LINE" ]]; then
      log "WARNING: no well-formed summary line from claude for #$ISSUE_NUM; keeping slot for retry"
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      continue
    fi
    log "Claude summary: $SUMMARY_LINE"
    ACTION=$(echo "$SUMMARY_LINE" | sed -E 's/.*action=([^ ]+).*/\1/')
    PR_URL=$(echo "$SUMMARY_LINE" | sed -E 's/.*pr=([^ ]+).*/\1/')

    NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    case "$ACTION" in
      implemented)
        PR_OBJ=$(find_prior_pr "$ISSUE_NUM")
        if [[ -z "$PR_OBJ" || "$PR_OBJ" == "null" ]]; then
          log "WARNING: #$ISSUE_NUM action=implemented but no PR on head factory/issue-$ISSUE_NUM; keeping slot for retry"
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          continue
        fi
        PR_NUM=$(echo "$PR_OBJ" | jq -r '.number')
        # Parity / phase post-check. A transient `gh pr diff` failure must not
        # masquerade as a violation, so we only enforce when we got the list.
        if DIFF_FILES=$(gh pr diff "$PR_NUM" --repo JakubAnderwald/drafto --name-only 2>>"$LOG_FILE"); then
          VIOLATION=$(parity_violation "$AFFECTED" "$PARITY_OVERRIDE" "$DIFF_FILES")
        else
          log "WARNING: gh pr diff failed for PR #$PR_NUM; skipping parity post-check this tick"
          VIOLATION=""
        fi
        if [[ -n "$VIOLATION" ]]; then
          log "Issue #$ISSUE_NUM: parity post-check failed: $VIOLATION → Blocked"
          gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
            --body "🏭 **Parity post-check failed.**

$VIOLATION

The PR is left open for inspection. Correct the platform coverage, or for \
legitimate single-platform work apply a \`parity:<platform>-only\` label and \
drag the card back to **In Progress**.

<!-- drafto-factory-parity-violation -->" >>"$LOG_FILE" 2>&1 || true
          transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-release "$SLOT" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          node "$SCRIPT_DIR/lib/worktree-cli.mjs" remove --issue "$ISSUE_NUM" --root "$REPO_ROOT" --force >>"$LOG_FILE" 2>&1 || true
          continue
        fi
        # Happy path: advance to In Review. KEEP slot + worktree for --watch.
        # Advancing lastFeedbackAt = now marks every comment up to this point as
        # consumed, so a revision we just applied can't re-trigger next tick.
        transition_status "$ITEM_ID" "$ISSUE_NUM" "In Review" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastImplementAt "$NOW_ISO" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastFeedbackAt "$NOW_ISO" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        if [[ "$IS_REVISION" -eq 1 ]]; then
          log "Issue #$ISSUE_NUM: revision pushed → In Review (PR $PR_URL; slot $SLOT retained)"
        else
          log "Issue #$ISSUE_NUM: advanced to In Review (PR $PR_URL; slot $SLOT retained for --watch)"
        fi
        ;;
      noop)
        if [[ "$IS_REVISION" -eq 1 ]]; then
          # The feedback needed no code change. The existing PR + preview are
          # still valid, so re-present in In Test instead of re-running CI.
          transition_status "$ITEM_ID" "$ISSUE_NUM" "In Test" || true
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastFeedbackAt "$NOW_ISO" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
            --body "🏭 **No code change was needed for that.**

The preview is unchanged. Drag to **Approved** to ship it, or comment a more \
specific change.

<!-- drafto-factory-revise-noop -->" >>"$LOG_FILE" 2>&1 || true
          log "Issue #$ISSUE_NUM: revision no-op; returned to In Test"
        else
          # Fresh idempotency hit: a PR already exists from a prior attempt.
          PR_OBJ=$(find_prior_pr "$ISSUE_NUM")
          if [[ -z "$PR_OBJ" || "$PR_OBJ" == "null" ]]; then
            log "WARNING: #$ISSUE_NUM action=noop but no PR found; keeping slot for retry"
            node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
            continue
          fi
          PR_URL=$(echo "$PR_OBJ" | jq -r '.url')
          transition_status "$ITEM_ID" "$ISSUE_NUM" "In Review" || true
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastFeedbackAt "$NOW_ISO" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          log "Issue #$ISSUE_NUM: noop (PR $PR_URL already open); advanced to In Review"
        fi
        ;;
      blocked)
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastError "implementer returned blocked" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-release "$SLOT" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        node "$SCRIPT_DIR/lib/worktree-cli.mjs" remove --issue "$ISSUE_NUM" --root "$REPO_ROOT" --force >>"$LOG_FILE" 2>&1 || true
        log "Issue #$ISSUE_NUM: implementer blocked; slot $SLOT released"
        ;;
      *)
        log "WARNING: unrecognised action '$ACTION' from claude for #$ISSUE_NUM; keeping slot for retry"
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        ;;
    esac
  done

  log "=== factory-agent --implement completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# ── --watch mode (Phase B+) ─────────────────────────────────────────────────
# Two responsibilities each tick:
#   1. Cleanup sweep — release slots + remove worktrees for any issue that has
#      left the In Review / In Test states (merged by the operator, Blocked,
#      Done, or closed). Without this the two slots would leak.
#   2. In Review → In Test — for each open factory PR: if CI is failing or
#      review comments are unresolved, resume the worktree and invoke Claude
#      (factory-watch-prompt) to push one fix; once CI is green AND a Vercel
#      preview is reachable, advance the card to In Test and post the URL.
# PHASE is guaranteed != "A" here (Phase A --watch no-op'd at the gate above).
if [[ "$MODE_WATCH" -eq 1 ]]; then
  WATCH_PROMPT_FILE="$SCRIPT_DIR/factory-watch-prompt.md"
  if [[ "$DRY_RUN" -eq 0 && ! -f "$WATCH_PROMPT_FILE" ]]; then
    log "ERROR: prompt file missing: $WATCH_PROMPT_FILE"; exit 1
  fi
  if [[ "$DRY_RUN" -eq 0 ]]; then
    for required in claude pnpm git; do
      if ! command -v "$required" >/dev/null 2>&1; then
        log "ERROR: --watch (Phase B+) requires '$required' on PATH"; exit 1
      fi
    done
  fi

  # ── 1. Cleanup sweep ──
  SLOTS_JSON=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-status \
    --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo '{"slots":{}}')
  for SLOT in 0 1; do
    SLOT_ISSUE=$(echo "$SLOTS_JSON" | jq -r --arg s "$SLOT" '.slots[$s].issueNumber // ""')
    [[ -z "$SLOT_ISSUE" || "$SLOT_ISSUE" == "null" ]] && continue
    ISSUE_META=$(gh issue view "$SLOT_ISSUE" --repo JakubAnderwald/drafto \
      --json state,labels 2>>"$LOG_FILE" || echo "")
    if [[ -z "$ISSUE_META" ]]; then
      log "WARNING: slot $SLOT issue #$SLOT_ISSUE: gh issue view failed; leaving slot for next tick"
      continue
    fi
    STILL_ACTIVE=$(echo "$ISSUE_META" | jq -r \
      '((.state == "OPEN") and ((.labels | map(.name)) | any(. == "status:in-progress" or . == "status:in-review" or . == "status:in-test")))')
    if [[ "$STILL_ACTIVE" != "true" ]]; then
      log "Slot $SLOT: issue #$SLOT_ISSUE left In Review/In Test; releasing slot + worktree"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-release "$SLOT" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        node "$SCRIPT_DIR/lib/worktree-cli.mjs" remove --issue "$SLOT_ISSUE" --root "$REPO_ROOT" --force --delete-branch >>"$LOG_FILE" 2>&1 || true
      fi
    fi
  done

  # ── 2. In Review → In Test ──
  if ! REVIEW_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items \
      --status "In Review" 2>>"$LOG_FILE"); then
    log "WARNING: query-status-items In Review failed (transient?); skipping --watch this tick"
    exit 0
  fi
  REVIEW_COUNT=$(echo "$REVIEW_JSON" | jq 'length' 2>/dev/null || echo "0")
  if ! [[ "$REVIEW_COUNT" =~ ^[0-9]+$ ]]; then
    log "ERROR: unexpected non-numeric REVIEW_COUNT='$REVIEW_COUNT'"; exit 1
  fi
  log "--watch (phase=$PHASE): $REVIEW_COUNT In Review item(s)"

  WATCH_PROMPT_TEXT=""
  if [[ "$DRY_RUN" -eq 0 && "$REVIEW_COUNT" -gt 0 ]]; then WATCH_PROMPT_TEXT=$(cat "$WATCH_PROMPT_FILE"); fi

  for ((IDX=0; IDX<REVIEW_COUNT; IDX++)); do
    ITEM=$(echo "$REVIEW_JSON" | jq ".[${IDX}]")
    ITEM_ID=$(echo "$ITEM" | jq -r '.itemId')
    ISSUE_NUM=$(echo "$ITEM" | jq -r '.issueNumber')
    ITEM_LABELS=$(echo "$ITEM" | jq -r '.labels // [] | join(",")')
    if [[ ",$ITEM_LABELS," == *",factory-pause,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (factory-pause label set)"; continue
    fi

    PR_OBJ=$(find_prior_pr "$ISSUE_NUM")
    if [[ -z "$PR_OBJ" || "$PR_OBJ" == "null" ]]; then
      log "Issue #$ISSUE_NUM: In Review but no factory PR found; skipping (implement may not have completed)"
      continue
    fi
    PR_NUM=$(echo "$PR_OBJ" | jq -r '.number')
    PR_URL=$(echo "$PR_OBJ" | jq -r '.url')

    # Pull CI rollup + the Vercel preview URL from the PR in one call.
    PR_VIEW=$(gh pr view "$PR_NUM" --repo JakubAnderwald/drafto \
      --json state,mergeable,statusCheckRollup,comments 2>>"$LOG_FILE" || echo "")
    if [[ -z "$PR_VIEW" ]]; then
      log "WARNING: gh pr view #$PR_NUM failed (transient?); skipping this tick"; continue
    fi

    # statusCheckRollup mixes CheckRun (.status + .conclusion) and StatusContext
    # (.state) entries, so normalise: a check's outcome is `.conclusion //
    # .state`, and "pending" is a CheckRun still QUEUED/IN_PROGRESS or a
    # StatusContext in PENDING/EXPECTED.
    FAILING=$(echo "$PR_VIEW" | jq -r '
      [ .statusCheckRollup[]? | (.conclusion // .state // "") as $c
        | select($c == "FAILURE" or $c == "TIMED_OUT" or $c == "CANCELLED"
                 or $c == "ACTION_REQUIRED" or $c == "ERROR" or $c == "STARTUP_FAILURE") ] | length')
    PENDING=$(echo "$PR_VIEW" | jq -r '
      [ .statusCheckRollup[]? | select(
          (.status // "") == "QUEUED" or (.status // "") == "IN_PROGRESS"
          or (.state // "") == "PENDING" or (.state // "") == "EXPECTED") ] | length')
    [[ "$FAILING" =~ ^[0-9]+$ ]] || FAILING=0
    [[ "$PENDING" =~ ^[0-9]+$ ]] || PENDING=0

    # Vercel preview URL: the Vercel bot posts a comment with the preview link,
    # and the deployment also surfaces as a rollup target URL. Search both.
    PREVIEW_URL=$(echo "$PR_VIEW" | jq -r '
      ([ .comments[]? | select((.author.login // "") | test("vercel"; "i")) | .body ] | last // "")
      + " " +
      ([ .statusCheckRollup[]? | select(((.context // .name // "") | test("vercel"; "i")))
         | (.targetUrl // .detailsUrl // "") ] | join(" "))' \
      | grep -oE 'https://[a-zA-Z0-9._-]*vercel\.app[^ )]*' | head -1 || true)

    if [[ "$FAILING" -gt 0 ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM has $FAILING failing check(s) → fix loop"

      # Retry budget for the fix loop.
      ATTEMPTS=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-attempts "$ISSUE_NUM" \
        --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo "0")
      [[ "$ATTEMPTS" =~ ^[0-9]+$ ]] || ATTEMPTS=0
      if [[ "$ATTEMPTS" -ge "$FACTORY_MAX_ATTEMPTS" ]]; then
        log "Issue #$ISSUE_NUM: watch retry budget exhausted ($ATTEMPTS); advancing to Blocked"
        if [[ "$DRY_RUN" -eq 0 ]]; then
          gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
            --body "🏭 **CI fix retry budget exhausted ($ATTEMPTS attempts).**

The factory could not get CI green on PR #$PR_NUM after $ATTEMPTS fix passes. \
A human should take a look. Reset with \
\`node scripts/lib/state-cli.mjs factory:reset-attempts $ISSUE_NUM\` once fixed.

<!-- drafto-factory-retry-exhausted -->" >>"$LOG_FILE" 2>&1 || true
          transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
        fi
        continue
      fi

      # Build the watch bundle: approved plan + PR + CI summary + unresolved comments.
      if ! ISSUE_RECORD=$(fetch_issue_record "$ISSUE_NUM"); then
        log "WARNING: fetch_issue_record failed for #$ISSUE_NUM; skipping"; continue
      fi
      if ! COMMENTS_JSON=$(fetch_issue_comments "$ISSUE_NUM"); then
        log "WARNING: fetch_issue_comments failed for #$ISSUE_NUM; skipping"; continue
      fi
      PLAN_COMMENT_JSON=$(extract_plan_comment "$COMMENTS_JSON")
      [[ -n "$PLAN_COMMENT_JSON" ]] || PLAN_COMMENT_JSON="null"
      CI_SUMMARY=$(echo "$PR_VIEW" | jq -r '
        [ .statusCheckRollup[]? | (.conclusion // .state // "") as $c
          | select($c == "FAILURE" or $c == "TIMED_OUT" or $c == "CANCELLED"
                   or $c == "ACTION_REQUIRED" or $c == "ERROR" or $c == "STARTUP_FAILURE")
          | ((.name // .context // "check") + " — " + $c
             + (if (.detailsUrl // .targetUrl) then " (" + (.detailsUrl // .targetUrl) + ")" else "" end)) ]
        | join("\n")')
      UNRESOLVED=$(echo "$PR_VIEW" | jq -c '
        [ .comments[]? | select((.author.login // "") | test("vercel|github-actions"; "i") | not)
          | { id: .id, user: { login: (.author.login // "") }, body: (.body // "") } ]')
      [[ -n "$UNRESOLVED" ]] || UNRESOLVED="[]"

      if ! BUNDLE=$(build_watch_bundle "$ISSUE_RECORD" "$PLAN_COMMENT_JSON" "$PR_OBJ" "$CI_SUMMARY" "$UNRESOLVED" "$ATTEMPTS"); then
        log "ERROR: build_watch_bundle failed for #$ISSUE_NUM"; continue
      fi

      if [[ "$DRY_RUN" -eq 1 ]]; then
        log "DRY-RUN: watch bundle for #$ISSUE_NUM (printed to stdout only)"
        echo "$BUNDLE"; continue
      fi

      # Resume the worktree (recreate if a prior cleanup removed it).
      SLOT=$(slot_for_issue "$ISSUE_NUM")
      if [[ -z "$SLOT" ]]; then
        log "Issue #$ISSUE_NUM: no slot free to resume the fix; deferring"; continue
      fi
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-acquire "$SLOT" "$ISSUE_NUM" "$$" \
        --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      if ! WT_JSON=$(node "$SCRIPT_DIR/lib/worktree-cli.mjs" add --issue "$ISSUE_NUM" \
          --root "$REPO_ROOT" --base origin/main 2>>"$LOG_FILE"); then
        log "ERROR: worktree resume failed for #$ISSUE_NUM"; continue
      fi
      WT_PATH=$(echo "$WT_JSON" | jq -r '.path')
      copy_worktree_env "$WT_PATH"
      seed_worktree_node_modules "$WT_PATH"
      log "Issue #$ISSUE_NUM: seeding node_modules (clonefile) + reconciling deps (--watch, slot $SLOT, cap ${INSTALL_TIMEOUT_SEC}s)"
      run_pnpm_install "$WT_PATH" || log "WARNING: install failed/timed out for #$ISSUE_NUM --watch; proceeding"

      CLAUDE_INPUT=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
        "$WATCH_PROMPT_TEXT" "$BUNDLE")
      log "Invoking claude for #$ISSUE_NUM (--watch fix, slot $SLOT, cap ${WATCH_TIMEOUT_SEC}s)"
      CLAUDE_OUTPUT_FILE=$(mktemp -t factory-agent-out.XXXXXX)
      EXIT_CODE=0
      ( cd "$WT_PATH" && CLAUDE_CALL_TIMEOUT_SEC="$WATCH_TIMEOUT_SEC" \
          node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT" --dangerously-skip-permissions ) \
          >"$CLAUDE_OUTPUT_FILE" 2>>"$LOG_FILE" || EXIT_CODE=$?

      if [[ $EXIT_CODE -ne 0 ]]; then
        [[ $EXIT_CODE -eq 124 ]] && log "WARNING: claude timed out for #$ISSUE_NUM --watch fix" \
          || log "ERROR: claude exited $EXIT_CODE for #$ISSUE_NUM --watch fix"
        cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE" 2>/dev/null || true
        rm -f "$CLAUDE_OUTPUT_FILE"
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        continue
      fi
      cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE"
      SUMMARY_LINE=$(grep -E '^issue=[0-9]+ action=[a-z]+ pr=[^ ]+$' "$CLAUDE_OUTPUT_FILE" | tail -1 || true)
      rm -f "$CLAUDE_OUTPUT_FILE"
      WACTION=$(echo "${SUMMARY_LINE:-}" | sed -E 's/.*action=([^ ]+).*/\1/')
      case "$WACTION" in
        fixed)
          log "Issue #$ISSUE_NUM: pushed a fix; leaving In Review for CI re-check next tick"
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastWatchAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          ;;
        noop)
          log "Issue #$ISSUE_NUM: watcher found nothing actionable (transient CI?); leaving In Review"
          ;;
        blocked)
          transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastError "watcher returned blocked" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          ;;
        *)
          log "WARNING: no/unknown watcher action for #$ISSUE_NUM; bumping attempts"
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          ;;
      esac
      continue
    fi

    if [[ "$PENDING" -gt 0 ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM has $PENDING check(s) still running; waiting"
      continue
    fi

    # CI green. Need a reachable Vercel preview before advancing to In Test.
    if [[ -z "$PREVIEW_URL" ]]; then
      log "Issue #$ISSUE_NUM: CI green but no Vercel preview URL yet; waiting"
      continue
    fi
    log "Issue #$ISSUE_NUM: CI green + preview $PREVIEW_URL → In Test"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "DRY-RUN: would advance #$ISSUE_NUM to In Test and post preview URL"; continue
    fi
    transition_status "$ITEM_ID" "$ISSUE_NUM" "In Test" || true
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastWatchAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
      --body "🏭 **Preview ready — In Test.**

CI is green and the Vercel preview is live: $PREVIEW_URL

Review it, then drag the card to **Approved** to merge (the operator merges \
the PR by hand in this staged Phase B rollout).

<!-- drafto-factory-in-test -->" >>"$LOG_FILE" 2>&1 || true
  done

  # ── In Test feedback sweep: a reporter comment requests a revision ──────────
  # A reporter testing the preview asks for changes by commenting. A new OWNER
  # comment (newer than the consumed-feedback high-water mark) that isn't pure
  # approval/noise rolls the card back to In Progress; the next --implement tick
  # revises on the same PR branch and it flows back to In Test. Approval stays
  # explicit (drag to Approved / email accept-signal), so a "looks good" comment
  # is treated as noise here — never a ship signal.
  if ! INTEST_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items \
      --status "In Test" 2>>"$LOG_FILE"); then
    log "WARNING: query-status-items 'In Test' failed (transient?); skipping feedback sweep this tick"
    log "=== factory-agent --watch completed in $(( $(date +%s) - START_TIME ))s ==="
    exit 0
  fi
  INTEST_COUNT=$(echo "$INTEST_JSON" | jq 'length' 2>/dev/null || echo "0")
  [[ "$INTEST_COUNT" =~ ^[0-9]+$ ]] || INTEST_COUNT=0
  log "--watch In Test feedback sweep: $INTEST_COUNT item(s)"

  for ((IDX=0; IDX<INTEST_COUNT; IDX++)); do
    ITEM=$(echo "$INTEST_JSON" | jq ".[${IDX}]")
    ITEM_ID=$(echo "$ITEM" | jq -r '.itemId')
    ISSUE_NUM=$(echo "$ITEM" | jq -r '.issueNumber')
    ITEM_LABELS=$(echo "$ITEM" | jq -r '.labels // [] | join(",")')
    [[ ",$ITEM_LABELS," == *",factory-pause,"* ]] && continue

    if ! COMMENTS_JSON=$(fetch_issue_comments "$ISSUE_NUM"); then
      log "WARNING: fetch_issue_comments failed for #$ISSUE_NUM (feedback sweep); skipping"; continue
    fi
    HWM=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$ISSUE_NUM" \
      --state-file "$STATE_FILE" 2>>"$LOG_FILE" | jq -r '.lastFeedbackAt // ""' 2>/dev/null || echo "")
    if [[ -z "$HWM" || "$HWM" == "null" ]]; then
      # No baseline yet (e.g. a card that reached In Test before this feature).
      # Establish it now so only comments posted AFTER this count as feedback.
      log "Issue #$ISSUE_NUM: establishing In Test feedback baseline"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" \
          lastFeedbackAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      fi
      continue
    fi

    NEW_COMMENTS=$(owner_comments_since "$COMMENTS_JSON" "$HWM")
    NEW_COUNT=$(echo "$NEW_COMMENTS" | jq 'length' 2>/dev/null || echo "0")
    [[ "$NEW_COUNT" =~ ^[0-9]+$ ]] || NEW_COUNT=0
    [[ "$NEW_COUNT" -eq 0 ]] && continue

    # Actionable = at least one non-noise comment among the new ones.
    ACTIONABLE=0
    for ((CIDX=0; CIDX<NEW_COUNT; CIDX++)); do
      CBODY=$(echo "$NEW_COMMENTS" | jq -r ".[${CIDX}].body")
      if ! is_noise_comment "$CBODY"; then ACTIONABLE=1; break; fi
    done
    NEWEST=$(echo "$NEW_COMMENTS" | jq -r 'sort_by(.createdAt) | .[-1].createdAt')

    if [[ "$ACTIONABLE" -eq 0 ]]; then
      # Only approval/thanks since the preview: advance the mark so we don't
      # re-scan them; leave the card in In Test for the operator to approve.
      log "Issue #$ISSUE_NUM: only non-actionable comments on In Test; advancing feedback mark"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" \
          lastFeedbackAt "$NEWEST" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      fi
      continue
    fi

    log "Issue #$ISSUE_NUM: new feedback on In Test card → returning to In Progress for revision"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "DRY-RUN: would move #$ISSUE_NUM In Test → In Progress (revision)"; continue
    fi
    # Do NOT advance lastFeedbackAt here — the next --implement tick consumes the
    # comments and advances the mark, so the feedback actually reaches the
    # implementer. Reset attempts so the revision gets a fresh budget.
    transition_status "$ITEM_ID" "$ISSUE_NUM" "In Progress" || true
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
      --body "🏭 **Revising — picking up your feedback.**

I'll update the open PR on the same branch and redeploy the preview. (To ship \
as-is instead, drag the card to **Approved**.)

<!-- drafto-factory-revising -->" >>"$LOG_FILE" 2>&1 || true
  done

  log "=== factory-agent --watch completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# All reachable modes have returned above. Anything that lands here is a bug.
log "ERROR: factory-agent reached unreachable tail (mode=$MODE_NAME phase=$PHASE)"
exit 1
