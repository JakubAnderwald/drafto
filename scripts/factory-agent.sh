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
#   --watch      In Review → (Testing →) In Test. For each open factory PR:
#                poll CI and unresolved review comments; when something is
#                failing, resume the worktree and invoke Claude
#                (factory-watch-prompt) to push a fix; when CI is green AND a
#                Vercel preview is reachable, advance the card to In Test and
#                post the test scenario. With FACTORY_VERIFY=1 the card stops
#                in Testing first (pre-In-Test verification, ADR-0053): the
#                Testing sweep works its verification lanes, then promotes it
#                to In Test with a deterministic report; with the switch off
#                that sweep only drains the column. Also runs a cleanup sweep
#                that releases slots + removes worktrees for cards that have
#                left the active states (In Progress/In Review/Testing/In Test).
#
#   --release    Approved → Released. For each card a human dragged to
#                Approved: enforce the migration gate, squash-merge the
#                green PR via the GitHub API, advance the card to Released
#                (Vercel auto-deploys main → prod for web), and release the
#                slot + worktree. Phase A: no-op. Beta-channel dispatch
#                (iOS/Android/macOS) is a Phase D concern, not built here.
#
#   --browser    The web runs in Chrome (ADR-0051), last in the loop: at most
#                one of the candidates --watch listed per tick, the Testing
#                column's verify lane first (ADR-0053), then the In Test run.
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
#
# Claude effort: the code-writing stages (--implement/--watch) run at ultracode
# (FACTORY_EFFORT — xhigh reasoning + dynamic multi-agent workflows); the read-
# only planning stages (--plan/replan) run at xhigh (FACTORY_PLAN_EFFORT). See
# the effort block below.

set -euo pipefail

# ── PATH / locale (launchd provides minimal env) ────────────────────────────
# The factory plist sets its own PATH (for the rbenv shims), replacing launchd's
# default and leaving out sbin, where macOS keeps some tools (lsof is only in
# /usr/sbin). Appended, so it can only add commands, never shadow one already on
# PATH. kill_lane_holding_log resolves lsof itself as well, so it does not
# depend on this.
export PATH="$HOME/.local/bin:$PATH:/usr/sbin:/sbin"
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
# Unattended session marker; interactive-only tools like `pnpm test:live:supabase` refuse under it.
export DRAFTO_UNATTENDED=1

# ── Claude call timeout ─────────────────────────────────────────────────────
# scripts/lib/run-claude.mjs reads CLAUDE_CALL_TIMEOUT_SEC from the env at spawn
# time; defining it here keeps the bash log lines and the wrapper's enforced cap
# in sync. --plan / replan run Claude read-only but at xhigh effort (see the
# effort block below), which thinks longer than the old 180s cap allowed — so
# raise the plan cap and make it a knob (FACTORY_PLAN_TIMEOUT_SEC). A legacy
# CLAUDE_CALL_TIMEOUT_SEC override still wins for back-compat.
export CLAUDE_CALL_TIMEOUT_SEC="${FACTORY_PLAN_TIMEOUT_SEC:-${CLAUDE_CALL_TIMEOUT_SEC:-360}}"
if ! [[ "$CLAUDE_CALL_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid plan timeout ('$CLAUDE_CALL_TIMEOUT_SEC'); defaulting to 360" >&2
  export CLAUDE_CALL_TIMEOUT_SEC=360
fi

# --implement and --watch run Claude through edits + the verification matrix
# (lint/typecheck/test) at ultracode effort (multi-agent workflows, materially
# longer than a plain run), so they carry generous caps and override the plan
# cap per-call via an inline env prefix on the node invocation (below).
IMPLEMENT_TIMEOUT_SEC="${FACTORY_IMPLEMENT_TIMEOUT_SEC:-2700}"
WATCH_TIMEOUT_SEC="${FACTORY_WATCH_TIMEOUT_SEC:-1800}"
# Validate like the plan cap: a non-numeric override would flow to
# run-claude.mjs, which then silently falls back to its own 180s default — a
# premature kill mid-implement, not an obvious error. Guard both symmetrically.
if ! [[ "$IMPLEMENT_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_IMPLEMENT_TIMEOUT_SEC='$IMPLEMENT_TIMEOUT_SEC'; defaulting to 2700" >&2
  IMPLEMENT_TIMEOUT_SEC=2700
fi
if ! [[ "$WATCH_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_WATCH_TIMEOUT_SEC='$WATCH_TIMEOUT_SEC'; defaulting to 1800" >&2
  WATCH_TIMEOUT_SEC=1800
fi

# ── Claude background-task wait ─────────────────────────────────────────────
# In `-p` (print) mode, claude waits only 600s for background tasks (workflow
# agents, background subagents) after its final turn, then kills them and
# exits 0. At ultracode effort the implementer hands most of the work to such
# workflows, so every long run ended with "Background tasks still running after
# 600s; terminating", no summary line, nothing committed and one attempt burned.
# #623 lost all four implement attempts this way on 2026-09-14. Wait without a
# ceiling instead: every call site is already bounded by its run-with-timeout
# wall cap (the *_TIMEOUT_SEC knobs above), so a stuck workflow still ends in a
# timeout rather than a hang.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="${FACTORY_BG_WAIT_CEILING_MS:-0}"
if ! [[ "$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS" =~ ^[0-9]+$ ]]; then
  echo "WARNING: invalid FACTORY_BG_WAIT_CEILING_MS='$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'; defaulting to 0" >&2
  export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
fi

# Retry budget shared by --plan / --implement / --watch. After this many failed
# Claude invocations on one issue, the card is parked in Blocked for a human.
FACTORY_MAX_ATTEMPTS="${FACTORY_MAX_ATTEMPTS:-5}"

# Automatic re-runs per PR head SHA for required checks GitHub cancelled before
# they could judge the code (no runner acquired). Spent → one comment and a hold.
# See rerun_infra_failures.
FACTORY_CI_RERUN_MAX="${FACTORY_CI_RERUN_MAX:-2}"
# No leading zeros: bash arithmetic reads "08" as invalid octal, and a failed
# -ge comparison would mean an unlimited budget.
if ! [[ "$FACTORY_CI_RERUN_MAX" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "WARNING: invalid FACTORY_CI_RERUN_MAX='$FACTORY_CI_RERUN_MAX'; defaulting to 2" >&2
  FACTORY_CI_RERUN_MAX=2
fi

# Fallback backoff (minutes) when a claude call dies on a session/usage limit
# but the reset time can't be parsed from the transcript. The factory pauses
# itself for this long, then re-checks. When the reset time IS parseable we
# pause until then instead. See check_session_limit / pause_for_session_limit.
FACTORY_LIMIT_FALLBACK_MIN="${FACTORY_LIMIT_FALLBACK_MIN:-30}"
if ! [[ "$FACTORY_LIMIT_FALLBACK_MIN" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_LIMIT_FALLBACK_MIN='$FACTORY_LIMIT_FALLBACK_MIN'; defaulting to 30" >&2
  FACTORY_LIMIT_FALLBACK_MIN=30
fi

# ── Claude effort levels ────────────────────────────────────────────────────
# Code-writing stages (--implement / --watch) run at "ultracode": xhigh
# reasoning + dynamic multi-agent workflow orchestration. Read-only planning
# (--plan / replan) runs at plain "xhigh": deeper reasoning, no workflow fan-out
# (cheaper on the shared subscription). Both are env knobs; run-claude.mjs
# forwards --effort verbatim to `claude`. If the Workflows feature is disabled
# on the account, ultracode degrades safely to xhigh (no error). Plain strings,
# never arrays — expanding an empty array under `set -u` throws "unbound
# variable" on the Mac mini's bash 3.2 (see the parity_violation note below).
# The `case` allowlist doubles as the no-word-split / no-empty guard so
# `--effort "$VAR"` is always a single safe token.
FACTORY_EFFORT="${FACTORY_EFFORT:-ultracode}"          # --implement / --watch
case "$FACTORY_EFFORT" in
  ultracode|max|xhigh|high|medium|low) : ;;
  *) echo "WARNING: invalid FACTORY_EFFORT='$FACTORY_EFFORT'; defaulting to ultracode" >&2
     FACTORY_EFFORT="ultracode" ;;
esac
FACTORY_PLAN_EFFORT="${FACTORY_PLAN_EFFORT:-xhigh}"    # --plan / replan
case "$FACTORY_PLAN_EFFORT" in
  ultracode|max|xhigh|high|medium|low) : ;;
  *) echo "WARNING: invalid FACTORY_PLAN_EFFORT='$FACTORY_PLAN_EFFORT'; defaulting to xhigh" >&2
     FACTORY_PLAN_EFFORT="xhigh" ;;
esac

# pnpm install in a fresh worktree. node_modules is seeded from the main
# checkout by clonefile first (seed_worktree_node_modules), so this is a near-
# instant offline reconcile; the cap only fires on a pathological hang (e.g. the
# store volume vanished). Bounding it stops a stuck install from holding the
# implement lock for hours and starving every other card (#451).
INSTALL_TIMEOUT_SEC="${FACTORY_INSTALL_TIMEOUT_SEC:-600}"
# Validate before use: a non-numeric override would make every run-with-timeout
# call exit on the usage path, churning attempts. (log() isn't defined this
# early in the script, so warn on stderr — it lands in the launchd log.)
if ! [[ "$INSTALL_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_INSTALL_TIMEOUT_SEC='$INSTALL_TIMEOUT_SEC'; defaulting to 600" >&2
  INSTALL_TIMEOUT_SEC=600
fi

# Minimum free disk (whole GiB) on the worktree volume before the factory will
# start implementing a card. Below this, the card is parked in Blocked with a
# comment rather than failing mid-build on a full disk (#451). The clonefile
# seed adds ~0 bytes, so this mainly protects the build/test phase.
FACTORY_MIN_FREE_DISK_GB="${FACTORY_MIN_FREE_DISK_GB:-3}"
# Validate: a non-numeric override silently disables the guard (arithmetic
# context treats garbage as 0, so nothing is ever below threshold).
if ! [[ "$FACTORY_MIN_FREE_DISK_GB" =~ ^[0-9]+$ ]]; then
  echo "WARNING: invalid FACTORY_MIN_FREE_DISK_GB='$FACTORY_MIN_FREE_DISK_GB'; defaulting to 3" >&2
  FACTORY_MIN_FREE_DISK_GB=3
fi

# Wall-clock cap for the In Test scenario writer. It is a read-only stage (read
# the diff, post one comment), so it needs far less than the code-writing modes.
FACTORY_INTEST_TIMEOUT_SEC="${FACTORY_INTEST_TIMEOUT_SEC:-600}"
if ! [[ "$FACTORY_INTEST_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_INTEST_TIMEOUT_SEC='$FACTORY_INTEST_TIMEOUT_SEC'; defaulting to 600" >&2
  FACTORY_INTEST_TIMEOUT_SEC=600
fi
INTEST_TIMEOUT_SEC="$FACTORY_INTEST_TIMEOUT_SEC"

# Wall-clock cap for the code-review stage. Also read-only, but it reads the
# whole diff and reasons about cross-platform invariants, so it gets more room
# than the scenario writer and less than the code-writing modes.
FACTORY_REVIEW_TIMEOUT_SEC="${FACTORY_REVIEW_TIMEOUT_SEC:-900}"
if ! [[ "$FACTORY_REVIEW_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_REVIEW_TIMEOUT_SEC='$FACTORY_REVIEW_TIMEOUT_SEC'; defaulting to 900" >&2
  FACTORY_REVIEW_TIMEOUT_SEC=900
fi
REVIEW_TIMEOUT_SEC="$FACTORY_REVIEW_TIMEOUT_SEC"

# ── CodeRabbit CLI gap-fill lane (ADR-0036) ────────────────────────────────
# The CodeRabbit PR bot is on the free OSS tier and often doesn't review a head
# SHA at all (rate-limited, auto-paused after 2 commits, <10-star skip). When it
# didn't, --watch runs the CodeRabbit CLI (its own free 3/hour allowance) on the
# converged PR in a detached background worktree and posts the findings as review
# threads, which the ADR-0035 fix loop answers like any other. The card holds in
# In Review while that is pending, bounded by FACTORY_CR_HOLD_MAX_MIN plus the
# run timeout, and is promoted with a "not reviewed" note if coverage never
# comes. Off by default; decisions live in scripts/lib/coderabbit-cli.mjs, which
# reads these knobs from the environment (FACTORY_CR_CLI_BIN is passed through
# as-is). See docs/adr/0036-factory-coderabbit-cli-gap-fill.md.
FACTORY_CR_CLI="${FACTORY_CR_CLI:-0}"
if [[ "$FACTORY_CR_CLI" != "0" && "$FACTORY_CR_CLI" != "1" ]]; then
  echo "WARNING: invalid FACTORY_CR_CLI='$FACTORY_CR_CLI'; defaulting to 0" >&2
  FACTORY_CR_CLI=0
fi
FACTORY_CR_CLI_MAX_PER_HOUR="${FACTORY_CR_CLI_MAX_PER_HOUR:-3}"
FACTORY_CR_CLI_MAX_RUNS_PER_CARD="${FACTORY_CR_CLI_MAX_RUNS_PER_CARD:-2}"
FACTORY_CR_CLI_TIMEOUT_MIN="${FACTORY_CR_CLI_TIMEOUT_MIN:-45}"
FACTORY_CR_BOT_GRACE_MIN="${FACTORY_CR_BOT_GRACE_MIN:-15}"
FACTORY_CR_HOLD_MAX_MIN="${FACTORY_CR_HOLD_MAX_MIN:-60}"
# Validate before exporting, like the timeouts above: a garbage value would reach
# coderabbit-cli.mjs as NaN, every comparison against NaN is false, and the
# budget / hold caps would silently never fire.
for _cr_knob in FACTORY_CR_CLI_MAX_PER_HOUR:3 FACTORY_CR_CLI_MAX_RUNS_PER_CARD:2 \
    FACTORY_CR_CLI_TIMEOUT_MIN:45 FACTORY_CR_BOT_GRACE_MIN:15 FACTORY_CR_HOLD_MAX_MIN:60; do
  _cr_name="${_cr_knob%%:*}"
  _cr_default="${_cr_knob##*:}"
  if ! [[ "${!_cr_name}" =~ ^[1-9][0-9]*$ ]]; then
    echo "WARNING: invalid $_cr_name='${!_cr_name}'; defaulting to $_cr_default" >&2
    printf -v "$_cr_name" '%s' "$_cr_default"
  fi
done
unset _cr_knob _cr_name _cr_default
export FACTORY_CR_CLI FACTORY_CR_CLI_MAX_PER_HOUR FACTORY_CR_CLI_MAX_RUNS_PER_CARD \
  FACTORY_CR_CLI_TIMEOUT_MIN FACTORY_CR_BOT_GRACE_MIN FACTORY_CR_HOLD_MAX_MIN

# ── Pre-merge beta dispatch (In Test) ──────────────────────────────────────
# Off by default. Deliberately separate from the Phase-D post-merge lane: a card
# in In Test needs a testable native build BEFORE the merge gate, but enabling
# that must not also switch on post-merge auto-dispatch (a much bigger blast
# radius). Desktop carries its own knob because it builds from a clonefile
# replica of the fossil, which needs one manual TestFlight build that opens a
# note before it can be trusted — a green compile proves nothing there.
# See ADR-0030 and docs/operations/factory-runbook.md.
FACTORY_INTEST_BETA="${FACTORY_INTEST_BETA:-0}"
FACTORY_INTEST_BETA_DESKTOP="${FACTORY_INTEST_BETA_DESKTOP:-0}"

# ── Browser runner (Claude in Chrome, ADR-0051) ────────────────────────────
# On by default; FACTORY_BROWSER=0 in the plist turns it off. ONE kind of claude
# call gets Chrome: run_browser_task, a locked-down session (dontAsk, no built-in
# tools, a guard hook pinning the Mac mini's browser and the run's exact target
# host). Every other call passes --no-chrome, because the code-writing stages
# have Bash and file access and the browser is the operator's own signed-in
# profile. FACTORY_BROWSER_KINDS picks which uses are live: `intest` (the In
# Test web run, which posts its own report) and `verify` (the Testing column's
# browser lane, ADR-0053: its report goes into the verification report). Both
# are on by default; `verify` is inert while FACTORY_VERIFY=0, since only the
# Testing sweep queues it. Only an unset switch gets the default (`-`, not
# `:-`): an empty one is invalid and turns the runner off, like any other value.
FACTORY_BROWSER="${FACTORY_BROWSER-1}"
if [[ "$FACTORY_BROWSER" != "0" && "$FACTORY_BROWSER" != "1" ]]; then
  echo "WARNING: invalid FACTORY_BROWSER='$FACTORY_BROWSER'; turning the browser runner off" >&2
  FACTORY_BROWSER=0
fi
# Comma list. Unknown words are dropped (with a warning) rather than failing the
# tick, and the result is re-joined with commas so the membership test in
# browser_kind_enabled can match ",word," exactly.
FACTORY_BROWSER_KINDS="${FACTORY_BROWSER_KINDS:-intest,verify}"
_bk_out=""
_bk_rest="$FACTORY_BROWSER_KINDS,"
while [[ -n "$_bk_rest" ]]; do
  _bk_word="${_bk_rest%%,*}"
  _bk_rest="${_bk_rest#*,}"
  _bk_word="${_bk_word// /}"
  [[ -n "$_bk_word" ]] || continue
  case "$_bk_word" in
    intest|verify) [[ ",$_bk_out," == *",$_bk_word,"* ]] || _bk_out="${_bk_out:+$_bk_out,}$_bk_word" ;;
    *) echo "WARNING: unknown FACTORY_BROWSER_KINDS entry '$_bk_word'; ignoring it" >&2 ;;
  esac
done
FACTORY_BROWSER_KINDS="$_bk_out"
unset _bk_out _bk_rest _bk_word
# The only browser the runner may select (this Mac mini's Chrome, never the
# MacBook's). The guard hook enforces it; this is just where the id comes from.
FACTORY_BROWSER_DEVICE_ID="${FACTORY_BROWSER_DEVICE_ID:-9796912b-8977-4d74-9c08-d9bb283b9496}"
if ! [[ "$FACTORY_BROWSER_DEVICE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "WARNING: invalid FACTORY_BROWSER_DEVICE_ID='$FACTORY_BROWSER_DEVICE_ID'; turning the browser runner off" >&2
  FACTORY_BROWSER=0
fi
FACTORY_BROWSER_TIMEOUT_SEC="${FACTORY_BROWSER_TIMEOUT_SEC:-900}"
if ! [[ "$FACTORY_BROWSER_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_BROWSER_TIMEOUT_SEC='$FACTORY_BROWSER_TIMEOUT_SEC'; defaulting to 900" >&2
  FACTORY_BROWSER_TIMEOUT_SEC=900
fi
# Seconds the browser runner holds the preview sign-in lease
# (scripts/lib/browser-signin.mjs). Supabase keeps one live magic-link token
# per user, so a newer mint kills an older link that hasn't been opened yet.
# The runner and the verification shell lane sign in as the same test account,
# so each takes the lease ($SIGNIN_LEASE_FILE) before it mints. The runner
# opens its link early in its session, so a few minutes covers it; the lease is
# released when the run ends, and expires on its own if it isn't.
FACTORY_SIGNIN_LEASE_SEC="${FACTORY_SIGNIN_LEASE_SEC:-300}"
if ! [[ "$FACTORY_SIGNIN_LEASE_SEC" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_SIGNIN_LEASE_SEC='$FACTORY_SIGNIN_LEASE_SEC'; defaulting to 300" >&2
  FACTORY_SIGNIN_LEASE_SEC=300
fi
# Credentials of the dedicated dev-Supabase account the runner signs in as.
# Never the CI E2E user and never a prod account. Read by node (the bundle
# builder and the report scanner), never sourced into this shell.
FACTORY_BROWSER_ACCOUNT_FILE="${FACTORY_BROWSER_ACCOUNT_FILE:-$HOME/drafto-secrets/browser-account.env}"
# The dev Supabase service-role key the runner's one-time preview sign-in link
# is minted with (scripts/lib/browser-signin.mjs). Claude in Chrome won't type
# a password on a preview, so the runner opens that link instead. Dev only:
# minting refuses any other project. Never reaches the runner.
FACTORY_BROWSER_SIGNIN_KEY_FILE="${FACTORY_BROWSER_SIGNIN_KEY_FILE:-$HOME/drafto-secrets/dev-supabase-admin.env}"
# A launchd plist doesn't expand `~`, so an operator's `~/drafto-secrets/…`
# would reach node as a literal path and every run would fail its preflight.
case "$FACTORY_BROWSER_ACCOUNT_FILE" in "~/"*) FACTORY_BROWSER_ACCOUNT_FILE="$HOME/${FACTORY_BROWSER_ACCOUNT_FILE#\~/}" ;; esac
case "$FACTORY_BROWSER_SIGNIN_KEY_FILE" in "~/"*) FACTORY_BROWSER_SIGNIN_KEY_FILE="$HOME/${FACTORY_BROWSER_SIGNIN_KEY_FILE#\~/}" ;; esac
# Most runner attempts per head SHA before the card waits for a new commit.
FACTORY_BROWSER_MAX_ATTEMPTS=2
# The preview-only route the runner's one-time sign-in link opens (ADR-0051). A
# branch cut before it landed doesn't have it: its preview sends the link to
# /login, so a browser run there can only end as signin-failed.
FACTORY_SIGNIN_ROUTE_PATH="apps/web/src/app/auth/test-sign-in/route.ts"

# ── Pre-In-Test verification, the "Testing" column (ADR-0053) ─────────────
# Off by default. With FACTORY_VERIFY=1 a converged In Review card moves to
# Testing instead of In Test: the scenario is written and the betas dispatched
# there, the verification lanes run (the shell lane, scripts/lib/verify-lane.mjs,
# and the browser runner's `verify` kind, run by --browser), and the card moves
# on to In Test with one deterministic report comment.
# Verification is evidence, never a gate: the hold cap bounds the stay, and a
# FAIL verdict changes nothing but the report. With the switch off the Testing
# sweep only drains: any card found there is promoted at once, so switching off
# is a rollback, not a strand. Validated like the CodeRabbit knobs: a bad value
# warns and falls back to its default.
FACTORY_VERIFY="${FACTORY_VERIFY:-0}"
if [[ "$FACTORY_VERIFY" != "0" && "$FACTORY_VERIFY" != "1" ]]; then
  echo "WARNING: invalid FACTORY_VERIFY='$FACTORY_VERIFY'; defaulting to 0" >&2
  FACTORY_VERIFY=0
fi
# Which lanes run, as a comma list of shell|browser. Unknown words are dropped
# with a warning; the list is re-joined with commas so verify_lane_enabled can
# match ",word," exactly. Only an unset list gets the default (`-`, not `:-`):
# set it empty to run no lanes at all (the scenario and betas still move to
# Testing, and the card promotes on the next sweep).
FACTORY_VERIFY_LANES="${FACTORY_VERIFY_LANES-shell,browser}"
_vl_out=""
_vl_rest="$FACTORY_VERIFY_LANES,"
while [[ -n "$_vl_rest" ]]; do
  _vl_word="${_vl_rest%%,*}"
  _vl_rest="${_vl_rest#*,}"
  _vl_word="${_vl_word// /}"
  [[ -n "$_vl_word" ]] || continue
  case "$_vl_word" in
    shell|browser) [[ ",$_vl_out," == *",$_vl_word,"* ]] || _vl_out="${_vl_out:+$_vl_out,}$_vl_word" ;;
    *) echo "WARNING: unknown FACTORY_VERIFY_LANES entry '$_vl_word'; ignoring it" >&2 ;;
  esac
done
FACTORY_VERIFY_LANES="$_vl_out"
unset _vl_out _vl_rest _vl_word
# Canary: when set, only issues carrying this label enter Testing. A label the
# membership test can't match exactly (a comma, a newline, leading or trailing
# blanks) turns verification OFF rather than falling back to "every issue": a
# typo in a canary must narrow the blast radius, never widen it.
FACTORY_VERIFY_ONLY_LABEL="${FACTORY_VERIFY_ONLY_LABEL:-}"
_vl_re='^[^[:space:][:cntrl:],]([^,[:cntrl:]]*[^[:space:][:cntrl:],])?$'
if [[ -n "$FACTORY_VERIFY_ONLY_LABEL" ]] && ! [[ "$FACTORY_VERIFY_ONLY_LABEL" =~ $_vl_re ]]; then
  echo "WARNING: invalid FACTORY_VERIFY_ONLY_LABEL='$FACTORY_VERIFY_ONLY_LABEL'; turning verification off" >&2
  FACTORY_VERIFY=0
fi
unset _vl_re
# Minutes a card may spend in Testing before it is promoted whatever its lanes
# are doing; per-run cap and per-commit attempts for the shell lane (Wave 5A);
# hand-backs to In Review per commit for open review threads (0 = never bounce
# on threads); minutes the lanes wait for a per-commit Vercel preview (5A/5B).
FACTORY_VERIFY_HOLD_MAX_MIN="${FACTORY_VERIFY_HOLD_MAX_MIN:-60}"
FACTORY_VERIFY_SHELL_TIMEOUT_MIN="${FACTORY_VERIFY_SHELL_TIMEOUT_MIN:-30}"
FACTORY_VERIFY_MAX_ATTEMPTS="${FACTORY_VERIFY_MAX_ATTEMPTS:-2}"
FACTORY_VERIFY_BOUNCE_MAX="${FACTORY_VERIFY_BOUNCE_MAX:-2}"
FACTORY_VERIFY_PREVIEW_WAIT_MIN="${FACTORY_VERIFY_PREVIEW_WAIT_MIN:-10}"
# No leading zeros (bash arithmetic reads "08" as invalid octal); a garbage cap
# would reach verify-decide.mjs as NaN and count as already expired.
for _vk in FACTORY_VERIFY_HOLD_MAX_MIN:60 FACTORY_VERIFY_SHELL_TIMEOUT_MIN:30 \
    FACTORY_VERIFY_MAX_ATTEMPTS:2 FACTORY_VERIFY_PREVIEW_WAIT_MIN:10; do
  _vk_name="${_vk%%:*}"
  _vk_default="${_vk##*:}"
  if ! [[ "${!_vk_name}" =~ ^[1-9][0-9]*$ ]]; then
    echo "WARNING: invalid $_vk_name='${!_vk_name}'; defaulting to $_vk_default" >&2
    printf -v "$_vk_name" '%s' "$_vk_default"
  fi
done
unset _vk _vk_name _vk_default
if ! [[ "$FACTORY_VERIFY_BOUNCE_MAX" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "WARNING: invalid FACTORY_VERIFY_BOUNCE_MAX='$FACTORY_VERIFY_BOUNCE_MAX'; defaulting to 2" >&2
  FACTORY_VERIFY_BOUNCE_MAX=2
fi
# The Vercel "Protection Bypass for Automation" secret, as
# VERCEL_AUTOMATION_BYPASS_SECRET=… in a mode-600 file. Only the shell lane's
# curl wrapper reads it (5A), and only against per-commit previews; the report
# scans lane output for it. Read by node, never sourced into this shell. Never
# created by `vercel curl`, which mints one silently (runbook).
FACTORY_VERIFY_BYPASS_FILE="${FACTORY_VERIFY_BYPASS_FILE:-$HOME/drafto-secrets/vercel-bypass.env}"
case "$FACTORY_VERIFY_BYPASS_FILE" in "~/"*) FACTORY_VERIFY_BYPASS_FILE="$HOME/${FACTORY_VERIFY_BYPASS_FILE#\~/}" ;; esac
# Exported for the lane modules (verify-lane.mjs reads the switch as its kill
# switch, like coderabbit-cli.mjs reads FACTORY_CR_CLI).
export FACTORY_VERIFY FACTORY_VERIFY_LANES FACTORY_VERIFY_ONLY_LABEL FACTORY_VERIFY_HOLD_MAX_MIN \
  FACTORY_VERIFY_SHELL_TIMEOUT_MIN FACTORY_VERIFY_MAX_ATTEMPTS FACTORY_VERIFY_BOUNCE_MAX \
  FACTORY_VERIFY_PREVIEW_WAIT_MIN FACTORY_VERIFY_BYPASS_FILE
# Failed attempts to post one commit's verification report: the promotion's own
# plus three In Test sweep retries, spaced VERIFY_REPORT_RETRY_STEP_MIN apart
# (10, 20 and 30 minutes after the report was composed), so a GitHub outage of
# half an hour doesn't lose it. After that the body stays on disk for the
# operator.
VERIFY_REPORT_POST_MAX=4
VERIFY_REPORT_RETRY_STEP_MIN=10

# Where the fossil lives (React 19.1.x, never reinstalled) and the dedicated,
# persistent build roots the beta lanes run in — DESKTOP_FOSSIL_ROOT,
# BETA_MOBILE_ROOT and BETA_DESKTOP_ROOT — are defined in
# scripts/lib/beta-build-root.sh, sourced just after the EXIT trap below. That
# lib is shared with nightly-support.sh, which ships merged support fixes into
# the SAME roots (ADR-0042), so the defaults and the root lock live in one place.
# The build roots are DEDICATED and disposable: they are hard-reset to the commit
# being built and must never be the fossil itself or this checkout.

# ── Args ────────────────────────────────────────────────────────────────────
MODE_PLAN=0
MODE_IMPLEMENT=0
MODE_RELEASE=0
MODE_WATCH=0
MODE_BROWSER=0
PHASE="A"
DRY_RUN=0
usage() {
  cat <<EOF
Usage: $0 (--plan | --implement | --release | --watch | --browser) [--phase <A|B|C|D>] [--dry-run]

Exactly one of --plan, --implement, --release, --watch, --browser is required.

  --plan       Ready → Plan Review (or Blocked). Real work in every phase.
  --implement  In Progress → In Review. Phase A: stub comment only.
               Phase B+: worktree + Claude + PR + parity post-check.
  --watch      In Review → In Test. Phase B+: CI/preview poll + fix loop.
               FACTORY_VERIFY=1: via the Testing column (ADR-0053).
  --release    Approved → Released. Phase B+: migration gate + squash-merge.
  --browser    Web runs in Chrome (ADR-0051). Phase B+, FACTORY_BROWSER=1.
               Runs one of the candidates --watch found, after --release:
               Testing's verify lane first (ADR-0053), then In Test's run.
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
    --browser) MODE_BROWSER=1; shift ;;
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

MODE_COUNT=$((MODE_PLAN + MODE_IMPLEMENT + MODE_RELEASE + MODE_WATCH + MODE_BROWSER))
if [[ "$MODE_COUNT" -eq 0 ]]; then
  echo "ERROR: must specify exactly one of --plan, --implement, --release, --watch, --browser." >&2
  usage >&2
  exit 2
fi
if [[ "$MODE_COUNT" -gt 1 ]]; then
  echo "ERROR: --plan / --implement / --release / --watch / --browser are mutually exclusive." >&2
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
elif [[ "$MODE_BROWSER" -eq 1 ]]; then MODE_NAME="browser"
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
# The In Test scenario writer's prompt. Defined here (not only inside --watch) so
# intest_handoff can reference it without tripping `set -u`. A missing file
# degrades to the deterministic fallback comment rather than failing the mode —
# the CI fix loop must keep running even if this stage's prompt is absent.
INTEST_PROMPT_FILE="$SCRIPT_DIR/factory-intest-prompt.md"
REVIEW_PROMPT_FILE="$SCRIPT_DIR/factory-review-prompt.md"
BROWSER_PROMPT_FILE="$SCRIPT_DIR/factory-browser-prompt.md"
VERIFY_PROMPT_FILE="$SCRIPT_DIR/factory-verify-prompt.md"
umask 077
LOG_DIR="$REPO_ROOT/logs/factory"
mkdir -p "$LOG_DIR"
# The preview sign-in lease, shared by browser_run's mint and the verification
# shell lane's (passed to verify-lane.mjs start). See FACTORY_SIGNIN_LEASE_SEC.
SIGNIN_LEASE_FILE="$LOG_DIR/factory-signin.lease"
# The owner browser_run took the lease as, while it holds it (cleanup() gives
# it back if this process exits mid-run).
BROWSER_SIGNIN_LEASE_OWNER=""
LOG_FILE="$LOG_DIR/factory-agent-$MODE_NAME-$(date +%Y-%m-%d).log"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
find "$LOG_DIR" -type f -name 'factory-agent-*.log' -mtime +30 -delete 2>/dev/null || true
# Beta-lane artefacts are scoped per dispatch (beta-lane-<lane>-<issue>-<sha12>.log
# and its .exit), so a new pair appears for every commit of every card and they
# would otherwise accumulate without bound. Rotated on the same 30-day window —
# well beyond FACTORY_LANE_STALE_MIN, so a live lane's files are never reaped.
# Reap the bulky logs at 30 days but keep the tiny .exit markers for 90: the
# outcome check reads "no .exit" as "still building / died", so deleting one out
# from under a lane still listed in intestBetaLanes would retroactively turn a
# succeeded build into a failure and rebuild it.
find "$LOG_DIR" -type f -name 'beta-lane-*.log' -mtime +30 -delete 2>/dev/null || true
find "$LOG_DIR" -type f -name 'beta-lane-*.log.exit' -mtime +90 -delete 2>/dev/null || true
# CodeRabbit CLI run dirs (events, stderr, exit.json — one per background review,
# ADR-0036). Deliberately NOT rotated here: coderabbit-cli.mjs housekeeping reaps
# them on its own 30-day window every --watch tick, and it is the one place that
# knows which dir still belongs to the in-flight run. A second sweep here would
# be a second retention rule to keep in step with that one.
CR_CLI_RUN_ROOT="$LOG_DIR/cr-cli"
# Browser-runner run dirs (runner output, the guard's state, screenshots) and the
# guard's per-session decision logs (ADR-0051), on the same 30-day window.
find "$LOG_DIR/browser" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true
find "$LOG_DIR/browser-guard" -type f -name '*.jsonl' -mtime +30 -delete 2>/dev/null || true
# Verification reports and the scenario copies they were composed from (ADR-0053),
# same window. Only the report-* files at the top of logs/factory/verify: the
# shell lane's run dirs below it are reaped by its own housekeeping.
find "$LOG_DIR/verify" -maxdepth 1 -type f -name 'report-*' -mtime +30 -delete 2>/dev/null || true
# (Build-root locks live at "<root>.lock" beside the root itself, not in
# $LOG_DIR, and are reaped by the pid check in ensure_beta_build_root.)

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
# Browser-run candidates: written by --watch, read by --browser, which the loop
# runs after --release so a browser session never delays a merge. One
# "<kind>:<issue>:<pr>:<sha40>" line each: `verify` lines from the Testing
# sweep (the browser lane, ADR-0053) first, then `intest` lines from the In
# Test sweep (ADR-0051). --browser still reads a bare "<issue>:<pr>:<sha40>"
# line, the format before ADR-0053, as intest.
BROWSER_CANDIDATES_FILE="$REPO_ROOT/logs/factory-browser-candidates"
# The Testing sweep's verify candidates for this tick (verify_browser_work).
# Their own variable, because the In Test sweep, which runs after the Testing
# sweep, starts BROWSER_CANDIDATES afresh; browser_write_candidates merges the
# two, verify first.
VERIFY_BROWSER_CANDIDATES=""

cd "$REPO_ROOT"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
# log() writes to stdout, so a function whose stdout is CAPTURED by the caller
# (command substitution) must use this instead — otherwise its log lines end up
# inside the captured value and corrupt it (e.g. a JSON payload).
# For functions whose STDOUT is captured by the caller: write straight to
# $LOG_FILE and nowhere else.
#
# Not log() — that tees to stdout, so its output landed inside the captured
# value (a JSON payload, a path) and corrupted it. Not stderr either: call sites
# vary in whether they redirect stderr into $LOG_FILE, so anything written there
# is double-logged at some and lost entirely at others (--release's
# ensure_beta_build_root had no redirect at all). One destination, always.
logerr() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG_FILE" 2>/dev/null || true; }

# worktree_cli_error <stderr-file> — append worktree-cli's captured stderr to
# the log, delete the file, and echo the first line of its {"error": …} message
# so the timestamped ERROR line names the real cause (e.g. git refusing to run
# on an unaccepted Xcode license) instead of a bare "worktree add failed".
worktree_cli_error() {
  local f="$1" msg
  cat "$f" >>"$LOG_FILE" 2>/dev/null || true
  msg=$(tail -n 1 "$f" 2>/dev/null | jq -r '.error // empty' 2>/dev/null | head -n 1 | cut -c1-300)
  rm -f "$f"
  echo "${msg:-no detail}"
}

# ── Failure notification (mirrors support-agent.sh) ─────────────────────────
cleanup() {
  local exit_code=$?
  rm -f "$LOCK_FILE"
  # A --browser run killed between its mint and the runner's end: give the
  # sign-in lease back now rather than leave the shell lane waiting it out.
  # Owner-checked, inline (no function call: this runs on any early exit too),
  # and never able to change the exit code.
  if [[ -n "${BROWSER_SIGNIN_LEASE_OWNER:-}" ]]; then
    node "$SCRIPT_DIR/lib/browser-signin.mjs" release --lease-file "$SIGNIN_LEASE_FILE" \
      --owner "$BROWSER_SIGNIN_LEASE_OWNER" >>"$LOG_FILE" 2>&1 || true
  fi
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

# Beta build roots: copy_worktree_env, seed_worktree_node_modules,
# run_pnpm_install, ensure_beta_build_root, claim_beta_build_root,
# release_beta_build_root and the root paths. Its caller contract (REPO_ROOT,
# SCRIPT_DIR, LOG_FILE, INSTALL_TIMEOUT_SEC, log, logerr) is satisfied above.
# Sourced after the trap so a missing lib still files a factory-failure issue.
# shellcheck source=lib/beta-build-root.sh
source "$SCRIPT_DIR/lib/beta-build-root.sh"

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
if [[ "$MODE_BROWSER" -eq 1 && "$DRY_RUN" -eq 0 && "$FACTORY_BROWSER" == "1" ]] && ! command -v claude >/dev/null 2>&1; then
  log "ERROR: --browser requires the claude CLI on PATH"
  exit 1
fi

# ── Pause check ─────────────────────────────────────────────────────────────
# `state-cli factory:paused?` exits 0 when paused; flip the bash sense so the
# guard reads naturally. Exit 0 silently (NOT non-zero) so the failure trap
# doesn't file a bogus issue — pause is an explicit operator action, not a
# fault.
if node "$SCRIPT_DIR/lib/state-cli.mjs" factory:paused? --state-file "$STATE_FILE" 2>/dev/null; then
  PAUSE_JSON=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:status --state-file "$STATE_FILE" 2>/dev/null || echo "{}")
  REASON=$(echo "$PAUSE_JSON" | jq -r '.pausedReason // empty' 2>/dev/null || echo "")
  UNTIL=$(echo "$PAUSE_JSON" | jq -r '.pausedUntil // empty' 2>/dev/null || echo "")
  log "Factory is paused${REASON:+ (reason: $REASON)}${UNTIL:+ (until: $UNTIL)}; exiting."
  exit 0
fi

# ── Phase / mode gates ──────────────────────────────────────────────────────
# Phase A: --release and --watch are no-ops (plan-only observation phase).
# --implement falls through to its Phase A stub body below.
if [[ "$PHASE" == "A" && ( "$MODE_RELEASE" -eq 1 || "$MODE_WATCH" -eq 1 || "$MODE_BROWSER" -eq 1 ) ]]; then
  log "Phase A: --$MODE_NAME is a no-op (gated until Phase B)"
  log "=== factory-agent --$MODE_NAME completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi
# --release runs at Phase B+ (the real engine lives further down). At Phase A it
# already no-op'd at the gate above. The factory's merge autonomy stays bounded
# by the human Approved drag (ADR-0026): --release only ever acts on cards a
# human (or an allowlisted reporter) has already moved to Approved.

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
    Testing)       echo "status:testing" ;;
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
ALL_STATUS_LABELS="status:ready,status:planning,status:plan-review,status:in-progress,status:in-review,status:testing,status:in-test,status:approved,status:released,status:done,status:blocked"

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
  # Remove only the status:* labels the issue actually carries. gh resolves
  # every --remove-label name to a REPO label id first and fails the whole
  # removal on a name the repo doesn't have ("'status:testing' not found"),
  # so stripping all of ALL_STATUS_LABELS blindly would break every swap
  # whenever this list gets ahead of scripts/setup-factory-labels.sh — and a
  # stale status:in-* label keeps the --watch cleanup sweep holding a slot.
  # If the issue's labels can't be read, fall back to the full list.
  local remove_args=() current_labels="" have_current=0 lbl
  if current_labels=$(gh issue view "$issue_num" --repo JakubAnderwald/drafto \
      --json labels --jq '.labels[].name' 2>>"$LOG_FILE"); then
    have_current=1
  fi
  IFS=',' read -ra _all_status <<< "$ALL_STATUS_LABELS"
  for lbl in "${_all_status[@]}"; do
    [[ "$lbl" == "$new_label" ]] && continue
    if [[ "$have_current" -eq 1 ]] && ! grep -qxF -- "$lbl" <<<"$current_labels"; then
      continue
    fi
    remove_args+=(--remove-label "$lbl")
  done
  # ${arr[@]+...}: an empty array under `set -u` is an unbound-variable error
  # in bash 3.2 (/bin/bash on macOS, which launchd runs).
  if ! gh issue edit "$issue_num" --repo JakubAnderwald/drafto \
      --add-label "$new_label" ${remove_args[@]+"${remove_args[@]}"} >>"$LOG_FILE" 2>&1; then
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
  # Affected platforms requires at least one checkbox — UNLESS this is an
  # infra-only change (factory internals under scripts/, docs, CI) that touches
  # no app platform. infra-only is signalled by a ticked "None" box
  # (spec.infraOnly) OR the parity:infra-only label (both surface as
  # parityOverride="infra-only"). None / infra-only is mutually exclusive with
  # the platform boxes AND with a single-platform parity:<x>-only label.
  local parity_override="${2:-}"
  local platforms_count infra_box
  platforms_count=$(echo "$spec_json" | jq '.affectedPlatforms | length')
  infra_box=$(echo "$spec_json" | jq -r '.infraOnly')
  if [[ "$infra_box" == "true" || "$parity_override" == "infra-only" ]]; then
    # None / infra-only with a ticked platform box is contradictory.
    if [[ "$platforms_count" != "0" ]]; then
      echo "Affected platforms (None / infra-only can't be combined with a platform box)"
      return 0
    fi
  fi
  if [[ "$infra_box" == "true" && -n "$parity_override" && "$parity_override" != "infra-only" ]]; then
    # A ticked None box plus a single-platform parity:<x>-only label conflicts.
    echo "Affected platforms (None box conflicts with the $parity_override label)"
    return 0
  fi
  if [[ "$infra_box" != "true" && "$parity_override" != "infra-only" && "$platforms_count" == "0" ]]; then
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
# so the email-replan path still works without a separate check. The factory
# posts under that same identity, so its own marker comments are skipped too
# (as owner_comments_since does): the reply the planner posts to each trigger
# comment must not read as fresh feedback and start another replan.
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
        and (((.body // "") | test("<!-- drafto-factory")) | not)
        and (((.id | tostring)) as $id | ($acked | index($id)) | not)
      ))
      | map(.id | tostring)
    '
}

# ── Replies to operator comments (Plan Review + In Test) ───────────────────
# Every operator comment gets its own reply on the issue. The model (planner or
# implementer) writes each one to <reply-dir>/<commentId>.md and never posts it:
# bash posts it with the comment's marker appended (lib/issue-reply.mjs). So a
# reply never depends on the model remembering the marker — a reply without one
# would read back as fresh OWNER feedback and start another replan or revision —
# and bash posts a fixed fallback for any comment left without a reply.

# reply_dir_for <issue> — where the model writes its replies for this issue:
# under the factory's own logs/ (mode 700, gitignored), not a guessable /tmp
# path another account on this Mac could write into first. Whatever is in it is
# posted on the public issue.
reply_dir_for() { printf '%s/logs/factory/replies/issue-%s' "$REPO_ROOT" "$1"; }

# reset_reply_dir <issue> — empty the reply directory before a run, so a reply
# left from an earlier run can't be posted as this run's.
reset_reply_dir() {
  local dir
  dir=$(reply_dir_for "$1")
  rm -rf "$dir" && mkdir -p "$(dirname "$dir")" && mkdir -m 700 "$dir"
}

# reply_markers_for <comments-json> <marker-prefix> — {commentId, marker} for
# each comment that needs an answer: approval noise ("thanks", "lgtm") needs
# none. One jq pass for the ids and bodies (base64, so tabs and newlines in a
# body survive), and the result is always valid JSON ("[]" at worst).
reply_markers_for() {
  local comments="$1" prefix="$2" ids="" id body64 out
  while IFS=$'\t' read -r id body64; do
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    if is_noise_comment "$(printf '%s' "$body64" | base64 --decode 2>/dev/null)"; then
      continue
    fi
    ids+="$id "
  done < <(echo "$comments" | jq -r '.[] | [(.id | tostring), ((.body // "") | @base64)] | @tsv' 2>/dev/null)
  out=$(jq -cn --arg ids "$ids" --arg p "$prefix" \
    '$ids | split(" ") | map(select(test("^[0-9]+$")) | {commentId: ., marker: ($p + .)})' 2>/dev/null) || out=""
  printf '%s' "${out:-[]}"
}

# fetch_comments_retry <issue> — the issue's comments, as fetch_issue_comments
# prints them, retried twice on failure. Prints nothing and returns 1 when they
# still can't be read.
fetch_comments_retry() {
  local issue_num="$1" comments attempt
  for attempt in 1 2 3; do
    if comments=$(fetch_issue_comments "$issue_num" 2>/dev/null) && [[ -n "$comments" ]]; then
      printf '%s' "$comments"
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then sleep 2; fi
  done
  return 1
}

# comments_have_marker <comments-json> <marker> — exit 0 when a comment from the
# factory's identity (OWNER) carries <marker>. The repo is public, so another
# user's comment quoting a marker must not count as a reply. The ([^0-9]|$)
# suffix stops reply-123 from matching reply-1234.
comments_have_marker() {
  echo "$1" | jq -e --arg m "${2}([^0-9]|\$)" \
    'any(.[]; .authorAssociation == "OWNER" and ((.body // "") | test($m)))' >/dev/null 2>&1
}

# post_issue_replies <issue> <comments-json|""> <markers-json>
# Post each reply the model wrote — <reply-dir>/<commentId>.md for each
# {commentId, marker} in <markers-json> — as its own comment, defanged and with
# the marker appended. A reply whose marker is already on the issue (an earlier
# attempt) isn't posted again; with no comments to check against, it is posted.
# A posted file is deleted, so a second call can't post it twice while GitHub's
# listing lags. Appends each id posted to POSTED_REPLY_IDS (space-padded; the
# caller starts it as " " for the run).
post_issue_replies() {
  local issue_num="$1" comments="$2" markers="${3:-[]}" dir n i id marker file body
  dir=$(reply_dir_for "$issue_num")
  n=$(echo "$markers" | jq 'length' 2>/dev/null || echo "0")
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  for ((i=0; i<n; i++)); do
    id=$(echo "$markers" | jq -r ".[${i}].commentId // \"\"" 2>/dev/null || echo "")
    marker=$(echo "$markers" | jq -r ".[${i}].marker // \"\"" 2>/dev/null || echo "")
    [[ "$id" =~ ^[0-9]+$ && -n "$marker" ]] || continue
    file="$dir/$id.md"
    [[ -s "$file" ]] || continue
    if [[ -n "$comments" ]] && comments_have_marker "$comments" "$marker"; then
      log "Issue #$issue_num: the reply to comment $id is already posted; not posting it again"
      continue
    fi
    if ! body=$(node "$SCRIPT_DIR/lib/issue-reply.mjs" compose --file "$file" --marker "$marker" 2>>"$LOG_FILE"); then
      log "WARNING: the reply to comment $id on #$issue_num is empty or unreadable; not posting it"
      continue
    fi
    if printf '%s' "$body" | gh issue comment "$issue_num" --repo JakubAnderwald/drafto --body-file - >>"$LOG_FILE" 2>&1; then
      log "Issue #$issue_num: posted the reply to comment $id ($marker)"
      POSTED_REPLY_IDS+="$id "
      rm -f "$file"
    else
      log "WARNING: posting the reply to comment $id on #$issue_num failed"
    fi
  done
}

# plan_reply_check <issue> <reply-markers-json> [final]
# After a replan run, every trigger comment that needs an answer (one
# {commentId, marker} entry, built by reply_markers_for) gets its own reply:
# editing the plan alone notifies nobody and buries the answer, which is how
# #718's question went unanswered. The planner's reply for a comment is posted
# only once the plan acks that comment (in any plan comment: the planner may
# post a fresh one, action=planned): before that, the edit it describes hasn't
# landed, and the next tick's replan writes a fresh reply. A handled comment
# with no reply gets a fixed fallback.
# With [final] 1 the card is leaving Plan Review (Blocked) and no replan will
# come, so an unacked comment is answered too: with the planner's reply if it
# wrote one, otherwise a fallback, under drafto-factory-plan-blocked-reply-<id>
# — a different marker, so that if the card comes back the next replan of the
# same comment still gets its own reply. Fails CLOSED when the comments can't
# be read: without them the acks are unknown.
plan_reply_check() {
  local issue_num="$1" markers="${2:-[]}" final="${3:-0}"
  local comments acked plan_id plan_link url n i id marker blocked to_post="[]"
  [[ "$DRY_RUN" -eq 1 ]] && return 0
  n=$(echo "$markers" | jq 'length' 2>/dev/null || echo "0")
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  [[ "$n" -gt 0 ]] || return 0
  if ! comments=$(fetch_comments_retry "$issue_num"); then
    log "WARNING: could not read #$issue_num's comments to check the plan replies; skipping"
    return 0
  fi
  # Plan comments are the factory's own (OWNER): on a public repo anyone can
  # post one that looks like a plan and acks a comment.
  acked=$(extract_acked_comment_ids "$(echo "$comments" | jq -r \
    '[.[] | select(.authorAssociation == "OWNER" and ((.body // "") | startswith("<!-- drafto-factory-plan -->"))) | .body] | join("\n")')")
  [[ -n "$acked" ]] || acked='[]'
  # Which reply each comment is due: its own marker once acked, the Blocked one
  # when final; none yet otherwise.
  for ((i=0; i<n; i++)); do
    id=$(echo "$markers" | jq -r ".[${i}].commentId // \"\"")
    marker=$(echo "$markers" | jq -r ".[${i}].marker // \"\"")
    [[ "$id" =~ ^[0-9]+$ && -n "$marker" ]] || continue
    if echo "$acked" | jq -e --arg id "$id" 'index($id) != null' >/dev/null 2>&1; then
      to_post=$(echo "$to_post" | jq -c --arg id "$id" --arg m "$marker" '. + [{commentId: $id, marker: $m, final: false}]')
    elif [[ "$final" -eq 1 ]]; then
      to_post=$(echo "$to_post" | jq -c --arg id "$id" --arg m "drafto-factory-plan-blocked-reply-$id" \
        '. + [{commentId: $id, marker: $m, final: true}]')
    fi
  done
  post_issue_replies "$issue_num" "$comments" "$to_post"
  plan_id=$(echo "$comments" | jq -r \
    '[.[] | select(.authorAssociation == "OWNER" and ((.body // "") | startswith("<!-- drafto-factory-plan -->")))] | last | .id // "" | tostring')
  url="https://github.com/JakubAnderwald/drafto/issues/$issue_num"
  plan_link="the plan"
  [[ "$plan_id" =~ ^[0-9]+$ ]] && plan_link="[the plan]($url#issuecomment-$plan_id)"
  n=$(echo "$to_post" | jq 'length')
  for ((i=0; i<n; i++)); do
    id=$(echo "$to_post" | jq -r ".[${i}].commentId")
    marker=$(echo "$to_post" | jq -r ".[${i}].marker")
    blocked=$(echo "$to_post" | jq -r ".[${i}].final")
    # Posted just now: GitHub may not list it yet.
    if [[ "$POSTED_REPLY_IDS" == *" $id "* ]] || comments_have_marker "$comments" "$marker"; then
      continue
    fi
    log "Issue #$issue_num: no plan reply found for $marker; posting the fallback"
    # Recorded like a posted reply, so the Blocked path's second call can't
    # post it again while GitHub's listing lags.
    if [[ "$blocked" == "true" ]]; then
      if gh issue comment "$issue_num" --repo JakubAnderwald/drafto \
        --body "🏭 **The factory couldn't revise the plan for [your comment]($url#issuecomment-$id), and no reply to it was posted.**

The card is in **Blocked**, and $plan_link is as it was. The factory log on the Mac mini has the details; once the card is back in **Plan Review**, the factory looks at your comment again.

<!-- $marker -->" >>"$LOG_FILE" 2>&1; then
        POSTED_REPLY_IDS+="$id "
      fi
    else
      if gh issue comment "$issue_num" --repo JakubAnderwald/drafto \
        --body "🏭 **No reply was posted to [your comment]($url#issuecomment-$id).**

The factory handled it in $plan_link, which is current. If the plan doesn't answer your comment, comment again.

<!-- $marker -->" >>"$LOG_FILE" 2>&1; then
        POSTED_REPLY_IDS+="$id "
      fi
    fi
  done
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
# prior-PR object or "null"; $4 is the attempts counter; $7 is the revision
# reply markers, a JSON array of {commentId, marker} ("[]" on a first
# implementation — see revise_replies_check); $8 is the directory the
# implementer writes those replies to (reply_dir_for).
build_implement_bundle() {
  local issue_entry="$1"
  local approved_plan="${2:-null}"
  local prior_pr="${3:-null}"
  local attempts="${4:-0}"
  local revision_comments="${5:-[]}"
  local screenshot_sources="${6:-[]}"
  local reply_markers="${7:-[]}"
  local reply_dir="${8:-}"
  local repo_head_ref
  repo_head_ref=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  jq -n \
    --argjson issue "$issue_entry" \
    --argjson plan "$approved_plan" \
    --argjson priorPr "$prior_pr" \
    --arg attempts "$attempts" \
    --argjson revisionComments "$revision_comments" \
    --argjson screenshotSources "$screenshot_sources" \
    --argjson replyMarkers "$reply_markers" \
    --arg replyDir "$reply_dir" \
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
       screenshotSources: $screenshotSources,
       replyMarkers: $replyMarkers,
       replyDir: (if $replyDir == "" then null else $replyDir end),
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

# has_actionable_feedback <comments-json> <since-iso> — exit 0 when an OWNER
# comment newer than <since-iso> (the consumed-feedback high-water mark,
# lastFeedbackAt) is something other than approval noise: the feedback that
# rolls an In Test card back to In Progress. One definition for the In Test
# sweep (don't dispatch a beta for a commit about to be superseded) and the
# Testing sweep (cut verification short). No mark yet → nothing counts.
has_actionable_feedback() {
  local comments_json="$1" since="$2" new n i
  [[ -n "$since" && "$since" != "null" ]] || return 1
  new=$(owner_comments_since "$comments_json" "$since")
  n=$(echo "$new" | jq 'length' 2>/dev/null || echo "0")
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  for ((i=0; i<n; i++)); do
    if ! is_noise_comment "$(echo "$new" | jq -r ".[${i}].body")"; then
      return 0
    fi
  done
  return 1
}

# revise_replies_check <issue> <pr-num> <reply-markers-json> <kind>
# After a revision run, post the implementer's replies, then make sure every
# feedback comment that needed an answer (one {commentId, marker} entry in
# bundle.replyMarkers) has one on the issue, where the reporter asked, instead
# of only in the PR body. Trust the markers, not the directive line (as
# intest_handoff does): for each comment with no reply, post the fixed fallback
# for <kind>, so no comment goes unanswered. <kind> is "noop" (no code change),
# "declined" (outside the plan, ADR-0058) or "implemented" (a revision was
# pushed). No entries means the round was all approval noise: nothing to
# answer. When the comments can't be read afterwards, noop and declined fail
# OPEN — a fallback for each comment whose reply wasn't posted just now,
# because a rare extra notice beats a reporter hearing nothing — while a pushed
# revision fails closed: its new preview and scenario comment follow anyway.
revise_replies_check() {
  local issue_num="$1" pr_num="$2" markers="${3:-[]}" kind="${4:-noop}"
  local comments n i id marker
  n=$(echo "$markers" | jq 'length' 2>/dev/null || echo "0")
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  [[ "$n" -gt 0 ]] || return 0
  POSTED_REPLY_IDS=" "
  comments=$(fetch_comments_retry "$issue_num") || comments=""
  post_issue_replies "$issue_num" "$comments" "$markers"
  if ! comments=$(fetch_comments_retry "$issue_num"); then
    comments=""
    if [[ "$kind" == "implemented" ]]; then
      log "WARNING: could not read #$issue_num's comments to look for the revision replies; skipping the fallbacks"
      return 0
    fi
    log "WARNING: could not read #$issue_num's comments to look for the revision replies; posting the fallbacks"
  fi
  for ((i=0; i<n; i++)); do
    id=$(echo "$markers" | jq -r ".[${i}].commentId // \"\"" 2>/dev/null || echo "")
    marker=$(echo "$markers" | jq -r ".[${i}].marker // \"\"" 2>/dev/null || echo "")
    [[ "$id" =~ ^[0-9]+$ && -n "$marker" ]] || continue
    if [[ "$POSTED_REPLY_IDS" == *" $id "* ]]; then
      continue
    fi
    if [[ -n "$comments" ]]; then
      if comments_have_marker "$comments" "$marker"; then
        log "Issue #$issue_num: revision reply posted ($marker)"
        continue
      fi
      log "Issue #$issue_num: no revision reply found for $marker; posting the fallback"
    fi
    revise_fallback_reply "$issue_num" "$pr_num" "$id" "$kind"
  done
}

# revise_fallback_reply <issue> <pr-num> <comment-id> <kind> — the fixed notice
# for a feedback comment that got no reply. It links that comment and carries
# its reply marker, so each comment is answered once. Noop and declined notices
# also carry drafto-factory-revise-noop.
revise_fallback_reply() {
  local issue_num="$1" pr_num="$2" id="$3" kind="${4:-noop}"
  local about="" details="" headline next="" body markers=""
  if [[ -n "$id" ]]; then
    about="About [your comment](https://github.com/JakubAnderwald/drafto/issues/$issue_num#issuecomment-$id): "
    markers="<!-- drafto-factory-revise-reply-$id -->"
  fi
  case "$kind" in
    declined)
      # Rephrasing an out-of-plan request here would only be declined again.
      headline="The factory declined that as outside this issue's plan, and no reply was found."
      details=" Open a new issue for that work instead of rephrasing it here."
      next="Drag to **Approved** to ship this PR as it is."
      body="${about}The preview is unchanged.$details $next"
      ;;
    implemented)
      headline="A revision was pushed for that, but no reply was found."
      [[ -n "$pr_num" ]] && details=" PR #$pr_num's description records what changed."
      body="${about}The card goes back through review, then comes back for you to test with a new preview.$details"
      ;;
    *)
      headline="No code change was made for that, and no reply was found."
      if [[ -n "$pr_num" ]]; then
        details=" If you asked a question or for a check, the run may have left notes in PR #$pr_num's description; if not, comment again."
      fi
      next="Drag to **Approved** to ship it, or comment a more specific change."
      body="${about}The preview is unchanged.$details $next"
      ;;
  esac
  if [[ "$kind" != "implemented" ]]; then
    [[ -n "$markers" ]] && markers+=$'\n'
    markers+="<!-- drafto-factory-revise-noop -->"
  fi
  gh issue comment "$issue_num" --repo JakubAnderwald/drafto \
    --body "🏭 **$headline**

$body

$markers" >>"$LOG_FILE" 2>&1 || true
}

# worktree_untouched <worktree> <pr-head> — exit 0 only when the worktree holds
# nothing the PR lacks: HEAD is <pr-head> or an ancestor of it (a worktree
# merely behind, because someone else pushed, is fine) and `git status` is
# clean. Fails closed: an empty <pr-head>, or any git error (such as <pr-head>
# not being in the local object store), counts as touched.
worktree_untouched() {
  local wt="$1" pr_head="$2" local_head status
  [[ -n "$pr_head" ]] || return 1
  local_head=$(git -C "$wt" rev-parse HEAD 2>>"$LOG_FILE") || return 1
  if [[ "$local_head" != "$pr_head" ]]; then
    git -C "$wt" merge-base --is-ancestor "$local_head" "$pr_head" 2>>"$LOG_FILE" || return 1
  fi
  status=$(git -C "$wt" status --porcelain 2>>"$LOG_FILE") || return 1
  [[ -z "$status" ]]
}

# revision_return_to_test <issue> <item-id> <pr-head> <item-labels> <pr-num>
#   <reply-markers-json> <feedback-mark> <kind>
# A revision run ended with the PR unchanged: <kind> "noop" (the feedback
# needed no code change) or "declined" (it was outside the plan, ADR-0058).
# The existing PR + preview are still valid, so re-present it instead of
# re-running CI: in Testing when this commit still owes a verification report
# (ADR-0053), otherwise in In Test. A failed move to Testing falls back to In
# Test. Then mark the feedback consumed, reset attempts and check for the
# implementer's replies. The slot and worktree stay, as for any In Test card.
revision_return_to_test() {
  local issue_num="$1" item_id="$2" pr_head="$3" labels="$4" pr_num="$5"
  local markers="$6" mark="$7" kind="$8" target="In Test" state
  if verify_target_status "$issue_num" "$pr_head" "$labels" \
      && transition_status "$item_id" "$issue_num" "Testing"; then
    target="Testing"
    # Start this commit's round now, as verify_enter does: a round left in
    # state would otherwise decide for it (an older commit's reads as "head
    # moved", this one's carries an expired hold-cap clock).
    state=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" \
      --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo "{}")
    verify_begin_round "$issue_num" "$pr_head" \
      "$(verify_cr_note "$issue_num" "$pr_head" "$state")" "$state"
  else
    transition_status "$item_id" "$issue_num" "In Test" || true
  fi
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" lastFeedbackAt "$mark" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$issue_num" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  revise_replies_check "$issue_num" "$pr_num" "$markers" "$kind"
  log "Issue #$issue_num: revision $kind; returned to $target"
}

# implement_park_blocked <item-id> <issue> <slot> <reason> — move an --implement
# card to Blocked for a human, release its slot and remove its worktree (the
# branch stays). <reason> is recorded as lastError.
implement_park_blocked() {
  local item_id="$1" issue_num="$2" slot="$3" reason="$4"
  transition_status "$item_id" "$issue_num" "Blocked" || true
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" lastError "$reason" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-release "$slot" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  node "$SCRIPT_DIR/lib/worktree-cli.mjs" remove --issue "$issue_num" --root "$REPO_ROOT" --force >>"$LOG_FILE" 2>&1 || true
  log "Issue #$issue_num: $reason → Blocked; slot $slot released"
}

# Build the factory_watch bundle. $2 approved-plan obj|null, $3 prior-PR obj,
# $4 CI summary text, $5 unresolved-comments JSON array, $6 attempts,
# $7 screenshot-sources (full issue-comment thread) JSON array,
# $8 unresolved review threads JSON array (from fetch_review_threads).
build_watch_bundle() {
  local issue_entry="$1"
  local approved_plan="${2:-null}"
  local prior_pr="${3:-null}"
  local ci_summary="${4:-}"
  local unresolved="${5:-[]}"
  local attempts="${6:-0}"
  local screenshot_sources="${7:-[]}"
  local review_threads="${8:-[]}"
  local repo_head_ref
  repo_head_ref=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  jq -n \
    --argjson issue "$issue_entry" \
    --argjson plan "$approved_plan" \
    --argjson priorPr "$prior_pr" \
    --arg ciSummary "$ci_summary" \
    --argjson unresolved "$unresolved" \
    --argjson reviewThreads "$review_threads" \
    --argjson screenshotSources "$screenshot_sources" \
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
       reviewThreads: $reviewThreads,
       comments: [],
       screenshotSources: $screenshotSources,
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

# Build the factory_review bundle for the code-review stage. $2 approved-plan
# obj|null, $3 prior-PR obj, $4 raw PR diff, $5 changed-file list, $6 head SHA.
# Deliberately carries no comment thread — the reviewer judges the diff, not the
# conversation about it.
build_review_bundle() {
  local issue_entry="$1"
  local approved_plan="${2:-null}"
  local prior_pr="${3:-null}"
  local pr_diff="${4:-}"
  local pr_files="${5:-}"
  local head_sha="${6:-}"
  local repo_head_ref
  repo_head_ref=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  jq -n \
    --argjson issue "$issue_entry" \
    --argjson plan "$approved_plan" \
    --argjson priorPr "$prior_pr" \
    --arg prDiff "$pr_diff" \
    --arg prFiles "$pr_files" \
    --arg headSha "$head_sha" \
    --arg allowlist "$SUPPORT_ALLOWLIST" \
    --arg oauthUserEmail "$OAUTH_USER_EMAIL" \
    --arg phase "$PHASE" \
    --arg repoNwo "JakubAnderwald/drafto" \
    --arg headRef "$repo_head_ref" \
    '{
       kind: "factory_review",
       issue: $issue,
       approvedPlan: (if $plan == null then null else {
         commentId: ($plan.id),
         url: ("https://github.com/JakubAnderwald/drafto/issues/" + ($issue.number|tostring) + "#issuecomment-" + ($plan.id|tostring)),
         body: ($plan.body // ""),
         createdAt: ($plan.createdAt // null)
       } end),
       priorPr: $priorPr,
       prDiff: $prDiff,
       prFiles: $prFiles,
       headSha: $headSha,
       config: {
         phase: $phase,
         allowlist: ($allowlist | split(",") | map(ascii_downcase | sub("^\\s+";"") | sub("\\s+$";""))),
         oauthUserEmail: $oauthUserEmail
       },
       repo: { nameWithOwner: $repoNwo, headRef: $headRef }
     }' \
    | node "$SCRIPT_DIR/lib/factory-bundle.mjs"
}

# Build the factory_intest bundle for the In Review → In Test hand-off. $2
# approved-plan obj|null, $3 prior-PR obj, $4 raw PR diff, $5 changed-file list,
# $6 platforms JSON, $7 preview URL, $8 advisory text, $9 beta-dispatch JSON,
# ${10} head SHA, ${11} full issue-comment thread JSON, ${12} CodeRabbit coverage
# note (ADR-0036; "" when the commit was covered or the lane is off).
#
# The stage the scenario is written at comes from the INTEST_STAGE env var
# (`intest`, the default, or `testing` when the card is entering the Testing
# column, ADR-0053), not from a 13th argument: callers set it as a prefix on the
# one intest_handoff call that needs it, and every other call site, and the
# tests pinning this signature, stay as they are.
build_intest_bundle() {
  local issue_entry="$1"
  local approved_plan="${2:-null}"
  local prior_pr="${3:-null}"
  local pr_diff="${4:-}"
  local pr_files="${5:-}"
  local platforms="${6:-{\}}"
  local preview_url="${7:-}"
  local advisory="${8:-}"
  local beta_dispatch="${9:-null}"
  local head_sha="${10:-}"
  local comments="${11:-[]}"
  local cr_coverage_note="${12:-}"
  local repo_head_ref
  repo_head_ref=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  jq -n \
    --argjson issue "$issue_entry" \
    --argjson plan "$approved_plan" \
    --argjson priorPr "$prior_pr" \
    --arg prDiff "$pr_diff" \
    --arg prFiles "$pr_files" \
    --argjson platforms "$platforms" \
    --arg previewUrl "$preview_url" \
    --arg advisory "$advisory" \
    --arg crCoverageNote "$cr_coverage_note" \
    --argjson betaDispatch "$beta_dispatch" \
    --arg headSha "$head_sha" \
    --argjson comments "$comments" \
    --arg stage "${INTEST_STAGE:-intest}" \
    --arg allowlist "$SUPPORT_ALLOWLIST" \
    --arg oauthUserEmail "$OAUTH_USER_EMAIL" \
    --arg phase "$PHASE" \
    --arg repoNwo "JakubAnderwald/drafto" \
    --arg headRef "$repo_head_ref" \
    '{
       kind: "factory_intest",
       stage: $stage,
       issue: $issue,
       approvedPlan: (if $plan == null then null else {
         commentId: ($plan.id),
         url: ("https://github.com/JakubAnderwald/drafto/issues/" + ($issue.number|tostring) + "#issuecomment-" + ($plan.id|tostring)),
         body: ($plan.body // ""),
         createdAt: ($plan.createdAt // null)
       } end),
       priorPr: $priorPr,
       prDiff: $prDiff,
       prFiles: $prFiles,
       platforms: $platforms,
       previewUrl: $previewUrl,
       advisory: $advisory,
       crCoverageNote: $crCoverageNote,
       betaDispatch: $betaDispatch,
       headSha: $headSha,
       comments: [],
       screenshotSources: $comments,
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

# Head commit OID of PR <n>, or "" on any failure. Deliberately separate from
# find_prior_pr, whose {number,url,headRef,state} shape is consumed by the
# implement bundle and pinned by factory-bundle tests. Callers treat "" as
# "unknown" and fail closed.
pr_head_oid() {
  gh pr view "$1" --repo JakubAnderwald/drafto --json headRefOid --jq '.headRefOid' 2>>"$LOG_FILE" || echo ""
}

# copy_worktree_env / seed_worktree_node_modules / run_pnpm_install live in
# scripts/lib/beta-build-root.sh (sourced above), shared with nightly-support.sh.

# Free space (whole GiB) on the fuller of the two volumes a run writes to: the
# build volume backing the repo/worktrees, and the internal disk behind $HOME
# (TMPDIR, Claude transcripts, simulators) — ADR-0060 put the factory checkout on
# an external volume, which says nothing about the internal disk. POSIX `df -Pk`
# guarantees a single data row in 1024-byte blocks; $4 is available. Prints ""
# when neither path can be measured.
free_disk_gb() {
  df -Pk "$REPO_ROOT" "$HOME" 2>/dev/null \
    | awk 'NR > 1 { gb = int($4 / 1024 / 1024); if (min == "" || gb < min) min = gb } END { print min }'
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
  # parity:infra-only authorises a change that touches NO app runtime (factory
  # internals under scripts/, docs, CI). App code under apps/** OR the shared
  # package packages/shared/** (compiled into every platform) means the label is
  # wrong — block so non-infra work can't masquerade as infra-only.
  if [[ "$override" == "infra-only" ]]; then
    if echo "$diff_files" | grep -qE '^(apps/|packages/shared/)'; then
      echo "parity:infra-only but the PR changes app code (apps/ or packages/shared/)"
      return 0
    fi
    echo ""; return 0
  fi
  # A parity:*-only override authorises a single-platform PR — skip the
  # cross-platform mandate entirely.
  if [[ -n "$override" ]]; then echo ""; return 0; fi
  # No platform claims to check (e.g. the --release call site passes "" to
  # exercise only the phase-scope guard above) — nothing to enforce. Returning
  # here also avoids expanding an empty array below, which trips
  # `set -u` ("unbound variable") on bash 3.2 (the Mac mini's /bin/bash).
  if [[ -z "$platforms_csv" ]]; then echo ""; return 0; fi
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

# Migration gate (hard stop) for the Approved → Released merge. A PR that touches
# supabase/migrations/** may only be merged once the `migration-approved` label
# is on it. Args:
#   $1 newline-separated changed file paths (from gh pr view --json files)
#   $2 PR labels CSV
# Prints a violation reason, or "" when the gate passes. Enforces the CLAUDE.md /
# ADR-0026 migration mandate: a supabase/migrations/** change may only merge once
# the migration-approved label is on the PR. (This is the label gate — distinct
# from check-migration-safety.sh, which scans migration SQL for destructive
# statements; the two are unrelated checks.)
migration_violation() {
  local diff_files="$1"
  local pr_labels_csv="$2"
  if echo "$diff_files" | grep -qE '^supabase/migrations/'; then
    if [[ ",$pr_labels_csv," != *",migration-approved,"* ]]; then
      echo "PR touches supabase/migrations/** without the migration-approved label"
      return 0
    fi
  fi
  echo ""
}

# Slot index (0|1) currently assigned to <issue>, or "" if none. Unlike
# slot_for_issue (which falls back to the first FREE slot for acquisition), this
# only ever returns a slot the issue actually holds — safe for teardown.
slot_held_by_issue() {
  local issue_num="$1"
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-status \
    --state-file "$STATE_FILE" 2>>"$LOG_FILE" \
    | jq -r --arg i "$issue_num" \
      '.slots | to_entries | map(select(.value.issueNumber == $i)) | (.[0].key // "")'
}

# Reason the local branch factory/issue-<n> must be KEPT, or "" when deleting
# it is safe. $2 optionally supplies a PR state the caller already knows, to
# skip a redundant API call.
#
# FAILS CLOSED: any doubt — a lookup failure, an unrecognised state — keeps the
# branch. A stray branch ref costs 40 bytes; deleting one that still backs an
# open PR strands every commit on it, because addWorktree then rebuilds the
# worktree from origin/main and the agent silently edits pre-PR files.
#
# STDOUT IS CAPTURED by the caller, so this must never call log().
branch_keep_reason() {
  local issue_num="$1"
  local known_state="${2:-}"
  if [[ "$known_state" == "MERGED" ]]; then echo ""; return 0; fi
  local pr state
  pr=$(find_prior_pr "$issue_num") || { echo "PR lookup failed"; return 0; }
  [[ -n "$pr" ]] || { echo "PR lookup returned nothing"; return 0; }
  if [[ "$pr" == "null" ]]; then echo ""; return 0; fi
  state=$(echo "$pr" | jq -r '.state // ""' 2>/dev/null || echo "")
  case "$state" in
    MERGED) echo "" ;;
    # A CLOSED factory PR is reopen-by-push (see find_prior_pr); dropping the
    # branch would destroy that path.
    OPEN|CLOSED) echo "PR #$(echo "$pr" | jq -r '.number') is $state" ;;
    *) echo "unknown PR state '${state:-<empty>}'" ;;
  esac
}

# Remove the worktree for <issue>, deleting the local branch only when it no
# longer backs a live PR. $2 optionally passes a known PR state.
remove_worktree_for() {
  local issue_num="$1"
  local known_state="${2:-}"
  local keep out
  keep=$(branch_keep_reason "$issue_num" "$known_state")
  if [[ -n "$keep" ]]; then
    log "Issue #$issue_num: keeping branch factory/issue-$issue_num ($keep); removing worktree only"
    node "$SCRIPT_DIR/lib/worktree-cli.mjs" remove --issue "$issue_num" --root "$REPO_ROOT" --force >>"$LOG_FILE" 2>&1 || true
    return 0
  fi
  out=$(node "$SCRIPT_DIR/lib/worktree-cli.mjs" remove --issue "$issue_num" --root "$REPO_ROOT" --force --delete-branch 2>>"$LOG_FILE" || echo "")
  [[ -n "$out" ]] || out='{}'
  # branchHead is the pre-deletion tip: enough to undo a mistaken teardown with
  # `git branch factory/issue-<n> <oid>`.
  log "Issue #$issue_num: worktree teardown $(echo "$out" | jq -c '{removed,branchDeleted,branchHead}' 2>/dev/null || echo '{}')"
}

# Release the worktree slot + remove the worktree for <issue>, deleting the
# branch only when no live PR still points at it. Safe when no slot is held (a
# card may have reached Approved after its slot was already reclaimed). $2
# optionally passes a PR state the caller already knows. Best-effort throughout.
release_slot_and_worktree() {
  local issue_num="$1"
  local known_state="${2:-}"
  local slot
  slot=$(slot_held_by_issue "$issue_num")
  if [[ -n "$slot" ]]; then
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-release "$slot" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  fi
  remove_worktree_for "$issue_num" "$known_state"
}

# ── Session-limit detection ─────────────────────────────────────────────────
# A `claude -p` call that dies because the shared subscription hit its session
# usage limit exits non-zero with NOTHING on stdout/stderr — the only evidence
# is the last assistant record of the claude session transcript. Rather than
# bump the per-issue retry budget (which burned all 5 of #463's attempts in
# 41 min against a limit that hadn't reset yet), detect the limit and pause the
# whole factory until it resets. Since the loop runs plan→implement→watch→
# release sequentially under one mutex, pausing here also stops the rest of the
# tick at the top-of-script pause gate.
#
# check_session_limit <cwd> <since-iso>
#   Exit 0 (and set SESSION_LIMIT_RESET_AT / SESSION_LIMIT_REASON) when the
#   newest claude transcript for <cwd> ended in a limit error newer than
#   <since-iso>. Exit 1 on anything else — fail-open to the normal retry path.
check_session_limit() {
  local cwd="$1" since="$2" out
  SESSION_LIMIT_RESET_AT=""
  SESSION_LIMIT_REASON=""
  out=$(node "$SCRIPT_DIR/lib/session-limit.mjs" check --cwd "$cwd" --since "$since" \
    --fallback-min "$FACTORY_LIMIT_FALLBACK_MIN" 2>>"$LOG_FILE") || return 1
  SESSION_LIMIT_RESET_AT=$(echo "$out" | jq -r '.resetAt // empty' 2>/dev/null || echo "")
  SESSION_LIMIT_REASON=$(echo "$out" | jq -r '.reason // empty' 2>/dev/null || echo "")
  [[ -n "$SESSION_LIMIT_RESET_AT" ]]
}

# pause_for_session_limit — write the timed pause. The caller logs its mode's
# `=== completed ===` line and exits 0 (exit 0 so the failure trap files no
# bogus factory-failure issue). Attempts are intentionally NOT bumped.
pause_for_session_limit() {
  log "Claude session limit hit (${SESSION_LIMIT_REASON:-no detail}); pausing factory until $SESSION_LIMIT_RESET_AT (attempts NOT bumped)"
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:pause-until "$SESSION_LIMIT_RESET_AT" \
    "claude session limit: ${SESSION_LIMIT_REASON:-unknown}" \
    --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
}

# Has <issue> already received a comment carrying <marker>? Idempotency guard so
# a re-tick on a parked Approved card doesn't re-post the same notice every cycle.
# Fails CLOSED: on a transient comment-fetch failure (empty output) it returns
# success ("treat as already marked") so the caller SKIPS posting rather than
# spamming the issue every tick during a GitHub hiccup.
issue_has_marker() {
  local issue_num="$1"
  local marker="$2"
  local comments
  if ! comments=$(fetch_issue_comments "$issue_num" 2>/dev/null) || [[ -z "$comments" ]]; then
    return 0
  fi
  echo "$comments" | jq -e --arg m "$marker" 'any(.[]; .body | test($m))' >/dev/null 2>&1
}

# True (exit 0) when the PR's CI is genuinely green: every branch-protection
# *required* status context is SUCCESS in the rollup. With no required contexts
# configured, falls back to "rollup non-empty, ≥1 SUCCESS, nothing pending". An
# empty/partial rollup (checks never ran) therefore can NOT pass — "no checks" is
# not "green". Reads REQUIRED_CONTEXTS_JSON (fetched once per --release run).
ci_required_green() {
  local pr_view="$1"
  local req_total green_req total success pending
  req_total=$(echo "${REQUIRED_CONTEXTS_JSON:-[]}" | jq 'length' 2>/dev/null || echo 0)
  [[ "$req_total" =~ ^[0-9]+$ ]] || req_total=0
  if [[ "$req_total" -gt 0 ]]; then
    green_req=$(echo "$pr_view" | jq --argjson req "${REQUIRED_CONTEXTS_JSON:-[]}" '
      [ .statusCheckRollup[]? | select((.conclusion // .state // "") == "SUCCESS")
        | (.name // .context // "") ] as $green
      | [ $req[] | select(. as $r | $green | index($r)) ] | length' 2>/dev/null || echo 0)
    [[ "$green_req" =~ ^[0-9]+$ ]] || green_req=0
    [[ "$green_req" -ge "$req_total" ]]
    return
  fi
  total=$(echo "$pr_view" | jq '[.statusCheckRollup[]?] | length' 2>/dev/null || echo 0)
  success=$(echo "$pr_view" | jq '[.statusCheckRollup[]? | select((.conclusion // .state // "") == "SUCCESS")] | length' 2>/dev/null || echo 0)
  pending=$(echo "$pr_view" | jq '[.statusCheckRollup[]? | select((.status // "") == "QUEUED" or (.status // "") == "IN_PROGRESS" or (.state // "") == "PENDING" or (.state // "") == "EXPECTED")] | length' 2>/dev/null || echo 0)
  [[ "$total" =~ ^[0-9]+$ ]] || total=0
  [[ "$success" =~ ^[0-9]+$ ]] || success=0
  [[ "$pending" =~ ^[0-9]+$ ]] || pending=0
  [[ "$total" -gt 0 && "$success" -gt 0 && "$pending" -eq 0 ]]
}

# Fetch branch-protection required status contexts into REQUIRED_CONTEXTS_JSON (a
# JSON array of context names). Falls back to "[]" when protection isn't
# readable. Both --watch and --release call this once per run so their CI gates
# agree on what "failing" and "green" mean.
fetch_required_contexts() {
  REQUIRED_CONTEXTS_JSON=$(gh api "repos/JakubAnderwald/drafto/branches/main/protection/required_status_checks" \
    --jq '[.contexts[]?]' 2>>"$LOG_FILE" || echo "[]")
  [[ -n "$REQUIRED_CONTEXTS_JSON" ]] || REQUIRED_CONTEXTS_JSON="[]"
}

# Count of *failing* rollup checks that are branch-protection required contexts.
# Non-required checks — an advisory bot like CodeRabbit, including its "Review
# rate limited" status — are ignored so they can never trigger the --watch fix
# loop or block the --release merge. Falls back to counting ALL failing checks
# when no required set is configured/readable (conservative: an unknown required
# set must not silently pass a red PR). Reads REQUIRED_CONTEXTS_JSON; prints an
# integer. Same rollup-normalisation + name/context matching as ci_required_green.
pr_failing_required() {
  local pr_view="$1"
  echo "$pr_view" | jq -r --argjson req "${REQUIRED_CONTEXTS_JSON:-[]}" '
    [ .statusCheckRollup[]? | (.conclusion // .state // "") as $c
      | select($c == "FAILURE" or $c == "TIMED_OUT" or $c == "CANCELLED"
               or $c == "ACTION_REQUIRED" or $c == "ERROR" or $c == "STARTUP_FAILURE")
      | (.name // .context // "") ] as $failing
    | if ($req | length) > 0
      then [ $failing[] | select(. as $f | $req | index($f)) ] | length
      else $failing | length
      end' 2>/dev/null || echo 0
}

# Count of *pending* rollup checks among required contexts (fallback: all
# pending). Used by --watch so a non-required check stuck pending (e.g. a bot
# that never reports) can't wedge the In Test advance. Prints an integer.
pr_pending_required() {
  local pr_view="$1"
  echo "$pr_view" | jq -r --argjson req "${REQUIRED_CONTEXTS_JSON:-[]}" '
    [ .statusCheckRollup[]? | select(
        (.status // "") == "QUEUED" or (.status // "") == "IN_PROGRESS"
        or (.state // "") == "PENDING" or (.state // "") == "EXPECTED")
      | (.name // .context // "") ] as $pending
    | if ($req | length) > 0
      then [ $pending[] | select(. as $p | $req | index($p)) ] | length
      else $pending | length
      end' 2>/dev/null || echo 0
}

# Comma-joined names of *failing* checks that are NOT required contexts (advisory
# reds like CodeRabbit). Surfaced in the In Test hand-off so the operator can
# glance at them before Approving, even though they don't block. Empty when the
# required set is unknown (then everything is treated as blocking upstream).
pr_failing_advisory() {
  local pr_view="$1"
  echo "$pr_view" | jq -r --argjson req "${REQUIRED_CONTEXTS_JSON:-[]}" '
    [ .statusCheckRollup[]? | (.conclusion // .state // "") as $c
      | select($c == "FAILURE" or $c == "TIMED_OUT" or $c == "CANCELLED"
               or $c == "ACTION_REQUIRED" or $c == "ERROR" or $c == "STARTUP_FAILURE")
      | (.name // .context // "check") ]
    | ( if ($req | length) > 0 then [ .[] | select(. as $n | $req | index($n) | not) ] else [] end )
    | unique | join(", ")' 2>/dev/null || echo ""
}

# The Vercel preview URL a person clicks, from a `gh pr view --json
# comments,statusCheckRollup` snapshot: the Vercel bot posts a comment with the
# link, and the deployment also surfaces as a rollup target URL, so both are
# searched. Empty when there is none yet. (Not the URL an unattended browser may
# open: that is preview_url_for_sha, the exact per-commit deployment.)
pr_preview_url() {
  echo "$1" | jq -r '
    ([ .comments[]? | select((.author.login // "") | test("vercel"; "i")) | .body ] | last // "")
    + " " +
    ([ .statusCheckRollup[]? | select(((.context // .name // "") | test("vercel"; "i")))
       | (.targetUrl // .detailsUrl // "") ] | join(" "))' 2>/dev/null \
    | grep -oE 'https://[a-zA-Z0-9._-]*vercel\.app[^ )]*' | head -1 || true
}

# The failing *required* checks as a JSON array of {name, c, url}: the base the
# helpers below build on. Same failing-conclusion set, required-set filtering and
# fallback (every check, when the required set is unknown) as pr_failing_required.
pr_failing_required_checks() {
  local pr_view="$1"
  echo "$pr_view" | jq -c --argjson req "${REQUIRED_CONTEXTS_JSON:-[]}" '
    [ .statusCheckRollup[]? | (.conclusion // .state // "") as $c
      | select($c == "FAILURE" or $c == "TIMED_OUT" or $c == "CANCELLED"
               or $c == "ACTION_REQUIRED" or $c == "ERROR" or $c == "STARTUP_FAILURE")
      | { name: (.name // .context // "check"), c: $c, url: (.detailsUrl // .targetUrl // "") } ]
    | if ($req | length) > 0 then [ .[] | select(.name as $n | $req | index($n)) ] else . end' \
    2>/dev/null || echo "[]"
}

# The failing *required* checks, one "name — CONCLUSION (url)" line each. Feeds
# the --watch fix bundle (never hand the fix agent an advisory bot's red to
# "fix") and the CI comments.
pr_failing_required_summary() {
  pr_failing_required_checks "$1" | jq -r '
    [ .[] | (.name + " — " + .c + (if .url != "" then " (" + .url + ")" else "" end)) ]
    | join("\n")' 2>/dev/null || echo ""
}

# Did CI judge the code? Prints one word for the failing required checks:
#   infra   — every one is a GitHub Actions job that was CANCELLED before any
#             runner picked it up ("The job was not acquired by Runner of type
#             hosted": no runner, no steps). Re-running is the fix, not a code
#             change. This is what parked #654 in Approved for days.
#   red     — anything else: a FAILURE / TIMED_OUT / ERROR / STARTUP_FAILURE (a
#             workflow the PR itself may have broken), a job cancelled after it
#             started (a job-level timeout or a manual cancel is a CANCELLED that
#             ran — likely a hang in the code), or a non-Actions check.
#   unknown — a job lookup failed; the caller retries next tick rather than guess.
classify_failing_required() {
  local checks jobs job started
  checks=$(pr_failing_required_checks "$1")
  if ! echo "$checks" | jq -e 'length > 0 and all(.c == "CANCELLED")' >/dev/null 2>&1; then
    echo "red"; return 0
  fi
  jobs=$(echo "$checks" | jq -r '.[] | ((.url | capture("/actions/runs/[0-9]+/job/(?<j>[0-9]+)") | .j) // "none")' 2>/dev/null)
  while IFS= read -r job; do
    [[ "$job" =~ ^[0-9]+$ ]] || { echo "red"; return 0; }
    if ! started=$(gh api "repos/JakubAnderwald/drafto/actions/jobs/$job" \
        --jq '((.steps // []) | length > 0) or ((.runner_name // "") != "")' 2>>"$LOG_FILE"); then
      echo "unknown"; return 0
    fi
    [[ "$started" == "false" ]] || { echo "red"; return 0; }
  done <<< "$jobs"
  echo "infra"
}

# The GitHub Actions run IDs behind the failing required checks, deduped, one per
# line. Only meaningful once classify_failing_required said "infra", which
# guarantees every one of them is an Actions job.
pr_infra_rerun_ids() {
  pr_failing_required_checks "$1" | jq -r '
    [ .[] | (.url | capture("/actions/runs/(?<id>[0-9]+)") | .id) ] | unique[]' 2>/dev/null || true
}

# Re-runs already spent on <head_sha> (state field ciRerun = "<sha>:<count>"). 0
# for any other head — a new push re-arms the budget — or an unreadable record.
ci_rerun_count() {
  local issue_num="$1" head_sha="$2" record count
  record=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" \
    --state-file "$STATE_FILE" 2>>"$LOG_FILE" | jq -r '.ciRerun // ""' 2>/dev/null || echo "")
  count="${record##*:}"
  [[ "${record%%:*}" == "$head_sha" && "$count" =~ ^(0|[1-9][0-9]*)$ ]] || count=0
  echo "$count"
}

# Re-run the cancelled required checks on <head_sha>, at most FACTORY_CI_RERUN_MAX
# times per head SHA (state field ciRerun = "<sha>:<count>"; a new push re-arms
# it). Returns 0 when it acted — re-ran, or is waiting for the run to finish
# first — and the caller waits for a later tick. Returns 1 once the budget is
# spent. `gh run rerun --failed` refuses a run that is still in progress, and
# the run also carries non-required jobs (Mobile/Desktop Checks), so it waits on
# the RUN's status, not the required checks'. The attempt is counted BEFORE
# calling gh, so a re-run GitHub keeps refusing still spends the budget instead
# of retrying every tick forever.
rerun_infra_failures() {
  local issue_num="$1" pr_num="$2" head_sha="$3" pr_view="$4"
  local run_ids count id status
  run_ids=$(pr_infra_rerun_ids "$pr_view")
  [[ -n "$run_ids" ]] || return 1
  while IFS= read -r id; do
    status=$(gh run view "$id" --repo JakubAnderwald/drafto --json status --jq '.status' 2>>"$LOG_FILE" || echo "")
    # An unreadable status is "unknown", not "completed": retry next tick rather
    # than spend an attempt on a re-run GitHub may refuse (run still going).
    if [[ -z "$status" ]]; then
      log "WARNING: couldn't read the status of run $id for PR #$pr_num (transient?); re-running on a later tick"
      return 0
    fi
    if [[ "$status" != "completed" ]]; then
      log "Issue #$issue_num: PR #$pr_num has cancelled required check(s) but run $id is still $status; re-running once it finishes"
      return 0
    fi
  done <<< "$run_ids"
  count=$(ci_rerun_count "$issue_num" "$head_sha")
  if [[ "$count" -ge "$FACTORY_CI_RERUN_MAX" ]]; then
    return 1
  fi
  count=$((count + 1))
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN: would re-run cancelled required checks on PR #$pr_num (run(s) $(echo "$run_ids" | tr '\n' ' '), attempt $count/$FACTORY_CI_RERUN_MAX)"
    return 0
  fi
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" ciRerun "$head_sha:$count" \
    --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  log "Issue #$issue_num: PR #$pr_num required check(s) were cancelled before a runner picked them up; re-running (attempt $count/$FACTORY_CI_RERUN_MAX)"
  while IFS= read -r id; do
    gh run rerun "$id" --failed --repo JakubAnderwald/drafto >>"$LOG_FILE" 2>&1 \
      || log "WARNING: gh run rerun $id --failed refused for PR #$pr_num (counted against the re-run budget)"
  done <<< "$run_ids"
  return 0
}

# One-time (per head SHA) notice that CI could not run on the PR and the factory's
# re-runs are spent. The card stays in <where>: the code isn't the problem, so
# handing it to the Claude fix loop would only burn an attempt. It reports the
# re-runs actually spent on this head (ci_rerun_count), never the knob: with
# FACTORY_CI_RERUN_MAX=0, or the knob lowered mid-way, they differ.
comment_ci_infra_hold() {
  local issue_num="$1" pr_num="$2" head_sha="$3" pr_view="$4" where="$5"
  local sha12="${head_sha:0:12}" summary commands count tried
  [[ "$DRY_RUN" -eq 0 ]] || return 0
  issue_has_marker "$issue_num" "drafto-factory-ci-infra:$sha12" && return 0
  count=$(ci_rerun_count "$issue_num" "$head_sha")
  if [[ "$count" -gt 0 ]]; then
    tried="The factory re-ran them $count time(s) without getting a result."
  else
    tried="The factory didn't re-run them (\`FACTORY_CI_RERUN_MAX\` is $FACTORY_CI_RERUN_MAX)."
  fi
  summary=$(pr_failing_required_summary "$pr_view" | sed 's/^/- /')
  commands=$(pr_infra_rerun_ids "$pr_view" | sed 's/^/gh run rerun /; s/$/ --failed --repo JakubAnderwald\/drafto/')
  gh issue comment "$issue_num" --repo JakubAnderwald/drafto \
    --body "🏭 **CI couldn't run on \`$sha12\`.**

These required checks on PR #$pr_num were cancelled before any runner picked \
them up, so CI never judged the code:

$summary

$tried Once GitHub Actions is healthy, re-run them:

\`\`\`bash
$commands
\`\`\`

The card stays in **$where** and moves on by itself once they're green.

<!-- drafto-factory-ci-infra:$sha12 -->" >>"$LOG_FILE" 2>&1 || true
}

# Shared by --watch and --release once classify_failing_required said "infra":
# re-run the cancelled jobs, or — budget spent — comment once and hold in <where>.
recover_cancelled_ci() {
  local issue_num="$1" pr_num="$2" head_sha="$3" pr_view="$4" where="$5"
  rerun_infra_failures "$issue_num" "$pr_num" "$head_sha" "$pr_view" && return 0
  log "Issue #$issue_num: PR #$pr_num required check(s) still couldn't run after $(ci_rerun_count "$issue_num" "$head_sha") re-run(s); holding in $where"
  comment_ci_infra_hold "$issue_num" "$pr_num" "$head_sha" "$pr_view" "$where"
}

# Which beta lanes may be dispatched for an In Test card, given the platforms in
# the diff. Prints `lanes=<csv> skipped=<id>:<reason>,...` — a pure string
# function over its args + the knob globals, so it is unit-testable in isolation.
#
# Gating rationale: the post-merge lane stays Phase-D-only, but pre-merge betas
# are a separate opt-in (FACTORY_INTEST_BETA) so turning them on doesn't also
# switch on post-merge auto-dispatch. Desktop has its own knob because it builds
# from a clonefile replica of the fossil, which must be validated by one manual
# TestFlight build that opens a note before it can be trusted.
# $1 platforms JSON.
intest_beta_gate() {
  local platforms="$1"
  local mobile desktop lanes="" skipped="" free_gb
  mobile=$(echo "$platforms" | jq -r '.mobile // false' 2>/dev/null || echo "false")
  desktop=$(echo "$platforms" | jq -r '.desktop // false' 2>/dev/null || echo "false")

  if [[ "$mobile" != "true" && "$desktop" != "true" ]]; then
    echo "lanes= skipped="; return 0
  fi
  if [[ "$FACTORY_INTEST_BETA" != "1" ]]; then
    [[ "$mobile" == "true" ]] && skipped="mobile:FACTORY_INTEST_BETA=0"
    [[ "$desktop" == "true" ]] && skipped="${skipped:+$skipped,}desktop:FACTORY_INTEST_BETA=0"
    echo "lanes= skipped=$skipped"; return 0
  fi
  # Phase B is web-only by contract (parity_violation), so a native dispatch
  # there is incoherent; Phase A never gets this far.
  if [[ "$PHASE" != "C" && "$PHASE" != "D" ]]; then
    [[ "$mobile" == "true" ]] && skipped="mobile:phase-$PHASE"
    [[ "$desktop" == "true" ]] && skipped="${skipped:+$skipped,}desktop:phase-$PHASE"
    echo "lanes= skipped=$skipped"; return 0
  fi
  # A native build needs several GB of artefacts; refuse rather than die mid-build.
  free_gb=$(free_disk_gb)
  if [[ "$free_gb" =~ ^[0-9]+$ ]] && [[ "$free_gb" -lt "$FACTORY_MIN_FREE_DISK_GB" ]]; then
    [[ "$mobile" == "true" ]] && skipped="mobile:low-disk-${free_gb}GB"
    [[ "$desktop" == "true" ]] && skipped="${skipped:+$skipped,}desktop:low-disk-${free_gb}GB"
    echo "lanes= skipped=$skipped"; return 0
  fi

  [[ "$mobile" == "true" ]] && lanes="mobile"
  if [[ "$desktop" == "true" ]]; then
    if [[ "$FACTORY_INTEST_BETA_DESKTOP" == "1" ]]; then
      lanes="${lanes:+$lanes,}desktop"
    else
      skipped="desktop:FACTORY_INTEST_BETA_DESKTOP=0"
    fi
  fi
  echo "lanes=$lanes skipped=$skipped"
}

# ensure_beta_build_root / claim_beta_build_root / release_beta_build_root live in
# scripts/lib/beta-build-root.sh (sourced above), shared with nightly-support.sh.

# Learn how already-dispatched lanes actually ENDED, and re-arm the ones that
# failed.
#
# A lane runs detached for 20-40 minutes; the dispatcher is long gone by the
# time it finishes, so the lane's shell wrapper writes its exit code to
# <log>.exit (see laneShellScript in dispatch-release.mjs). This reads that:
#
#   absent    → still building; leave it alone, UNLESS the log has been silent
#               for FACTORY_LANE_STALE_MIN, which means the wrapper was killed
#               before it could record anything
#   0         → succeeded; stay suppressed
#   non-zero  → failed; drop the lane from intestBetaLanes so the next dispatch
#               retries it, and say so on the issue exactly once
#
# Without this a lane that starts fine and dies at minute 20 is indistinguishable
# from one that shipped — which is how #463's iOS build failed on an Apple HTTP
# 500 with nobody told and no retry ever attempted.
#
# A lane whose wrapper is killed outright (SIGKILL, reboot, launchd restart)
# never writes .exit at all. Treating "absent" as "still building" forever would
# suppress that lane permanently — the same silent non-delivery this whole
# mechanism exists to end — so a lane with no outcome after this long is
# declared dead and retried. Comfortably above a cold iOS+Android build.
# Give up on a lane after this many attempts for one commit. Without a cap a
# deterministically-broken lane (expired cert, genuine build break) rebuilds
# every 5 minutes for ever while the marker keeps the issue quiet about it.
FACTORY_LANE_MAX_ATTEMPTS="${FACTORY_LANE_MAX_ATTEMPTS:-3}"
if ! [[ "$FACTORY_LANE_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_LANE_MAX_ATTEMPTS='$FACTORY_LANE_MAX_ATTEMPTS'; defaulting to 3" >&2
  FACTORY_LANE_MAX_ATTEMPTS=3
fi

FACTORY_LANE_STALE_MIN="${FACTORY_LANE_STALE_MIN:-120}"
if ! [[ "$FACTORY_LANE_STALE_MIN" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_LANE_STALE_MIN='$FACTORY_LANE_STALE_MIN'; defaulting to 120" >&2
  FACTORY_LANE_STALE_MIN=120
fi

# Hard wall-clock cap on one lane, however much it logs (see
# intest_check_lane_outcomes). Observed builds take 4-40 min.
FACTORY_LANE_MAX_MIN="${FACTORY_LANE_MAX_MIN:-240}"
if ! [[ "$FACTORY_LANE_MAX_MIN" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARNING: invalid FACTORY_LANE_MAX_MIN='$FACTORY_LANE_MAX_MIN'; defaulting to 240" >&2
  FACTORY_LANE_MAX_MIN=240
fi

# Terminate a hung lane: its whole process GROUP. dispatch-release.mjs spawns
# each lane detached, so the wrapper leads its own group. That group holds
# fastlane's piped children too (xcodebuild, productbuild, the uploader), which
# never hold the log, and they must die before a retry resets the build root
# under them. The group is found through THIS attempt's log, which only this
# lane holds open, so it can never reach another card's lane. The per-root
# .lock pid could: it belongs to whoever claimed the root last. TERM first,
# then KILL whatever ignored it.
#
# lsof is resolved here, never called by bare name. On macOS it lives only in
# /usr/sbin, which the factory plist's PATH leaves out, so a bare `lsof` was
# "command not found", hidden by 2>/dev/null, and no hung lane was ever killed
# (#659).
# FACTORY_LSOF_BIN, when set, is the only candidate (like FACTORY_CR_CLI_BIN);
# otherwise PATH, then /usr/sbin/lsof. No usable lsof is logged as a WARNING
# and the function still returns 0, so the callers re-arm as before. The knob
# is read here rather than defaulted at the top level so the tests, which
# extract only this function, see it too.
kill_lane_holding_log() {
  local log_path="$1" lsof_bin tried pid pgid pgids=""
  if [[ -n "${FACTORY_LSOF_BIN:-}" ]]; then
    lsof_bin="$FACTORY_LSOF_BIN"
    tried="FACTORY_LSOF_BIN=$FACTORY_LSOF_BIN"
  else
    lsof_bin=$(command -v lsof 2>/dev/null || true)
    [[ -f "$lsof_bin" && -x "$lsof_bin" ]] || lsof_bin=/usr/sbin/lsof
    tried="PATH and /usr/sbin/lsof"
  fi
  if [[ ! -f "$lsof_bin" || ! -x "$lsof_bin" ]]; then
    log "WARNING: no usable lsof ($tried); cannot kill whatever still holds $log_path"
    return 0
  fi
  # lsof -t exits 1 when nothing holds the file, the usual case for a lane that
  # already died, so that stays silent.
  for pid in $("$lsof_bin" -t -- "$log_path" 2>/dev/null || true); do
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    # Never signal group 0/1 or our own group: that would take down the factory.
    [[ "$pgid" =~ ^[0-9]+$ && "$pgid" -gt 1 && "$pgid" != "$(ps -o pgid= -p $$ | tr -d ' ')" ]] || continue
    [[ " $pgids " == *" $pgid "* ]] || pgids="$pgids $pgid"
  done
  [[ -n "${pgids// /}" ]] || return 0
  log "Killing hung lane process group(s) holding $log_path:$pgids"
  for pgid in $pgids; do kill -TERM -- "-$pgid" 2>/dev/null || true; done
  sleep "${FACTORY_LANE_KILL_GRACE_SEC:-10}"
  for pgid in $pgids; do kill -KILL -- "-$pgid" 2>/dev/null || true; done
}

# Whole minutes since an ISO-8601 UTC timestamp, or a huge number if it can't be
# parsed (an unparseable stamp must not read as "just dispatched" and suppress a
# lane for ever). BSD date on macOS; -j -f parses rather than sets.
iso_age_min() {
  local iso="$1" epoch now
  # Validate the shape OURSELVES rather than relying on date(1) to reject
  # garbage: BSD and GNU disagree about what they will accept, so delegating
  # the check made the result platform-dependent.
  [[ "$iso" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || { echo 999999; return 0; }
  # BSD (macOS, where the factory runs) then GNU (ubuntu, where CI runs): `-j`
  # does not exist in coreutils, so a BSD-only form returned the sentinel for
  # EVERY timestamp on Linux.
  epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$iso" "+%s" 2>/dev/null \
    || date -u -d "$iso" "+%s" 2>/dev/null || echo "")
  [[ -n "$epoch" ]] || { echo 999999; return 0; }
  now=$(date -u "+%s")
  echo $(( (now - epoch) / 60 ))
}

# Attempt count for <lane> from an "a:1,b:2" CSV; 0 when absent.
lane_attempt_of() {
  local csv="$1" lane="$2" pair
  for pair in $(echo "$csv" | tr ',' ' '); do
    case "$pair" in "${lane}:"*) echo "${pair#*:}"; return 0 ;; esac
  done
  echo 0
}

# Set <lane> to <n> in an "a:1,b:2" CSV, preserving the other entries.
lane_attempt_set() {
  local csv="$1" lane="$2" n="$3" pair out=""
  for pair in $(echo "$csv" | tr ',' ' '); do
    case "$pair" in
      ""|"${lane}:"*) ;;
      *) out="${out:+$out,}$pair" ;;
    esac
  done
  echo "${out:+$out,}${lane}:${n}"
}

# $1 issue, $2 head sha, $3 pr number.
intest_check_lane_outcomes() {
  local issue_num="$1" sha="$2" pr_num="${3:-}"
  local state_json prior_sha prior_lanes prior_attempts dispatched_at lane exit_file
  local log_file_path code lane_attempt kept="" changed=0 give_up
  local reason new_attempts attempts_changed=0 lane_at_csv lane_started lane_age_min

  state_json=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" \
    --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo "{}")
  prior_sha=$(echo "$state_json" | jq -r '.intestBetaSha // ""' 2>/dev/null || echo "")
  prior_lanes=$(echo "$state_json" | jq -r '.intestBetaLanes // ""' 2>/dev/null || echo "")
  dispatched_at=$(echo "$state_json" | jq -r '.intestBetaAt // ""' 2>/dev/null || echo "")
  prior_attempts=$(echo "$state_json" | jq -r '.intestBetaAttempts // ""' 2>/dev/null || echo "")
  lane_at_csv=$(echo "$state_json" | jq -r '.intestBetaLaneAt // ""' 2>/dev/null || echo "")
  new_attempts="$prior_attempts"
  # Only meaningful for the commit currently under test.
  [[ -n "$sha" && "$prior_sha" == "$sha" && -n "$prior_lanes" ]] || return 0

  for lane in $(echo "$prior_lanes" | tr ',' ' '); do
    [[ -n "$lane" ]] || continue
    # Same scoping key the dispatcher used, so we read OUR dispatch's outcome
    # and never a concurrent card's or a post-merge lane's.
    # Per ATTEMPT, not per commit: a lane declared stale may still be alive
    # (the check is a timeout, not a death certificate) and would otherwise
    # write its exit code over the retry that replaced it.
    lane_attempt=$(lane_attempt_of "$prior_attempts" "$lane")
    if [[ "$lane_attempt" -lt 1 ]]; then
      # No recorded attempt — state written before intestBetaAttempts existed.
      # Treat it as attempt 1 and PERSIST that, because intest_dispatch_betas
      # derives the next attempt number from this same field. Left unwritten it
      # computes 0+1=1 and re-uses the artefact paths of the attempt that just
      # failed, while this function has already logged "re-arming attempt 2" —
      # one lane, two numbers, and a stale .exit the next check would misread.
      lane_attempt=1
      new_attempts=$(lane_attempt_set "$new_attempts" "$lane" 1)
      attempts_changed=1
    fi
    log_file_path="$LOG_DIR/beta-lane-${lane}-${issue_num}-${sha:0:12}-a${lane_attempt}.log"
    exit_file="${log_file_path}.exit"
    reason=""
    # This lane's own age. intestBetaAt is shared and reset by any lane's
    # re-dispatch, so it is only the fallback for state written before
    # intestBetaLaneAt existed.
    lane_started=$(lane_attempt_of "$lane_at_csv" "$lane")
    if [[ "$lane_started" =~ ^[1-9][0-9]*$ ]]; then
      lane_age_min=$(( ($(date +%s) - lane_started) / 60 ))
    elif [[ -n "$dispatched_at" ]]; then
      lane_age_min=$(iso_age_min "$dispatched_at")
    else
      lane_age_min=0
    fi
    if [[ ! -f "$exit_file" ]]; then
      # No outcome yet. Still building, or dead without a trace?
      #
      # Judge by the LOG's mtime, i.e. silence rather than elapsed time — a real
      # build chatters constantly (the observed ones ran 4-10 min), so 120 min of
      # nothing means the wrapper is gone. If the log is missing entirely (the
      # openSync fell back to "ignore"), fall back to how long ago the dispatch
      # was recorded; otherwise a lane with neither artefact would be suppressed
      # for ever — the exact silent non-delivery this mechanism exists to end.
      #
      # Silence alone misses a lane that is alive but stuck in a loop that
      # keeps logging: #623's desktop lane logged "Waiting for App Store Connect
      # to finish processing" every 32 s for 3 days, so its log never went
      # stale. It held the desktop build root the whole time. So a lane still
      # running FACTORY_LANE_MAX_MIN after dispatch is killed and counts as
      # failed, however chatty it is.
      if [[ -f "$log_file_path" ]]; then
        if [[ -n "$(find "$log_file_path" -mmin "+$FACTORY_LANE_STALE_MIN" 2>/dev/null)" ]]; then
          # Usually already dead, but a silent group that is still alive would
          # hold the root lock, or outlive a retry that resets the root under it.
          [[ "$DRY_RUN" -eq 0 ]] && kill_lane_holding_log "$log_file_path"
          reason="produced no output for over ${FACTORY_LANE_STALE_MIN} min and never recorded an exit code (killed?)"
        elif [[ "$lane_age_min" -gt "$FACTORY_LANE_MAX_MIN" ]]; then
          [[ "$DRY_RUN" -eq 0 ]] && kill_lane_holding_log "$log_file_path"
          reason="was still running ${FACTORY_LANE_MAX_MIN}+ min after dispatch with no exit code (hung; killed)"
        else
          kept="${kept:+$kept,}$lane"        # still building
          continue
        fi
      elif [[ -n "$lane_started$dispatched_at" ]] && [[ "$lane_age_min" -gt "$FACTORY_LANE_STALE_MIN" ]]; then
        reason="left no log and no exit code ${FACTORY_LANE_STALE_MIN}+ min after dispatch (killed before it could write?)"
      else
        kept="${kept:+$kept,}$lane"          # too early to call
        continue
      fi
    else
      # No pipe: `tr | head` hands tr SIGPIPE once head has its bytes, so the
      # pipeline exits 141 and `set -o pipefail` would kill the whole tick.
      code=$(tr -cd '0-9' <"$exit_file" 2>/dev/null || true)
      code="${code:0:4}"
      if [[ "$code" == "0" ]]; then
        kept="${kept:+$kept,}$lane"          # succeeded — stay suppressed
        # A retry that succeeds must retract its own failure notice. GitHub
        # comments are append-only, so an earlier "the mobile beta build failed"
        # stays the last word on the issue unless something supersedes it — which
        # is precisely what a tester read on #463 while a working build sat on
        # TestFlight. Marker-guarded, so it posts once per lane per commit.
        if [[ "$DRY_RUN" -eq 0 ]] \
          && issue_has_marker "$issue_num" "drafto-factory-beta-failed:${lane}:${sha:0:12}" \
          && ! issue_has_marker "$issue_num" "drafto-factory-beta-recovered:${lane}:${sha:0:12}"; then
          gh issue comment "$issue_num" --repo JakubAnderwald/drafto \
            --body "🏭 **The \`$lane\` beta build succeeded on retry.**

Disregard the earlier \`$lane\` failure notice for \`${sha:0:12}\` — a later attempt \
completed and the build has been uploaded to its beta channel.

<!-- drafto-factory-beta-recovered:${lane}:${sha:0:12} -->" >>"$LOG_FILE" 2>&1 || true
        fi
        continue
      fi
      if [[ -z "$code" ]]; then
        # Present but empty: the wrapper is mid-write, or the write was cut
        # short. Neither is evidence of failure — look again next tick, and let
        # the staleness timeout catch it if it never resolves.
        kept="${kept:+$kept,}$lane"
        continue
      fi
      reason="exited $code"
    fi

    changed=1
    give_up=0
    [[ "$lane_attempt" -ge "$FACTORY_LANE_MAX_ATTEMPTS" ]] && give_up=1
    if [[ "$give_up" -eq 1 ]]; then
      log "Issue #$issue_num: beta lane '$lane' $reason for ${sha:0:12}; attempt $lane_attempt of $FACTORY_LANE_MAX_ATTEMPTS — giving up"
      # Keep it in the confirmed set so nothing re-dispatches it: the retry
      # budget for this commit is spent. A new commit clears the slate.
      kept="${kept:+$kept,}$lane"
    else
      log "Issue #$issue_num: beta lane '$lane' $reason for ${sha:0:12}; re-arming attempt $((lane_attempt + 1))"
    fi
    if [[ "$DRY_RUN" -eq 0 ]] \
      && ! issue_has_marker "$issue_num" "drafto-factory-beta-failed:${lane}:${sha:0:12}"; then
      gh issue comment "$issue_num" --repo JakubAnderwald/drafto \
        --body "🏭 **The \`$lane\` beta build failed.**

It $reason while building PR #${pr_num:-?} at \`${sha:0:12}\` (attempt $lane_attempt of \
$FACTORY_LANE_MAX_ATTEMPTS), so the build promised above never landed. \
$(if [[ "$give_up" -eq 1 ]]; then \
    printf '%s' "The retry budget for this commit is now spent — no further attempts will run. Push a fix, or build it by hand."; \
  elif [[ "$FACTORY_INTEST_BETA" != "1" ]]; then \
    printf '%s' "Pre-merge beta dispatch is currently switched off, so no retry will run until an operator re-enables it."; \
  else \
    printf '%s' "The factory will retry on the next cycle, subject to the same disk / knob gates as the first attempt."; \
  fi)

Log on the build machine: \`$log_file_path\`

<!-- drafto-factory-beta-failed:${lane}:${sha:0:12} -->" >>"$LOG_FILE" 2>&1 || true
    fi
  done

  if [[ "$changed" -eq 1 && "$DRY_RUN" -eq 0 ]]; then
    # Dropping the lane from the confirmed set is what re-arms the retry.
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" \
      intestBetaLanes "$kept" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  fi
  # Backfilled legacy attempt numbers, so the dispatcher agrees with what was
  # logged above. Written even when nothing was re-armed: a lane still building
  # needs the same backfill before ITS outcome is read.
  if [[ "$attempts_changed" -eq 1 && "$DRY_RUN" -eq 0 ]]; then
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" \
      intestBetaAttempts "$new_attempts" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  fi
  return 0
}

# Dispatch pre-merge beta builds for an In Test card, so a native change is
# testable BEFORE the merge gate rather than only after it.
#
# Idempotency is SHA-keyed (intestBetaSha), not marker-keyed: a marker is
# monotonic, which is right post-merge (one merge, one build) but wrong here,
# where In Test → feedback → In Test must produce a build of the new code.
# Prints the betaDispatch JSON the In Test comment reports from.
# $1 issue, $2 pr-num, $3 sha, $4 platforms JSON.
intest_dispatch_betas() {
  local issue_num="$1" pr_num="$2" sha="$3" platforms="$4"
  local gate lanes skipped prior_sha root_flags="" mobile_root desktop_root
  local dispatch_json="" dispatched skipped_json manual="[]"

  gate=$(intest_beta_gate "$platforms")
  lanes=$(echo "$gate" | sed -E 's/.*lanes=([^ ]*).*/\1/')
  skipped=$(echo "$gate" | sed -E 's/.*skipped=([^ ]*).*/\1/')

  # Manual commands for every lane we are NOT building, so the comment always
  # tells the tester how to get that platform themselves.
  # Keyed by platform: with both natives skipped an unkeyed list leaves the
  # scenario writer guessing which command belongs to which platform.
  #
  # The desktop command targets the dedicated fossil replica, NOT the primary
  # checkout: telling a human to `git checkout` there would move the operator's
  # working tree (and the fossil we clone from) onto a PR branch.
  manual=$(jq -nc --arg skipped "$skipped" --arg issue "$issue_num" \
    --arg desktopRoot "$BETA_DESKTOP_ROOT" '
    [ ($skipped | split(",") | .[] | select(length > 0) | split(":")[0]) ]
    | map(if . == "desktop" then
            { id: ., command:
              ("cd " + $desktopRoot + " && git fetch origin && git checkout --detach origin/factory/issue-" + $issue +
               " && cd apps/desktop && pnpm release:beta   # NEVER pnpm install here (desktop fossil)") }
          else
            { id: ., command:
              ("git worktree add ../drafto-" + $issue + " factory/issue-" + $issue +
               " && cd ../drafto-" + $issue + " && pnpm install && bash scripts/worktree-bootstrap.sh" +
               " && cd apps/mobile && pnpm release:beta:all") }
          end)' 2>/dev/null || echo "[]")

  skipped_json=$(jq -nc --arg skipped "$skipped" '
    [ ($skipped | split(",") | .[] | select(length > 0)
        | split(":") | { id: .[0], reason: (.[1:] | join(":")) }) ]' 2>/dev/null || echo "[]")

  if [[ -z "$lanes" ]]; then
    [[ -n "$skipped" ]] && logerr "Issue #$issue_num: no pre-merge beta lanes ($skipped)"
    jq -nc --argjson skipped "$skipped_json" --argjson manual "$manual" \
      '{ dispatched: [], skipped: $skipped, manualCommands: $manual }'
    return 0
  fi

  # PER-LANE idempotency. `intestBetaLanes` is the set of lanes CONFIRMED
  # STARTED for `intestBetaSha` — so a lane that never started, or that started
  # and later failed (see intest_check_lane_outcomes, which removes it), is
  # re-dispatched while a healthy sibling is left alone. A single shared SHA
  # used to suppress both: mobile succeeding hid a desktop failure entirely.
  local prior_lanes="" prior_attempts="" state_json="" want to_dispatch="" new_attempts="" new_lane_at=""
  local lane_attempt log_key
  state_json=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" \
    --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo "{}")
  prior_sha=$(echo "$state_json" | jq -r '.intestBetaSha // ""' 2>/dev/null || echo "")
  prior_lanes=$(echo "$state_json" | jq -r '.intestBetaLanes // ""' 2>/dev/null || echo "")
  prior_attempts=$(echo "$state_json" | jq -r '.intestBetaAttempts // ""' 2>/dev/null || echo "")
  # A different commit invalidates every prior lane AND its retry budget.
  if [[ -z "$sha" || "$prior_sha" != "$sha" ]]; then
    prior_lanes=""
    prior_attempts=""
  fi

  for want in $(echo "$lanes" | tr ',' ' '); do
    [[ -n "$want" ]] || continue
    case ",$prior_lanes," in
      *",$want,"*) ;;                                   # already started for this SHA
      *) to_dispatch="${to_dispatch:+$to_dispatch,}$want" ;;
    esac
  done

  if [[ -z "$to_dispatch" ]]; then
    logerr "Issue #$issue_num: beta lane(s) '$lanes' already dispatched for ${sha:0:12}; nothing to do"
    # Report them as dispatched, not as an empty list: a scenario written on a
    # later tick would otherwise tell the tester to build locally when a beta
    # has in fact already shipped.
    jq -nc --arg lanes "$prior_lanes" --argjson skipped "$skipped_json" --argjson manual "$manual" '
      { dispatched: [ ($lanes | split(",") | .[] | select(length > 0) | { id: ., alreadyRunning: true }) ],
        skipped: $skipped, manualCommands: $manual }'
    return 0
  fi
  [[ "$to_dispatch" == "$lanes" ]] \
    || logerr "Issue #$issue_num: re-dispatching only the missing lane(s) '$to_dispatch' (already started: '${prior_lanes:-none}')"
  lanes="$to_dispatch"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    logerr "DRY-RUN: would dispatch pre-merge beta lane(s) '$lanes' for #$issue_num at ${sha:0:12}"
    jq -nc --arg lanes "$lanes" --argjson skipped "$skipped_json" --argjson manual "$manual" '
      { dispatched: [ ($lanes | split(",") | .[] | select(length > 0) | { id: ., dryRun: true }) ],
        skipped: $skipped, manualCommands: $manual }'
    return 0
  fi

  if [[ ",$lanes," == *",mobile,"* ]]; then
    mobile_root=$(ensure_beta_build_root mobile "$sha") || mobile_root=""
    [[ -n "$mobile_root" ]] || logerr "WARNING: mobile beta build root unavailable for #$issue_num"
  fi
  if [[ ",$lanes," == *",desktop,"* ]]; then
    desktop_root=$(ensure_beta_build_root desktop "$sha") || desktop_root=""
    [[ -n "$desktop_root" ]] || logerr "WARNING: desktop beta build root unavailable for #$issue_num"
  fi
  if [[ -z "${mobile_root:-}" && -z "${desktop_root:-}" ]]; then
    logerr "ERROR: no beta build root available for #$issue_num; skipping dispatch"
    jq -nc --argjson skipped "$skipped_json" --argjson manual "$manual" \
      '{ dispatched: [], skipped: $skipped, manualCommands: $manual }'
    return 0
  fi
  # dispatch-premerge resolves each lane's root: mobile from --repo-root, desktop
  # from --desktop-root (fossil-asserted). Only pass lanes whose root is ready.
  [[ -z "${mobile_root:-}" ]] && lanes=$(echo "$lanes" | sed -E 's/(^|,)mobile(,|$)/\1\2/; s/^,|,$//')
  [[ -z "${desktop_root:-}" ]] && lanes=$(echo "$lanes" | sed -E 's/(^|,)desktop(,|$)/\1\2/; s/^,|,$//')
  root_flags="--repo-root ${mobile_root:-$REPO_ROOT}"
  [[ -n "${desktop_root:-}" ]] && root_flags="$root_flags --desktop-root $desktop_root"

  # One dispatch = one attempt number, and the artefact path carries it. All
  # lanes in a single dispatch share a key; that is fine because a lane is only
  # ever re-dispatched alone, after being dropped from the confirmed set.
  lane_attempt=0
  for want in $(echo "$to_dispatch" | tr ',' ' '); do
    [[ -n "$want" ]] || continue
    local n; n=$(lane_attempt_of "$prior_attempts" "$want")
    [[ "$n" -gt "$lane_attempt" ]] && lane_attempt="$n"
  done
  lane_attempt=$((lane_attempt + 1))
  log_key="${issue_num}-${sha:0:12}-a${lane_attempt}"

  # shellcheck disable=SC2086 # root_flags is a deliberately word-split flag list
  dispatch_json=$(node "$SCRIPT_DIR/lib/dispatch-release.mjs" dispatch-premerge \
    --platforms "$lanes" --only "$lanes" $root_flags \
    --issue "$issue_num" --pr "$pr_num" --sha "$sha" \
    --log-dir "$LOG_DIR" --log-key "$log_key" 2>>"$LOG_FILE" || echo "")
  # Only lanes whose process the OS CONFIRMED started land in .dispatched; a
  # lane that could not start is in .failed and must not suppress its retry.
  dispatched=$(echo "$dispatch_json" | jq -r '[.dispatched[]?.id] | join(", ")' 2>/dev/null || echo "")
  local lane_failed confirmed_csv merged_lanes
  lane_failed=$(echo "$dispatch_json" | jq -r '[.failed[]?.id] | join(", ")' 2>/dev/null || echo "")
  if [[ -n "$lane_failed" ]]; then
    logerr "WARNING: Issue #$issue_num: beta lane(s) failed to start: $(echo "$dispatch_json" | jq -r '[.failed[]? | "\(.id) (\(.reason)) log=\(.logPath // "?")"] | join("; ")' 2>/dev/null)"
  fi
  if [[ -n "$dispatched" ]]; then
    # Log pid + per-lane log path so a lane that dies later is traceable; its
    # exit code lands in <log>.exit and intest_check_lane_outcomes reads it.
    logerr "Issue #$issue_num: dispatched pre-merge beta lane(s): $dispatched at ${sha:0:12} — $(echo "$dispatch_json" | jq -r '[.dispatched[]? | "\(.id) pid=\(.pid // "?") log=\(.logPath // "?")"] | join("; ")' 2>/dev/null)"
    # Union with lanes already confirmed for this SHA, so re-dispatching one
    # missing lane doesn't drop the sibling that is already building.
    confirmed_csv=$(echo "$dispatch_json" | jq -r '[.dispatched[]?.id] | join(",")' 2>/dev/null || echo "")
    # Mark each root busy for the lane's lifetime so a concurrent card (or the
    # post-merge lane) can't reset the tree out from under a running build.
    while IFS=$'\t' read -r lid lpid; do
      [[ -n "$lid" ]] && claim_beta_build_root "$lid" "$lpid"
    done < <(echo "$dispatch_json" | jq -r '.dispatched[]? | "\(.id)\t\(.pid // "")"' 2>/dev/null || true)
    merged_lanes=$(printf '%s\n%s\n' "${prior_lanes//,/$'\n'}" "${confirmed_csv//,/$'\n'}" \
      | grep -v '^$' | sort -u | paste -sd, -)
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" \
      intestBetaSha "$sha" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" \
      intestBetaAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" \
      intestBetaLanes "$merged_lanes" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    new_attempts="$prior_attempts"
    for want in $(echo "$confirmed_csv" | tr ',' ' '); do
      [[ -n "$want" ]] || continue
      new_attempts=$(lane_attempt_set "$new_attempts" "$want" "$lane_attempt")
    done
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" \
      intestBetaAttempts "$new_attempts" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    # Per-lane start time, for the FACTORY_LANE_MAX_MIN cap. Only the lanes
    # started NOW are stamped; a sibling still building keeps its own clock.
    new_lane_at=$(echo "$state_json" | jq -r '.intestBetaLaneAt // ""' 2>/dev/null || echo "")
    for want in $(echo "$confirmed_csv" | tr ',' ' '); do
      [[ -n "$want" ]] || continue
      new_lane_at=$(lane_attempt_set "$new_lane_at" "$want" "$(date +%s)")
    done
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" \
      intestBetaLaneAt "$new_lane_at" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  else
    # Nothing started — deliberately record NO SHA, so the next tick retries.
    logerr "WARNING: pre-merge beta dispatch started no lanes for #$issue_num; leaving retry armed"
  fi
  # ensure_beta_build_root locked each prepared root with THIS process's pid.
  # A lane that started has taken its lock over (claim above); drop any lock
  # still ours — a lane refused or unable to start — so the nightly support
  # runner isn't locked out of the root for the rest of this tick.
  [[ -n "${mobile_root:-}" ]] && release_beta_build_root mobile
  [[ -n "${desktop_root:-}" ]] && release_beta_build_root desktop
  # Merge bash-side skips (gate) with node-side refusals (e.g. fossil assertion).
  jq -nc --argjson d "$(echo "${dispatch_json:-{\}}" | jq -c '.dispatched // []' 2>/dev/null || echo '[]')" \
    --argjson gateSkipped "$skipped_json" \
    --argjson laneSkipped "$(echo "${dispatch_json:-{\}}" | jq -c '(.skipped // []) + [ (.failed // [])[] | { id: .id, reason: ("failed to start: " + .reason) } ]' 2>/dev/null || echo '[]')" \
    --argjson manual "$manual" \
    '{ dispatched: $d, skipped: ($gateSkipped + $laneSkipped), manualCommands: $manual }'
}

# Deterministic In Test comment. Used when the scenario writer times out, is
# blocked, or posts nothing — the card is already In Test by then, so the
# reporter must still get something usable. Platform-aware for the same reason
# the model's version is: a Vercel link on a native-only PR tests nothing.
# $1 issue, $2 pr-num, $3 preview URL, $4 advisory, $5 head sha, $6 platforms JSON,
# $7 betaDispatch JSON (optional), $8 CodeRabbit coverage note (optional).
# INTEST_STAGE=testing (set by the Testing-entry hand-off, ADR-0053) swaps the
# title for the "verifying now" one; the markers stay the same.
intest_fallback_comment() {
  local issue_num="$1" pr_num="$2" preview_url="$3" advisory="$4" head_sha="$5" platforms="$6"
  local beta="${7:-}" cr_note="${8:-}"
  local web mobile desktop dispatched build_note="" advisory_note=""
  local title="🏭 **Ready to test — In Test.**" stage_note=""
  if [[ "${INTEST_STAGE:-intest}" == "testing" ]]; then
    title="🏭 **Test scenario — verifying now (Testing).**"
    stage_note=" The factory is running its own checks on it first; the card moves to \
**In Test** with a verification report when they finish (evidence, not a gate)."
  fi
  web=$(echo "$platforms" | jq -r '.web // false' 2>/dev/null || echo "false")
  mobile=$(echo "$platforms" | jq -r '.mobile // false' 2>/dev/null || echo "false")
  desktop=$(echo "$platforms" | jq -r '.desktop // false' 2>/dev/null || echo "false")
  dispatched=$(echo "${beta:-{\}}" | jq -r '[.dispatched[]?.id] | join(",")' 2>/dev/null || echo "")
  if [[ "$web" == "true" && -n "$preview_url" ]]; then
    build_note="$build_note
- **Web** — Vercel preview: $preview_url"
  fi
  if [[ "$mobile" == "true" ]]; then
    if [[ ",$dispatched," == *",mobile,"* ]]; then
      build_note="$build_note
- **iOS / Android** — beta builds are building now from PR #$pr_num${head_sha:+ (\`${head_sha:0:12}\`)}; you'll get a follow-up comment with each build number (~20-40 min)."
    else
      build_note="$build_note
- **iOS / Android** — run the branch locally: worktree \`factory/issue-$issue_num\`, \`pnpm install\`, \`bash scripts/worktree-bootstrap.sh\`, then \`cd apps/mobile && pnpm ios\` (or \`pnpm android\`)."
    fi
  fi
  if [[ "$desktop" == "true" ]]; then
    if [[ ",$dispatched," == *",desktop,"* ]]; then
      build_note="$build_note
- **macOS** — a TestFlight build is building now from PR #$pr_num${head_sha:+ (\`${head_sha:0:12}\`)}; you'll get a follow-up comment with the build number (~20-40 min)."
    else
      build_note="$build_note
- **macOS** — build ONLY from the primary checkout \`/Users/jakub/code/drafto\` (\`git checkout factory/issue-$issue_num\`, **never** \`pnpm install\` — the desktop fossil), then \`pnpm --filter @drafto/desktop start\`."
    fi
  fi
  [[ -n "$advisory" ]] && advisory_note="

⚠️ Advisory (non-required) checks are not green: $advisory. They don't block the merge, but are worth a glance before Approving."
  # The CodeRabbit lane's coverage note (ADR-0036) arrives as its own argument,
  # never inside $advisory: it is not a check, so it gets its own line and its
  # own wording instead of being listed among the reds.
  if [[ -n "$cr_note" ]]; then
    advisory_note="$advisory_note

ℹ️ $cr_note — not a failing check: this commit may have had no automated CodeRabbit review, so it deserves a closer look before Approving."
  fi
  gh issue comment "$issue_num" --repo JakubAnderwald/drafto \
    --body "$title

CI is green on PR #$pr_num${head_sha:+ (\`${head_sha:0:12}\`)}.$stage_note An automated test \
scenario couldn't be generated this time — work from the PR diff.

How to get a build:$build_note

Then drag the card to **Approved** to merge and ship, or comment what you want \
changed and the factory revises on the same branch.$advisory_note

<!-- drafto-factory-in-test -->
<!-- drafto-factory-test-scenario -->
<!-- drafto-factory-scenario-fallback -->
<!-- drafto-factory-scenario-sha:$head_sha -->" >>"$LOG_FILE" 2>&1 || true
}

# Record the head SHA the last In Test comment was written for. EVERY path that
# posts a comment must call this: the watch refresh re-fires the hand-off
# whenever intestCommentSha != headRefOid, so a path that posts and returns
# without recording would re-post the same comment every 5-minute tick.
intest_record_comment_sha() {
  local issue_num="$1" head_sha="${2:-}"
  [[ -n "$head_sha" ]] || return 0
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" \
    intestCommentSha "$head_sha" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
}

# In Test hand-off: write the human test scenario for a card that just reached
# In Test (or whose head SHA changed since the last one) and post it as the
# In Test comment.
#
# The card is ALREADY In Test when this runs — this is commentary, not a state
# transition, so every failure path here degrades to the deterministic fallback
# comment and NEVER bumps the retry budget or blocks the card. A card whose
# scenario failed is still a green, testable card.
#
# $1 issue, $2 pr-num, $3 pr obj, $4 preview URL, $5 advisory, $6 head sha,
# $7 changed files, $8 platforms JSON.
intest_handoff() {
  local issue_num="$1" pr_num="$2" pr_obj="$3" preview_url="$4" advisory="$5"
  local head_sha="$6" diff_files="$7" platforms="$8"
  # $9: the betaDispatch JSON from intest_dispatch_betas. Passed IN rather than
  # computed here, so a dispatch blocked by a transient condition can be retried
  # on a later tick without also rewriting the scenario. See the sweep.
  local beta_json="${9:-}"
  # ${10}: the CodeRabbit lane's one-line coverage note for $head_sha (ADR-0036),
  # "" when there is none. Its own argument, never folded into $advisory: it is
  # not a failing check, and both the scenario writer (bundle.crCoverageNote) and
  # the fallback comment render it apart from the reds.
  local cr_note="${10:-}"
  # Default here rather than in the expansion: a `}` inside ${..:-..} has to be
  # escaped, and the escape leaks a literal backslash into the value — which
  # produced INVALID JSON for the designated fallback payload.
  [[ -n "$beta_json" ]] || beta_json='{"dispatched":[],"skipped":[],"manualCommands":[]}'
  local issue_record comments_json plan_json pr_diff bundle claude_input
  local out_file start_iso exit_code=0 summary_line action

  if [[ ! -f "$INTEST_PROMPT_FILE" ]]; then
    log "WARNING: In Test prompt missing ($INTEST_PROMPT_FILE); posting fallback comment"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      intest_fallback_comment "$issue_num" "$pr_num" "$preview_url" "$advisory" "$head_sha" "$platforms" "${beta_json:-}" "$cr_note"
      intest_record_comment_sha "$issue_num" "$head_sha"
    fi
    return 0
  fi
  if ! issue_record=$(fetch_issue_record "$issue_num"); then
    log "WARNING: fetch_issue_record failed for #$issue_num (In Test hand-off); posting fallback"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      intest_fallback_comment "$issue_num" "$pr_num" "$preview_url" "$advisory" "$head_sha" "$platforms" "${beta_json:-}" "$cr_note"
      intest_record_comment_sha "$issue_num" "$head_sha"
    fi
    return 0
  fi
  comments_json=$(fetch_issue_comments "$issue_num" 2>>"$LOG_FILE" || echo "[]")
  [[ -n "$comments_json" ]] || comments_json="[]"
  plan_json=$(extract_plan_comment "$comments_json")
  [[ -n "$plan_json" ]] || plan_json="null"

  [[ -n "$beta_json" ]] || beta_json='{"dispatched":[],"skipped":[],"manualCommands":[]}'
  # The diff is the scenario's ground truth. An empty one still produces a
  # usable (if thinner) scenario, so a failure here is not fatal.
  pr_diff=$(gh pr diff "$pr_num" --repo JakubAnderwald/drafto 2>>"$LOG_FILE" || echo "")

  if ! bundle=$(build_intest_bundle "$issue_record" "$plan_json" "$pr_obj" "$pr_diff" \
      "$diff_files" "$platforms" "$preview_url" "$advisory" "$beta_json" \
      "$head_sha" "$comments_json" "$cr_note"); then
    log "ERROR: build_intest_bundle failed for #$issue_num; posting fallback"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      intest_fallback_comment "$issue_num" "$pr_num" "$preview_url" "$advisory" "$head_sha" "$platforms" "${beta_json:-}" "$cr_note"
      intest_record_comment_sha "$issue_num" "$head_sha"
    fi
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    # Bundles carry the issue body + comments (PII): stdout only, never the log.
    log "DRY-RUN: In Test bundle for #$issue_num (printed to stdout only); would post a scenario comment"
    echo "$bundle"
    return 0
  fi

  claude_input=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
    "$(cat "$INTEST_PROMPT_FILE")" "$bundle")
  log "Invoking claude for #$issue_num (In Test scenario, cap ${INTEST_TIMEOUT_SEC}s, effort=$FACTORY_PLAN_EFFORT)"
  out_file=$(mktemp -t factory-agent-intest.XXXXXX)
  start_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Read-only stage: runs in the factory checkout on main, no worktree, no slot.
  ( cd "$REPO_ROOT" && CLAUDE_CALL_TIMEOUT_SEC="$INTEST_TIMEOUT_SEC" \
      node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$claude_input" --dangerously-skip-permissions --effort "$FACTORY_PLAN_EFFORT" --no-chrome --strict-mcp-config ) \
      >"$out_file" 2>>"$LOG_FILE" || exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    [[ $exit_code -eq 124 ]] && log "WARNING: claude timed out writing the In Test scenario for #$issue_num" \
      || log "ERROR: claude exited $exit_code writing the In Test scenario for #$issue_num"
    cat "$out_file" >>"$LOG_FILE" 2>/dev/null || true
    # A session limit is worth pausing the whole factory for; anything else just
    # falls back. Either way the retry budget is untouched — this is commentary.
    if [[ $exit_code -ne 124 ]] && check_session_limit "$REPO_ROOT" "$start_iso"; then
      rm -f "$out_file"
      intest_fallback_comment "$issue_num" "$pr_num" "$preview_url" "$advisory" "$head_sha" "$platforms" "${beta_json:-}" "$cr_note"
      intest_record_comment_sha "$issue_num" "$head_sha"
      pause_for_session_limit
      return 0
    fi
    rm -f "$out_file"
    intest_fallback_comment "$issue_num" "$pr_num" "$preview_url" "$advisory" "$head_sha" "$platforms" "${beta_json:-}" "$cr_note"
    intest_record_comment_sha "$issue_num" "$head_sha"
    return 0
  fi
  cat "$out_file" >>"$LOG_FILE"
  summary_line=$(grep -E '^issue=[0-9]+ action=[a-z]+ comment=[^ ]+$' "$out_file" | tail -1 || true)
  rm -f "$out_file"
  action=$(echo "${summary_line:-}" | sed -E 's/.*action=([^ ]+).*/\1/')

  # Trust the marker, not the directive line: the comment either exists or it
  # doesn't. A model that claims `commented` without posting still gets a
  # fallback, and one that posted without emitting a parseable line doesn't get
  # a duplicate.
  if issue_has_marker "$issue_num" "drafto-factory-test-scenario"; then
    log "Issue #$issue_num: test scenario posted (action=${action:-unknown})"
  else
    log "Issue #$issue_num: no test-scenario comment found (action=${action:-none}); posting fallback"
    intest_fallback_comment "$issue_num" "$pr_num" "$preview_url" "$advisory" "$head_sha" "$platforms" "${beta_json:-}" "$cr_note"
  fi
  intest_record_comment_sha "$issue_num" "$head_sha"
  return 0
}

# ── Browser runner (ADR-0051) ─────────────────────────────────────────────
# One locked-down Claude-in-Chrome session per call, driving the Mac mini's own
# Chrome profile (the operator's real sign-ins). Locked down because of that
# profile: dontAsk mode with no built-in tools (no Bash, no files, no gh, no
# subagents), and a guard hook (scripts/lib/browser-guard.mjs) that pins the
# browser device, keeps the session to its own tabs and denies any URL off the
# run's exact target origin. The runner can only print; bash scans that output
# for secrets and does any posting itself.

browser_kind_enabled() {
  [[ "$FACTORY_BROWSER" == "1" ]] || return 1
  [[ ",$FACTORY_BROWSER_KINDS," == *",$1,"* ]]
}

# preview_url_for_sha <sha> — the per-commit Vercel preview URL, from the GitHub
# Deployments API. Not the PR-comment scrape the In Test hand-off uses: that
# accepts any comment whose author matches /vercel/ and returns the branch
# alias, which is fine for a link a person clicks but not for the one origin an
# unattended browser is allowed to open. Prints nothing and fails when there is
# no successful vercel[bot] deployment for exactly this commit yet (1), or when
# GitHub couldn't be asked (2): the verify lane's preview wait counts only the
# first.
preview_url_for_sha() {
  local sha="$1" dep_id url
  dep_id=$(gh api "repos/JakubAnderwald/drafto/deployments?sha=$sha&environment=Preview" \
    --jq '[.[] | select(.creator.login == "vercel[bot]")][0].id // empty' 2>>"$LOG_FILE") || return 2
  [[ "$dep_id" =~ ^[0-9]+$ ]] || return 1
  url=$(gh api "repos/JakubAnderwald/drafto/deployments/$dep_id/statuses" \
    --jq '[.[] | select(.state == "success")][0].environment_url // empty' 2>>"$LOG_FILE") || return 2
  url="${url%/}"
  [[ "$url" =~ ^https://drafto-[a-z0-9-]+-jakubanderwalds-projects\.vercel\.app$ ]] || return 1
  printf '%s\n' "$url"
}

# head_has_signin_route <sha> — does this commit have the preview sign-in route?
# 0 yes; 1 no (GitHub answered 404 for the file at that ref); 2 couldn't tell.
# Callers fail open on 2: a GitHub hiccup must not quietly drop a browser run
# that would have worked.
head_has_signin_route() {
  local err
  # The factory runs main, so the route is in this checkout. If it isn't, the
  # path is out of date (the route moved), and every branch would look stale.
  if [[ ! -f "$REPO_ROOT/$FACTORY_SIGNIN_ROUTE_PATH" ]]; then
    log "WARNING: $FACTORY_SIGNIN_ROUTE_PATH isn't in $REPO_ROOT; skipping the stale-branch check until FACTORY_SIGNIN_ROUTE_PATH is fixed"
    return 2
  fi
  if err=$(gh api "repos/JakubAnderwald/drafto/contents/$FACTORY_SIGNIN_ROUTE_PATH?ref=$1" --silent 2>&1 >/dev/null); then
    return 0
  fi
  # An unknown or not-yet-replicated SHA is a 404 too ("No commit found for the
  # ref"), but it says nothing about the file.
  [[ "$err" == *"HTTP 404"* && "$err" != *"No commit found"* ]] && return 1
  printf '%s\n' "$err" >>"$LOG_FILE"
  return 2
}

# Feed one runner outcome to the soft health tracker (browser-health.mjs). It
# emails the operator after repeated bad outcomes and on recovery, and turns the
# runner off on guard-not-loaded. It never pauses the factory, and a failure
# here never fails the tick.
browser_record_result() {
  node "$SCRIPT_DIR/lib/browser-health.mjs" record --state-file "$STATE_FILE" \
    --result "$1" --to "$ADMIN_EMAIL" --account-file "$FACTORY_BROWSER_ACCOUNT_FILE" \
    >>"$LOG_FILE" 2>&1 || true
}

# browser_signin_release — give back the preview sign-in lease browser_run took
# when it minted (BROWSER_SIGNIN_LEASE_OWNER), once the runner is done with its
# link. Owner-checked in browser-signin.mjs: a lease that expired during the
# run and was taken over by the shell lane is left alone. Never fails.
browser_signin_release() {
  [[ -n "${BROWSER_SIGNIN_LEASE_OWNER:-}" ]] || return 0
  node "$SCRIPT_DIR/lib/browser-signin.mjs" release --lease-file "$SIGNIN_LEASE_FILE" \
    --owner "$BROWSER_SIGNIN_LEASE_OWNER" >>"$LOG_FILE" 2>&1 || true
  BROWSER_SIGNIN_LEASE_OWNER=""
  return 0
}

# run_browser_task <kind> <run-dir> <target-origin> <bundle-json>
# The ONLY claude call in the factory that gets --chrome. Sets BROWSER_OUT (the
# runner's stdout) and BROWSER_RESULT: "ran" (read the output for the runner's
# own status), "guard-not-loaded", "timeout", "session-limit" or "error".
# Returns 1 only when it couldn't start at all.
run_browser_task() {
  local kind="$1" run_dir="$2" origin="$3" bundle="$4"
  local guard="$SCRIPT_DIR/lib/browser-guard.mjs" cfg settings allowed uuid input start_iso cwd
  local exit_code=0
  BROWSER_RESULT="error"
  BROWSER_OUT="$run_dir/runner-output.txt"
  if [[ ! -f "$BROWSER_PROMPT_FILE" ]]; then
    log "ERROR: browser runner prompt missing ($BROWSER_PROMPT_FILE)"
    return 1
  fi
  mkdir -p "$run_dir/evidence" "$run_dir/guard-state" "$LOG_DIR/browser-guard" || return 1
  cfg="$run_dir/guard-config.json"
  settings="$run_dir/guard-settings.json"
  # The settings file is generated by one tested function rather than written
  # here: `claude -p` silently drops a settings file that fails validation, and
  # would then run with Chrome and no guard at all. `verify` below catches that.
  if ! node "$guard" config --out "$cfg" --device "$FACTORY_BROWSER_DEVICE_ID" \
      --allow-origin "$origin" --log-dir "$LOG_DIR/browser-guard" \
      --state-dir "$run_dir/guard-state" --evidence-dir "$run_dir/evidence" >>"$LOG_FILE" 2>&1 \
    || ! node "$guard" settings --config "$cfg" --out "$settings" >>"$LOG_FILE" 2>&1; then
    log "ERROR: browser guard setup failed ($kind); not starting the runner"
    return 1
  fi
  allowed=$(node "$guard" allowed-tools 2>>"$LOG_FILE" || echo "")
  if [[ -z "$allowed" ]]; then
    log "ERROR: browser guard printed no tool allowlist ($kind); not starting the runner"
    return 1
  fi
  uuid=$(uuidgen | tr '[:upper:]' '[:lower:]')
  input=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
    "$(cat "$BROWSER_PROMPT_FILE")" "$bundle")
  start_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  log "Invoking the browser runner ($kind, session $uuid, cap ${FACTORY_BROWSER_TIMEOUT_SEC}s, effort=$FACTORY_PLAN_EFFORT)"
  # Nothing but this prompt and the guard's settings reach the runner. cwd is
  # an empty directory OUTSIDE the repo (Claude Code walks up from its cwd for
  # CLAUDE.md files and project settings); --setting-sources "" drops the user,
  # project and local settings (plugins, their hooks, the operator's own
  # CLAUDE.md), while the --settings file still loads; and --strict-mcp-config
  # with no --mcp-config leaves only the built-in claude-in-chrome server, so
  # the claude.ai connectors (Gmail, Drive…) aren't even in the session.
  # Resolved (/private/var/…, not /var/…): claude names its transcript
  # folder after the real path, and check_session_limit and the transcript
  # check below look it up by that name.
  # An explicit template, not `-t`: GNU mktemp (CI) rejects a -t prefix with
  # no X's, where macOS's appends them.
  if ! cwd=$(mktemp -d "${TMPDIR:-/tmp}/factory-browser-cwd.XXXXXX") || ! cwd=$(cd "$cwd" && pwd -P); then
    log "ERROR: could not create the browser runner's working directory ($kind)"
    return 1
  fi
  # The prompt goes in on stdin, not argv: the bundle carries the test
  # account's password, and argv is visible to `ps`.
  ( cd "$cwd" && printf '%s' "$input" | CLAUDE_CALL_TIMEOUT_SEC="$FACTORY_BROWSER_TIMEOUT_SEC" \
      node "$SCRIPT_DIR/lib/run-claude.mjs" -p --chrome --permission-mode dontAsk --tools "" \
      --allowedTools "$allowed" --setting-sources "" --strict-mcp-config --settings "$settings" \
      --session-id "$uuid" --effort "$FACTORY_PLAN_EFFORT" ) >"$BROWSER_OUT" 2>>"$LOG_FILE" || exit_code=$?
  # A session that ran without the guard's SessionStart record is the one
  # outcome that turns the runner off (until factory:browser-reset): it means
  # claude dropped the settings file and ran Chrome unguarded. A claude that
  # never got as far as a session (a bad flag after a CLI update, a crash on
  # start) leaves no transcript either, and is just an error.
  if ! node "$guard" verify --config "$cfg" --session "$uuid" >>"$LOG_FILE" 2>&1; then
    if [[ -n "$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -maxdepth 2 -name "$uuid.jsonl" -print 2>/dev/null | head -1)" ]]; then
      log "ERROR: the browser guard did not load for session $uuid; turning the browser runner off"
      BROWSER_RESULT="guard-not-loaded"
    else
      log "ERROR: the browser runner never started a session ($kind, exit $exit_code)"
      BROWSER_RESULT="error"
    fi
    rmdir "$cwd" 2>/dev/null || true
    return 0
  fi
  if [[ $exit_code -eq 0 ]]; then
    BROWSER_RESULT="ran"
  elif [[ $exit_code -eq 124 ]]; then
    log "WARNING: the browser runner timed out ($kind, session $uuid)"
    BROWSER_RESULT="timeout"
  elif check_session_limit "$cwd" "$start_iso"; then
    BROWSER_RESULT="session-limit"
  else
    log "ERROR: the browser runner exited $exit_code ($kind, session $uuid)"
    BROWSER_RESULT="error"
  fi
  rmdir "$cwd" 2>/dev/null || true
  return 0
}

# browser_refund_attempt <issue> <head sha> <attempts after the bump> — give
# back an attempt that a browser-side failure spent, so the per-SHA cap counts
# only runs that got as far as the page.
browser_refund_attempt() {
  local left=$(( $3 - 1 ))
  [[ "$left" -ge 0 ]] || left=0
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$1" browserRunAttempts \
    "$2:$left" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
}

# browser_write_candidates — hand this tick's browser-run candidates to
# --browser: the Testing sweep's verify ones first, then the In Test sweep's.
# Written whole (a temp file, then mv), so --browser never reads half a list.
# Never in a dry run.
browser_write_candidates() {
  [[ "$DRY_RUN" -eq 0 ]] || return 0
  # Unquoted on purpose: one candidate per word, one line each.
  printf '%s\n' ${VERIFY_BROWSER_CANDIDATES:-} ${BROWSER_CANDIDATES:-} \
    >"$BROWSER_CANDIDATES_FILE.tmp" 2>>"$LOG_FILE" \
    && mv "$BROWSER_CANDIDATES_FILE.tmp" "$BROWSER_CANDIDATES_FILE" 2>>"$LOG_FILE" || true
}

# browser_claim_sha <issue> <head sha> — record browserRunSha: the browser
# runner is done with this commit (a report, or nothing it could ever run), so
# neither kind starts another session for it.
browser_claim_sha() {
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$1" browserRunSha "$2" \
    --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
}

# browser_lane_end <kind> <issue> <head sha> <state> — end the verify lane with
# <state> before any session ran (the --browser loop has just seen the card in
# Testing). A no-op for the intest kind, which has no lane.
browser_lane_end() {
  [[ "$1" == verify ]] || return 0
  shift
  verify_browser_record "$@" || true
  return 0
}

# browser_lane_finish <kind> <issue> <head sha> <state> <run dir> — the same
# after a session: verify_browser_finish, which records only while the card is
# still in its round in Testing. Returns its status (0 for the intest kind).
browser_lane_finish() {
  [[ "$1" == verify ]] || return 0
  shift
  verify_browser_finish "$@"
}

# intest_browser_run <issue> <pr> <head sha> — the In Test web run (ADR-0051),
# browser_run's `intest` kind.
intest_browser_run() {
  browser_run intest "$@"
}

# browser_run <kind> <issue> <pr> <head sha> — one browser run: the Web section
# of the factory's own scenario for <head sha>, on that commit's preview.
# Commentary, like intest_handoff: it never moves the card and never spends the
# retry budget. The two kinds share every step but where the result goes:
#
#   intest  The In Test web run (ADR-0051). The report is posted as one issue
#           comment; a FAIL is for the person at the In Test gate to read.
#   verify  The Testing column's browser lane (ADR-0053). It posts nothing: it
#           records the lane's result for the card's round (browser_lane_end,
#           browser_lane_finish), which the Testing sweep waits on and the
#           verification report shows. It runs only for the round's own
#           commit, and ends the lane at once on anything waiting can't fix (a
#           stale branch, no preview in time, the browser unavailable…), so a
#           card never sits out the hold cap for nothing. An exit path that
#           forgets to end the lane leaves it to the hold cap, never stuck.
#
# Both kinds share browserRunSha (the head a run reported on, or found nothing
# to run for) and the per-SHA attempts, so a head verified in Testing isn't run
# again in In Test: the intest kind is the fallback for a head the verify lane
# couldn't report on (verify_browser_unclaim hands a head back to it when the
# verification report couldn't carry the lane's result).
#
# Returns 0 when it ran (or found the run can never happen for this SHA), 1 when
# the card isn't ready this tick (try the next candidate), 2 when the browser
# itself is unavailable or the preview sign-in lease is held (stop trying
# candidates this tick; a busy lease spends, records and posts nothing). A
# verify run that finds the browser unavailable before a session ends its lane
# and returns 1, so the next verify candidate's lane ends this tick too;
# BROWSER_PREFLIGHT_FAILED keeps that to one preflight and one health record per
# --browser run.
browser_run() {
  local kind="$1" issue_num="$2" pr_num="$3" head_sha="$4"
  local state_json scenario_sha run_sha attempts_raw attempts=0 preflight target
  local issue_record comments_json raw bundle origin run_dir body_file render_json status verdict withheld
  local lane="" run_tag="" skip_reason preview_rc=0 preflight_failed=0 finish_rc=0
  case "$kind" in
    intest|verify) ;;
    *) log "ERROR: unknown browser run kind '$kind' for #$issue_num"; return 1 ;;
  esac
  state_json=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" \
    --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo "{}")
  if [[ "$kind" == verify ]]; then
    # Only for the card's current round, and only while the lane has no result
    # for this commit: --watch listed the card a few minutes ago.
    [[ "$(echo "$state_json" | jq -r '.verifySha // ""' 2>/dev/null)" == "$head_sha" ]] || return 1
    if verify_state_terminal "$(verify_sha_value \
        "$(echo "$state_json" | jq -r '.verifyBrowser // ""' 2>/dev/null)" "$head_sha")"; then
      return 1
    fi
  fi
  run_sha=$(echo "$state_json" | jq -r '.browserRunSha // ""' 2>/dev/null || echo "")
  if [[ "$run_sha" == "$head_sha" ]]; then
    [[ "$kind" == verify ]] || return 1
    # Back in Testing on a head the In Test run already handled (the revision
    # no-op path). Only its own report counts as "already run": a pass that
    # found no Web steps, or a stale branch, left none, and this run reaches the
    # same outcome before any session, with its own reason.
    comments_json=$(fetch_issue_comments "$issue_num" 2>>"$LOG_FILE") || return 1
    if echo "$comments_json" | jq -e --arg m "drafto-factory-browser-run-sha:$head_sha" \
        'any(.[]; .authorAssociation == "OWNER" and ((.body // "") | contains($m)))' >/dev/null 2>&1; then
      browser_lane_end verify "$issue_num" "$head_sha" "skipped:already-run"
      return 1
    fi
  fi
  # Only after the scenario for this exact commit exists: the runner runs the
  # scenario's own steps, and a refresh may still be pending.
  scenario_sha=$(echo "$state_json" | jq -r '.intestCommentSha // ""' 2>/dev/null || echo "")
  [[ "$scenario_sha" == "$head_sha" ]] || return 1
  attempts_raw=$(echo "$state_json" | jq -r '.browserRunAttempts // ""' 2>/dev/null || echo "")
  if [[ "${attempts_raw%%:*}" == "$head_sha" ]]; then
    attempts="${attempts_raw##*:}"
    [[ "$attempts" =~ ^[0-9]+$ ]] || attempts=0
  fi
  if [[ "$attempts" -ge "$FACTORY_BROWSER_MAX_ATTEMPTS" ]]; then
    browser_lane_end "$kind" "$issue_num" "$head_sha" "unavailable:attempts"
    return 1
  fi
  # The candidate list is a few minutes old by now (--watch wrote it, --release
  # ran since). A push in between would have the runner spend a whole session
  # on a superseded commit's preview, so check the PR's live head first.
  local live_head
  live_head=$(gh pr view "$pr_num" --repo JakubAnderwald/drafto --json headRefOid,state \
    --jq 'select(.state == "OPEN") | .headRefOid' 2>>"$LOG_FILE" || echo "")
  if [[ "$live_head" != "$head_sha" ]]; then
    log "Issue #$issue_num: PR #$pr_num head is now ${live_head:0:12} (not ${head_sha:0:12}) or the PR closed; skipping the browser run until --watch catches up"
    return 1
  fi

  if [[ -n "${BROWSER_PREFLIGHT_FAILED:-}" ]]; then
    # This --browser run already found the browser unavailable: no second
    # check and no second health record.
    preflight="$BROWSER_PREFLIGHT_FAILED"
    preflight_failed=1
    log "Issue #$issue_num: browser run skipped ($preflight)"
  elif ! preflight=$(node "$SCRIPT_DIR/lib/browser-health.mjs" preflight --state-file "$STATE_FILE" \
      --account-file "$FACTORY_BROWSER_ACCOUNT_FILE" \
      --signin-key-file "$FACTORY_BROWSER_SIGNIN_KEY_FILE" 2>>"$LOG_FILE"); then
    preflight_failed=1
    log "Issue #$issue_num: browser run skipped (${preflight:-preflight failed})"
    # Recorded even while the runner is disabled: that never builds a streak or
    # sends a second alert, but it is the only path that retries a "disabled"
    # email whose first send failed.
    if [[ "$DRY_RUN" -eq 0 ]]; then
      browser_record_result "preflight:${preflight:-unknown}"
    fi
    preflight="${preflight:-unknown}"
    BROWSER_PREFLIGHT_FAILED="$preflight"
  fi
  if [[ "$preflight_failed" -eq 1 ]]; then
    [[ "$kind" == verify ]] || return 2
    # The operator's to fix, and no wait in Testing fixes it: the lane ends now
    # (the In Test run is the fallback once the browser is back), and so does
    # the next verify candidate's, this tick.
    browser_lane_end verify "$issue_num" "$head_sha" \
      "unavailable:$(verify_browser_preflight_reason "$preflight")"
    return 1
  fi
  target=$(preview_url_for_sha "$head_sha") || preview_rc=$?
  if [[ "$preview_rc" -ne 0 || -z "$target" ]]; then
    if [[ "$preview_rc" -eq 2 ]]; then
      log "Issue #$issue_num: couldn't ask GitHub for ${head_sha:0:12}'s preview deployment; browser run waits"
      return 1
    fi
    log "Issue #$issue_num: no successful Vercel preview deployment for ${head_sha:0:12} yet; browser run waits"
    if [[ "$kind" == verify ]]; then
      verify_browser_preview_wait "$issue_num" "$head_sha" "$state_json" || true
    fi
    return 1
  fi
  issue_record=$(fetch_issue_record "$issue_num") || return 1
  comments_json=$(fetch_issue_comments "$issue_num" 2>>"$LOG_FILE") || return 1
  raw=$(jq -n --argjson issue "$issue_record" --argjson comments "$comments_json" \
    --arg headSha "$head_sha" --argjson prNumber "$pr_num" --arg targetUrl "$target" \
    --arg accountFile "$FACTORY_BROWSER_ACCOUNT_FILE" --arg deviceId "$FACTORY_BROWSER_DEVICE_ID" \
    --arg runKind "$kind" \
    '{kind: "factory_browser_run", runKind: $runKind,
      issue: {number: $issue.number, title: $issue.title},
      comments: $comments, headSha: $headSha, prNumber: $prNumber,
      targetUrl: $targetUrl, accountFile: $accountFile, deviceId: $deviceId}') || return 1
  # The bundle holds the test account's password: it lives in this variable and
  # on the runner's stdin, never in the log.
  if ! bundle=$(printf '%s' "$raw" | node "$SCRIPT_DIR/lib/factory-bundle.mjs" 2>>"$LOG_FILE"); then
    log "ERROR: building the browser-run bundle failed for #$issue_num"
    return 1
  fi
  if [[ "$(echo "$bundle" | jq -r '.scenario == null' 2>/dev/null)" == "true" ]]; then
    # Nothing to run for this commit: no OWNER scenario with this SHA, or one
    # without a ### Web section (e.g. the fallback comment). Record it so the
    # sweep doesn't rebuild the bundle every tick; a new commit re-arms it.
    skip_reason=$(echo "$bundle" | jq -r '.skipReason // ""' 2>/dev/null || echo "")
    case "$skip_reason" in no-scenario|no-web-steps) ;; *) skip_reason="no-web-steps" ;; esac
    log "Issue #$issue_num: scenario for ${head_sha:0:12} has no Web section to run ($skip_reason); no browser run"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      browser_claim_sha "$issue_num" "$head_sha"
      browser_lane_end "$kind" "$issue_num" "$head_sha" "skipped:$skip_reason"
    fi
    return 1
  fi
  # A branch cut before the sign-in route landed can't sign in on its preview,
  # and no retry fixes that. Checked last, once nothing else stands in the way,
  # so the note never promises a run that something else would stop. The commit
  # gets no session and no health strike; the issue gets one note per commit,
  # and the SHA is recorded only once that note is on the issue.
  local route_rc=0 stale_marker="drafto-factory-browser-stale-branch:${head_sha:0:12}"
  head_has_signin_route "$head_sha" || route_rc=$?
  if [[ "$route_rc" -eq 1 ]]; then
    log "Issue #$issue_num: PR #$pr_num's head ${head_sha:0:12} predates /auth/test-sign-in; no browser run for this commit"
    [[ "$DRY_RUN" -eq 1 ]] && return 1
    if [[ "$kind" == verify ]]; then
      # No note of its own: the verification report tells the reader to update
      # the branch. browserRunSha too, so the In Test run doesn't note it again.
      browser_lane_end verify "$issue_num" "$head_sha" "stale-branch"
      browser_claim_sha "$issue_num" "$head_sha"
      return 1
    fi
    if echo "$comments_json" | jq -e --arg m "$stale_marker" 'any(.[]; .body | contains($m))' >/dev/null 2>&1 \
        || gh issue comment "$issue_num" --repo JakubAnderwald/drafto \
          --body "🏭 **No browser run for \`${head_sha:0:7}\`.**

PR #$pr_num's branch was cut before the preview sign-in route (\`/auth/test-sign-in\`) \
landed on \`main\`, so the factory's browser runner can't sign in on its preview. \
Merge \`main\` into the branch (the **Update branch** button on PR #$pr_num, not \
\"Update with rebase\") and the next commit gets a browser run. The card is unaffected.

<!-- $stale_marker -->" >>"$LOG_FILE" 2>&1; then
      browser_claim_sha "$issue_num" "$head_sha"
    else
      log "WARNING: posting the stale-branch note on #$issue_num failed; trying again next tick"
    fi
    return 1
  elif [[ "$route_rc" -ne 0 ]]; then
    log "WARNING: couldn't check whether ${head_sha:0:12} has /auth/test-sign-in; running anyway"
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ "$kind" == verify ]]; then
      log "DRY-RUN: would run the Testing browser lane (verify) for #$issue_num on $target"
    else
      log "DRY-RUN: would run the In Test web steps for #$issue_num on $target"
    fi
    return 0
  fi
  # The one-time sign-in link, minted last so it is as fresh as possible when
  # the runner opens it. It is a login token: it lives in the bundle on the
  # runner's stdin and nowhere else, never in the log.
  #
  # Minted under the sign-in lease (SIGNIN_LEASE_FILE): Supabase keeps one live
  # magic-link token per user, and the verification shell lane signs in as the
  # same test account from a detached run. A mint of its own between this mint
  # and the runner opening the link would end this run as signin-failed: an
  # attempt and a health strike for nothing. Taken here, after every cheap
  # check, and held FACTORY_SIGNIN_LEASE_SEC (the runner opens its link early);
  # released once the runner is done (browser_signin_release, and cleanup() if
  # this process dies first). Busy (exit 3): the holder signs in within seconds
  # (the shell lane) or its lease expires, so this run waits for the next
  # --browser tick, spending no attempt and recording, writing and posting
  # nothing. The verify lane stays non-terminal, so --watch queues it again;
  # the In Test sweep lists its candidates afresh every tick.
  local sign_in_url mint_rc=0 lease_owner="browser:$kind:$issue_num:${head_sha:0:12}" holder
  sign_in_url=$(node "$SCRIPT_DIR/lib/browser-signin.mjs" mint \
      --key-file "$FACTORY_BROWSER_SIGNIN_KEY_FILE" --account-file "$FACTORY_BROWSER_ACCOUNT_FILE" \
      --origin "$target" --lease-file "$SIGNIN_LEASE_FILE" --owner "$lease_owner" \
      --hold-sec "$FACTORY_SIGNIN_LEASE_SEC" 2>>"$LOG_FILE") || mint_rc=$?
  if [[ "$mint_rc" -eq 3 ]]; then
    holder=$(printf '%s\n' "$sign_in_url" | tail -1 \
      | jq -r '"\(.owner // "unknown") until \(.until // "unknown")"' 2>/dev/null || echo "unknown")
    log "Issue #$issue_num: the preview sign-in lease is held (${holder:-unknown}); browser run ($kind) deferred to the next --browser tick"
    return 2
  fi
  # Exit 0 means the lease is held (or the lease file couldn't be used and the
  # mint went ahead without it, warning in the log): from here, give it back.
  [[ "$mint_rc" -ne 0 ]] || BROWSER_SIGNIN_LEASE_OWNER="$lease_owner"
  if [[ "$mint_rc" -ne 0 || -z "$sign_in_url" ]]; then
    browser_signin_release
    log "Issue #$issue_num: minting the runner's sign-in link failed (reason above); no browser run"
    browser_record_result "preflight:signin-mint"
    browser_lane_end "$kind" "$issue_num" "$head_sha" "unavailable:signin-mint"
    return 2
  fi
  if ! bundle=$(echo "$bundle" | jq --arg u "$sign_in_url" '.account.signInUrl = $u'); then
    log "ERROR: could not add the sign-in link to the browser-run bundle for #$issue_num"
    browser_signin_release
    return 1
  fi

  attempts=$((attempts + 1))
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" browserRunAttempts \
    "$head_sha:$attempts" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  origin=$(echo "$bundle" | jq -r '.target.origin')
  [[ "$kind" == intest ]] || run_tag="$kind-"
  run_dir="$LOG_DIR/browser/issue-$issue_num-${head_sha:0:12}-$run_tag$(date +%Y%m%dT%H%M%S)"
  log "Issue #$issue_num: browser run ($kind) $attempts/$FACTORY_BROWSER_MAX_ATTEMPTS for ${head_sha:0:12} on $origin"
  local task_rc=0
  run_browser_task "$kind" "$run_dir" "$origin" "$bundle" || task_rc=$?
  # The runner is done with its link, whatever the session did (ran, failed,
  # timed out, or never started): give the lease back before anything else.
  browser_signin_release
  if [[ "$task_rc" -ne 0 ]]; then
    browser_record_result error
    # Nothing ran (the guard or the prompt couldn't be set up): the operator's
    # to fix, so the verify lane ends now and gives the attempt back.
    if [[ "$kind" == verify ]]; then
      browser_refund_attempt "$issue_num" "$head_sha" "$attempts"
      browser_lane_end verify "$issue_num" "$head_sha" "unavailable:runner-start"
    fi
    return 2
  fi
  # `lane` is the verify lane's result, recorded once the run is over; empty
  # while the run may still be retried (an attempt is left).
  case "$BROWSER_RESULT" in
    ran) ;;
    session-limit)
      browser_refund_attempt "$issue_num" "$head_sha" "$attempts"
      pause_for_session_limit
      lane="unavailable:session-limit"
      ;;
    guard-not-loaded)
      # The runner is now off; refund so the card gets its run after the reset.
      browser_refund_attempt "$issue_num" "$head_sha" "$attempts"
      browser_record_result "$BROWSER_RESULT"
      lane="unavailable:guard"
      ;;
    timeout)
      # The attempt stays spent, so a hanging runner can't run every tick. The
      # verify lane ends here; the In Test run may use an attempt that's left.
      browser_record_result "$BROWSER_RESULT"
      lane="timeout"
      ;;
    *)
      browser_record_result "$BROWSER_RESULT"
      [[ "$attempts" -lt "$FACTORY_BROWSER_MAX_ATTEMPTS" ]] || lane="unavailable:runner-error"
      ;;
  esac
  if [[ "$BROWSER_RESULT" != "ran" ]]; then
    [[ -z "$lane" ]] || browser_lane_finish "$kind" "$issue_num" "$head_sha" "$lane" "$run_dir" || true
    return 2
  fi

  if [[ "$kind" == verify ]]; then
    body_file="$run_dir/section.md"
  else
    body_file="$run_dir/comment.md"
  fi
  if ! render_json=$(node "$SCRIPT_DIR/lib/browser-report.mjs" render --kind "$kind" \
      --in "$BROWSER_OUT" --issue "$issue_num" --sha "$head_sha" --evidence-dir "$run_dir/evidence" \
      --account-file "$FACTORY_BROWSER_ACCOUNT_FILE" --out "$body_file" \
      --json-out "$run_dir/render.json" 2>>"$LOG_FILE"); then
    log "ERROR: rendering the browser report failed for #$issue_num (output kept in $run_dir)"
    browser_record_result malformed
    if [[ "$attempts" -ge "$FACTORY_BROWSER_MAX_ATTEMPTS" ]]; then
      browser_lane_finish "$kind" "$issue_num" "$head_sha" "unavailable:malformed" "$run_dir" || true
    fi
    return 2
  fi
  status=$(echo "$render_json" | jq -r '.status // "malformed"' 2>/dev/null || echo "malformed")
  verdict=$(echo "$render_json" | jq -r '.verdict // "none"' 2>/dev/null || echo "none")
  withheld=$(echo "$render_json" | jq -r '.withheld // false' 2>/dev/null || echo "false")
  log "Issue #$issue_num: browser run finished (browser=$status verdict=$verdict withheld=$withheld; evidence in $run_dir)"
  browser_record_result "$status"
  case "$status" in
    unavailable|auth-expired)
      # The operator's problem, not the reporter's: the health tracker emails
      # about it and the issue gets no comment. Refunded, so the card still
      # gets its run once the browser is fixed. These fail fast (the runner
      # stops at the browser check or the first login wall), so retrying each
      # tick is cheap. The verify lane ends at once (the In Test run is the
      # fallback).
      browser_refund_attempt "$issue_num" "$head_sha" "$attempts"
      lane="unavailable:auth-expired"
      [[ "$status" != unavailable ]] || lane="unavailable:chrome"
      browser_lane_finish "$kind" "$issue_num" "$head_sha" "$lane" "$run_dir" || true
      return 2
      ;;
    signin-failed)
      # The route check above skips branches without /auth/test-sign-in, so
      # this is usually the environment: a preview not on dev Supabase, or a
      # test account that's gone or unapproved. (Or a stale branch the check
      # couldn't ask GitHub about.) No retry fixes that: the attempt stays
      # spent, the issue gets no comment, and the health tracker tells the
      # operator.
      log "Issue #$issue_num: the runner couldn't sign in on the preview with its one-time link; nothing posted (see $run_dir)"
      browser_lane_finish "$kind" "$issue_num" "$head_sha" "unavailable:signin-failed" "$run_dir" || true
      return 2
      ;;
    malformed)
      # No status line: nothing trustworthy to post. The attempt stays spent;
      # the next one may produce a report.
      log "Issue #$issue_num: the browser runner's output had no status line; nothing posted (see $run_dir)"
      if [[ "$attempts" -ge "$FACTORY_BROWSER_MAX_ATTEMPTS" ]]; then
        browser_lane_finish "$kind" "$issue_num" "$head_sha" "unavailable:malformed" "$run_dir" || true
      fi
      return 2
      ;;
  esac
  if [[ "$kind" == verify ]]; then
    # Nothing is posted: verify_promote posts the verification report, once,
    # with this run in its Web lane. browserRunSha only once the result is
    # recorded for a card known to be in Testing: a card that left meanwhile,
    # or one the board couldn't confirm, still gets its In Test run.
    browser_lane_finish verify "$issue_num" "$head_sha" "reported:$verdict" "$run_dir" || finish_rc=$?
    [[ "$finish_rc" -ne 0 ]] || browser_claim_sha "$issue_num" "$head_sha"
    return 0
  fi
  if gh issue comment "$issue_num" --repo JakubAnderwald/drafto --body-file "$body_file" >>"$LOG_FILE" 2>&1; then
    browser_claim_sha "$issue_num" "$head_sha"
  else
    log "WARNING: posting the browser report on #$issue_num failed; it stays in $body_file"
  fi
  return 0
}

# Code-review stage: review a green In Review PR and post each finding as an
# inline review thread, plus one marked summary comment.
#
# Like intest_handoff this is COMMENTARY, not a state transition — the card is
# still In Review when it runs and stays there. Every failure path degrades to
# "no review this SHA" and NEVER bumps the retry budget or blocks the card: a PR
# whose review failed is still a green, testable PR, and the next head SHA gets
# another attempt. The SHA is recorded on both success and non-session-limit
# failure so a persistently failing review can't re-run every tick forever.
#
# The summary comment carries `<!-- drafto-factory-code-review -->`. That marker
# is what pr_has_marker() checks to confirm the review actually posted — the
# model's own directive line is not trusted for that.
#
# It also keeps the comment inside the `<!-- drafto-factory` family that
# owner_comments_since() filters out. That exclusion is NOT load-bearing today:
# owner_comments_since is only ever fed fetch_issue_comments (ISSUE comments),
# while this summary is posted with `gh pr comment` onto the PR — different
# number, the two never meet. It matters only if the summary ever moves to the
# issue, or that helper is ever pointed at PR comments; the Mac mini's gh
# identity is OWNER, so either change without the marker would make the In Test
# sweep read the factory's own review as operator feedback.
#
# $1 issue, $2 pr-num, $3 pr obj, $4 head sha, $5 changed files.
review_stage() {
  local issue_num="$1" pr_num="$2" pr_obj="$3" head_sha="$4" diff_files="$5"
  local issue_record comments_json plan_json pr_diff bundle claude_input
  local out_file start_iso exit_code=0

  # Every DETERMINISTIC failure below records the SHA before returning. Skipping
  # the record would leave lastReviewSha != headRefOid forever: the caller
  # `continue`s after every review attempt, so the card would retry the same
  # doomed review every five minutes, never reach In Test, never bump attempts
  # and never reach Blocked — a silent stall visible only as a WARNING in the
  # log. Recording degrades to "this commit goes unreviewed", which is the right
  # trade for a commentary stage. Only a session limit (transient) skips it.
  if [[ ! -f "$REVIEW_PROMPT_FILE" ]]; then
    log "WARNING: review prompt missing ($REVIEW_PROMPT_FILE); skipping review for #$issue_num"
    review_record_sha "$issue_num" "$head_sha"
    return 0
  fi
  if ! issue_record=$(fetch_issue_record "$issue_num"); then
    log "WARNING: fetch_issue_record failed for #$issue_num (review); skipping"
    review_record_sha "$issue_num" "$head_sha"
    return 0
  fi
  comments_json=$(fetch_issue_comments "$issue_num" 2>>"$LOG_FILE" || echo "[]")
  [[ -n "$comments_json" ]] || comments_json="[]"
  plan_json=$(extract_plan_comment "$comments_json")
  [[ -n "$plan_json" ]] || plan_json="null"
  pr_diff=$(gh pr diff "$pr_num" --repo JakubAnderwald/drafto 2>>"$LOG_FILE" || echo "")
  if [[ -z "$pr_diff" ]]; then
    log "WARNING: empty diff for PR #$pr_num; skipping review"
    review_record_sha "$issue_num" "$head_sha"
    return 0
  fi

  if ! bundle=$(build_review_bundle "$issue_record" "$plan_json" "$pr_obj" "$pr_diff" \
      "$diff_files" "$head_sha"); then
    log "ERROR: build_review_bundle failed for #$issue_num; skipping review"
    review_record_sha "$issue_num" "$head_sha"
    return 0
  fi

  claude_input=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
    "$(cat "$REVIEW_PROMPT_FILE")" "$bundle")
  log "Invoking claude for #$issue_num (code review of PR #$pr_num @ ${head_sha:0:12}, cap ${REVIEW_TIMEOUT_SEC}s, effort=$FACTORY_PLAN_EFFORT)"
  out_file=$(mktemp -t factory-agent-review.XXXXXX)
  start_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Read-only stage: runs in the factory checkout on main, no worktree, no slot.
  ( cd "$REPO_ROOT" && CLAUDE_CALL_TIMEOUT_SEC="$REVIEW_TIMEOUT_SEC" \
      node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$claude_input" --dangerously-skip-permissions --effort "$FACTORY_PLAN_EFFORT" --no-chrome --strict-mcp-config ) \
      >"$out_file" 2>>"$LOG_FILE" || exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    [[ $exit_code -eq 124 ]] && log "WARNING: claude timed out reviewing PR #$pr_num for #$issue_num" \
      || log "ERROR: claude exited $exit_code reviewing PR #$pr_num for #$issue_num"
    cat "$out_file" >>"$LOG_FILE" 2>/dev/null || true
    # A session limit pauses the whole factory and does NOT record the SHA, so
    # the review is retried once the limit resets rather than skipped for good.
    if [[ $exit_code -ne 124 ]] && check_session_limit "$REPO_ROOT" "$start_iso"; then
      rm -f "$out_file"
      pause_for_session_limit
      return 0
    fi
    rm -f "$out_file"
    review_record_sha "$issue_num" "$head_sha"
    return 0
  fi
  cat "$out_file" >>"$LOG_FILE"
  rm -f "$out_file"

  # Trust the marker, not the model's word: the summary comment either exists or
  # it doesn't. Without it we still record the SHA (no retry storm) but say so.
  if pr_has_marker "$pr_num" "drafto-factory-code-review"; then
    log "Issue #$issue_num: code review posted for PR #$pr_num @ ${head_sha:0:12}"
  else
    log "WARNING: issue #$issue_num: review run produced no summary comment on PR #$pr_num"
  fi
  review_record_sha "$issue_num" "$head_sha"
  return 0
}

# Bound the review-thread fix loop.
#
# A CI-failure loop is self-limiting: `fixed` means the check should now pass, so
# the loop ends when CI goes green. A THREAD loop has no such floor — the fix
# pushes a new commit, the new head SHA earns a fresh review, that review can
# find something new, and `fixed`/`noop` never bump the retry budget. Left alone
# a card could cycle forever, spending a Claude call every five minutes.
#
# So: when this iteration was driven by open review threads (not failing CI),
# spend one attempt. FACTORY_MAX_ATTEMPTS then caps the conversation and the
# existing exhaustion path parks the card in Blocked for a human. Attempts reset
# on the In Test promotion, so a card that converges pays nothing lasting.
#
# One exemption (ADR-0036): a pass whose open threads are ALL CodeRabbit CLI
# findings from the latest CLI run is free. Without it the gap-fill lane would
# eat the review budget — bot fix, Claude fix, CLI fix, re-review fix, CLI #2 fix
# is five passes and a Blocked card for doing exactly what the lane exists for.
# The exemption is itself bounded, so the termination guarantee above still
# holds: coderabbit-cli.mjs grants at most ONE free pass per CLI run (keyed on
# crLastCoveredSha, recorded as crCliFreePassSha), a card gets at most
# FACTORY_CR_CLI_MAX_RUNS_PER_CARD runs, and a thread counts as a CLI finding only
# when the owner identity posted it with the finding marker — a public commenter
# can't forge one to dodge the budget. Any free-pass failure spends the attempt.
#
# Reads THREAD_COUNT / FAILING / ISSUE_NUM / REVIEW_THREADS from the enclosing
# --watch loop.
watch_bound_thread_loop() {
  [[ "${THREAD_COUNT:-0}" -gt 0 && "${FAILING:-0}" -eq 0 ]] || return 0
  if echo "${REVIEW_THREADS:-[]}" | node "$SCRIPT_DIR/lib/coderabbit-cli.mjs" free-pass \
      --issue "$ISSUE_NUM" --state-file "$STATE_FILE" 2>>"$LOG_FILE" \
      | jq -e '.exempt == true' >/dev/null 2>&1; then
    log "Issue #$ISSUE_NUM: all open threads are CodeRabbit CLI findings from the latest CLI run; free pass, no attempt spent"
    return 0
  fi
  log "Issue #$ISSUE_NUM: review-thread fix pass; spending one attempt to bound the loop"
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" \
    --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
}

# Record the head SHA the review stage last ran against, so --watch reviews each
# SHA exactly once. Silently no-ops on an empty SHA.
review_record_sha() {
  local issue_num="$1" head_sha="$2"
  [[ -n "$head_sha" ]] || return 0
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" \
    lastReviewSha "$head_sha" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
}

# Does PR <pr-num>'s conversation carry <marker>? The PR-comment analogue of
# issue_has_marker (the review summary lands on the PR, not the issue).
pr_has_marker() {
  local pr_num="$1" marker="$2"
  gh pr view "$pr_num" --repo JakubAnderwald/drafto --json comments \
    --jq "[.comments[]? | select((.body // \"\") | contains(\"$marker\"))] | length" 2>/dev/null \
    | grep -qE '^[1-9]'
}

# Print the UNRESOLVED review threads on <pr-num> as a JSON array of
# {id, path, line, isOutdated, comments:[{body, author:{login}}]}; "[]" on any
# failure (transient API error must not be read as "no findings" by a caller
# that gates on emptiness — callers that block on this check for a query failure
# separately via the exit status).
#
# This is the only place the factory reads review-comment TEXT. `gh pr view
# --json comments` returns PR-conversation comments only, so before this every
# inline finding — CodeRabbit's included — was invisible to the fix loop.
#
# Replaces the old resolve_review_threads(), which force-resolved every thread
# without reading one, immediately before the merge. That silently defeated the
# repo's required_conversation_resolution rule: findings were cleared, not
# addressed. Threads are now answered and resolved by the watcher (see
# factory-watch-prompt.md) and merely VERIFIED empty at the Approved gate.
fetch_review_threads() {
  local pr_num="$1"
  local threads_json
  threads_json=$(gh api graphql -f owner=JakubAnderwald -f repo=drafto -F number="$pr_num" \
    -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:20){nodes{body author{login}}}}}}}}' \
    2>>"$LOG_FILE") || return 1
  [[ -n "$threads_json" ]] || return 1
  echo "$threads_json" | jq -c '
    [ .data.repository.pullRequest.reviewThreads.nodes[]?
      | select(.isResolved == false)
      | { id: .id, path: (.path // ""), line: .line,
          isOutdated: (.isOutdated // false),
          comments: [ .comments.nodes[]? | { body: (.body // ""), author: { login: (.author.login // "") } } ] } ]' \
    2>/dev/null || return 1
}

# Collect a finished background CodeRabbit CLI review (ADR-0036): post its
# findings as threads, record coverage, remove its worktree, free the ledger's
# single in-flight slot. All of that lives in coderabbit-cli.mjs; this wrapper
# only guarantees the lane can never take the tick down with it — any failure is
# a WARNING and the in-flight run is simply looked at again next tick.
#
# Deliberately NOT gated on FACTORY_CR_CLI: a run started before the knob was
# flipped off still owns a worktree and the in-flight slot, and must be reaped.
# Switching the lane off is a kill switch, not a drain. coderabbit-cli.mjs reads
# the exported FACTORY_CR_CLI itself and, when it isn't "1", terminates a
# still-running run (SIGTERM to its process group) and discards a finished one's
# results: nothing is posted, no coverage is recorded, the worktree is removed
# and the slot freed. Posting anyway would open threads on a PR whose card may
# already be In Test, and --release would bounce it back for a re-approval.
#
# The module's last stdout line is {state: idle|starting|running|overdue|done|
# lost|terminated|error|…, …} ("terminated": a still-running run stopped because
# its PR head moved on or the PR closed; logged below). It exits 0 even when it
# caught its own exception (state "error"), so that case is flagged here; a
# non-zero exit is a usage error or a hard crash.
cr_cli_housekeeping() {
  local out state reaped discarded
  if ! out=$(node "$SCRIPT_DIR/lib/coderabbit-cli.mjs" housekeeping --state-file "$STATE_FILE" \
      --repo-root "$REPO_ROOT" --run-root "$CR_CLI_RUN_ROOT" --dry-run "${DRY_RUN:-0}" 2>>"$LOG_FILE"); then
    log "WARNING: CodeRabbit CLI housekeeping failed (non-fatal; retried next tick)"
    return 0
  fi
  out=$(printf '%s\n' "$out" | tail -1)
  [[ -n "$out" ]] || return 0
  state=$(echo "$out" | jq -r '.state // ""' 2>/dev/null || echo "")
  reaped=$(echo "$out" | jq -r '((.reaped.worktrees // []) + (.reaped.runDirs // [])) | length' 2>/dev/null || echo "0")
  [[ -n "$reaped" ]] || reaped="0"
  # The kill switch reports the run it just terminated under that run's poll
  # state ("running"), marked discarded:"lane-off" — that tick must be logged.
  discarded=$(echo "$out" | jq -r '.discarded // ""' 2>/dev/null || echo "")
  case "$state" in
    # This runs every 5-minute tick, lane on or off: idle and still-running ticks
    # would otherwise write ~288 identical lines a day and bury the ones that
    # matter. A tick that reaped or discarded something is still worth a line.
    idle|starting|running)
      if [[ "$reaped" == "0" && -z "$discarded" ]]; then
        return 0
      fi
      ;;
    error)
      log "WARNING: CodeRabbit CLI housekeeping error (non-fatal; retried next tick): $out"
      return 0
      ;;
  esac
  # Anything else (a run collected, killed, lost, or output we can't parse) is
  # logged as-is.
  log "CodeRabbit CLI housekeeping: $out"
  return 0
}

# Decide whether a converged In Review card may leave for In Test yet, as far as
# CodeRabbit coverage of <head-sha> goes (ADR-0036). Returns 1 to HOLD the card
# (the caller `continue`s) and 0 to PROMOTE, setting CR_NOTE to a one-line
# "CodeRabbit did not review <sha>" note when the SHA goes out uncovered.
#
# Fails OPEN: a crash, a missing module or unparseable output promotes. The lane
# adds coverage; it must never be the reason a green, reviewed card is stuck.
# A fail-open promotion still sets CR_NOTE, to "CodeRabbit coverage of <sha12>
# unknown (lane error)": nobody knows whether that commit was reviewed, and the
# tester should be told. The wording matches the note coderabbit-cli.mjs returns
# when its own gate throws, so both failure layers read the same.
#
# $1 issue, $2 pr-num, $3 head sha.
cr_lane_gate() {
  local issue_num="$1" pr_num="$2" head_sha="$3" out action reason
  local lane_error_note="CodeRabbit coverage of ${head_sha:0:12} unknown (lane error)"
  CR_NOTE=""
  if ! out=$(node "$SCRIPT_DIR/lib/coderabbit-cli.mjs" gate --issue "$issue_num" --pr "$pr_num" \
      --sha "$head_sha" --state-file "$STATE_FILE" --repo-root "$REPO_ROOT" \
      --run-root "$CR_CLI_RUN_ROOT" --dry-run "${DRY_RUN:-0}" 2>>"$LOG_FILE"); then
    log "WARNING: issue #$issue_num: CodeRabbit lane gate failed; promoting without it (fail open)"
    CR_NOTE="$lane_error_note"
    return 0
  fi
  out=$(printf '%s\n' "$out" | tail -1)
  action=$(echo "$out" | jq -r '.action // ""' 2>/dev/null || echo "")
  if [[ "$action" != "hold" && "$action" != "promote" ]]; then
    log "WARNING: issue #$issue_num: CodeRabbit lane gate gave no usable decision; promoting (fail open)"
    CR_NOTE="$lane_error_note"
    return 0
  fi
  reason=$(echo "$out" | jq -r '.reason // ""' 2>/dev/null || echo "")
  log "Issue #$issue_num: CodeRabbit lane → $action ($reason)"
  [[ "$action" == "hold" ]] && return 1
  CR_NOTE=$(echo "$out" | jq -r '.note // ""' 2>/dev/null || echo "")
  return 0
}

# Print the CodeRabbit coverage note for <head-sha> as recorded in state
# (ADR-0036), or nothing. For a hand-off that is NOT the promotion: the In Test
# sweep re-writes a scenario whenever intestCommentSha lags the head — e.g. the
# tick died between transition_status and the comment — and without this that
# re-write would silently drop the "did not review" note the promotion carried.
#
# coderabbit-cli.mjs prints a note only when the recorded coverage is for exactly
# this SHA and is an uncovered kind, and never writes state, so a commit pushed
# after the promotion can't inherit an older commit's note. A fail-open "coverage
# unknown (lane error)" note is never recorded and so can't be rebuilt here.
#
# Commentary, so it never fails the caller (whose stdout it is): a crash or
# garbled output means no note, logged via logerr to keep the value clean.
#
# $1 issue, $2 head sha.
cr_coverage_note() {
  local issue_num="$1" head_sha="$2" out
  [[ -n "$head_sha" ]] || return 0
  if ! out=$(node "$SCRIPT_DIR/lib/coderabbit-cli.mjs" note --issue "$issue_num" --sha "$head_sha" \
      --state-file "$STATE_FILE" 2>>"$LOG_FILE"); then
    logerr "WARNING: issue #$issue_num: CodeRabbit coverage note lookup failed; handing off without it"
    return 0
  fi
  printf '%s\n' "$out" | tail -1 \
    | jq -r 'if type == "object" and (.note | type) == "string" then .note else "" end' 2>/dev/null \
    || true
}

# ── Pre-In-Test verification, the Testing column (ADR-0053) ────────────────
# A converged In Review card stops in Testing before In Test. Entry
# (verify_enter) writes the scenario and dispatches betas there, so they start
# while the lanes run; the Testing sweep (verify_sweep, between the In Review
# loop and the In Test sweep) asks verify-decide.mjs what each card needs next
# and carries it out: start a round, work the lanes, wait, hand the commit back
# to In Review, or promote to In Test with one deterministic report
# (verify-report.mjs). Verification is evidence, never a gate (ADR-0035): the
# hold cap bounds every stay and a FAIL verdict never changes the action.
#
# Seams for the lane waves: verify_lane_states reads each lane's result for the
# head; verify_work_lanes starts or polls the lanes; verify_stop_lanes kills a
# lane whose card leaves Testing. VERIFY_BUILT_LANES lists the lanes that
# exist (both are built): a lane missing from it reads skipped:not-built, so it
# never holds a Testing card. The shell lane runs detached (verify_shell_*); the
# browser lane (verify_browser_*) queues a candidate for --browser, where
# browser_run's verify kind records its result.
VERIFY_DIR="$LOG_DIR/verify"
VERIFY_BUILT_LANES="shell,browser"
VERIFY_COLUMN_READY=""  # per-tick cache: "" unknown, 1 ready, 0 not ready

# Can a card be moved into Testing at all? The board needs the Testing option
# (set-status throws on an unknown one and the card would stay put) and the
# repo the status:testing label (gh --add-label refuses a label the repo lacks,
# so the swap would fail and the card keep its In Review label). Checked once
# per tick and cached; logged once when not ready. Either check failing reads
# as "not ready": the card goes to In Test as before, which is always safe.
# Never call this from a command substitution: the cache would die with the
# subshell. It logs with logerr only, so a caller's stdout stays clean.
verify_column_ready() {
  if [[ -z "$VERIFY_COLUMN_READY" ]]; then
    VERIFY_COLUMN_READY=0
    if ! node "$SCRIPT_DIR/lib/factory-project.mjs" has-status-option --name Testing \
        >/dev/null 2>>"$LOG_FILE"; then
      logerr "WARNING: verification is on but the board has no Testing column (or the lookup failed); cards go straight to In Test this tick (runbook: Pre-In-Test verification)"
    elif ! gh api "repos/JakubAnderwald/drafto/labels/status:testing" --silent \
        >/dev/null 2>>"$LOG_FILE"; then
      logerr "WARNING: verification is on but the repo has no status:testing label (or the lookup failed); cards go straight to In Test this tick (run scripts/setup-factory-labels.sh)"
    else
      VERIFY_COLUMN_READY=1
    fi
  fi
  [[ "$VERIFY_COLUMN_READY" == "1" ]]
}

# verify_switched_on <labels> — is verification on for a card with these
# labels? The switch, then the canary label (when one is set). <labels> is the
# board item's comma list (a JSON array is accepted too). No lookup at all.
verify_switched_on() {
  local labels="${1:-}"
  [[ "$FACTORY_VERIFY" == "1" ]] || return 1
  if [[ "$labels" == "["* ]]; then
    labels=$(echo "$labels" | jq -r 'map(tostring) | join(",")' 2>/dev/null || echo "")
  fi
  [[ -z "$FACTORY_VERIFY_ONLY_LABEL" || ",$labels," == *",$FACTORY_VERIFY_ONLY_LABEL,"* ]]
}

# verify_wanted <issue> <labels> — may this card be moved INTO Testing?
# Switched on for it, and the column ready. With the switch off it returns
# before any lookup, so the off path costs nothing. The Testing sweep asks only
# verify_switched_on: a card already in Testing keeps its round even when this
# tick's column lookup failed, instead of being drained as "verification off".
verify_wanted() {
  verify_switched_on "${2:-}" && verify_column_ready
}

# verify_target_status <issue> <head-sha> <labels> — where a card that is ready
# for a human goes next: Testing (exit 0) when it is to be verified and
# <head-sha> has no posted report yet; In Test (exit 1) otherwise: verification
# off or not wanted, or this commit was already verified and reported (e.g. a
# revision that changed nothing). No stdout: callers branch on the status and
# never run it in a subshell, where the column cache would be lost.
verify_target_status() {
  local issue_num="$1" head_sha="$2" labels="${3:-}" report_sha
  [[ -n "$head_sha" ]] || return 1
  verify_wanted "$issue_num" "$labels" || return 1
  report_sha=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" \
    --state-file "$STATE_FILE" 2>>"$LOG_FILE" | jq -r '.verifyReportSha // ""' 2>/dev/null || echo "")
  [[ "$report_sha" != "$head_sha" ]]
}

# Is <lane> (shell|browser) in FACTORY_VERIFY_LANES?
verify_lane_enabled() {
  [[ ",$FACTORY_VERIFY_LANES," == *",$1,"* ]]
}

# verify_sha_value <record> <sha> — the "<x>" of a "<sha>:<x>" state record when
# it belongs to <sha>, else nothing. verify_sha_count reads a "<sha>:<count>"
# counter the same way, 0 for another commit or an unreadable record.
verify_sha_value() {
  local record="$1" sha="$2"
  [[ -n "$sha" && "$record" == "$sha:"* ]] && printf '%s' "${record#"$sha":}"
  return 0
}
verify_sha_count() {
  local n
  n=$(verify_sha_value "$1" "$2")
  [[ "$n" =~ ^(0|[1-9][0-9]*)$ ]] || n=0
  echo "$n"
}

# verify_lane_states <state-json> <head-sha> <enabled 0|1> — the lanes' states
# for <head-sha> as {"shell":…,"browser":…}, the SHA stripped (the tokens
# verify-report.mjs renders). A lane's own record for this head wins; without
# one it is skipped:verification-off when verification is off,
# skipped:lane-off when FACTORY_VERIFY_LANES leaves it out, skipped:not-built
# until its wave lands, and `none` (still to run) otherwise. Stdout is the value.
verify_lane_states() {
  local state_json="$1" head_sha="$2" enabled="$3" lane field rec state out='{}'
  for lane in shell browser; do
    case "$lane" in shell) field=verifyShell ;; browser) field=verifyBrowser ;; esac
    rec=$(echo "$state_json" | jq -r --arg f "$field" '.[$f] // ""' 2>/dev/null || echo "")
    state=$(verify_sha_value "$rec" "$head_sha")
    if [[ -z "$state" ]]; then
      if [[ "$enabled" != "1" ]]; then
        state="skipped:verification-off"
      elif ! verify_lane_enabled "$lane"; then
        state="skipped:lane-off"
      elif [[ ",$VERIFY_BUILT_LANES," != *",$lane,"* ]]; then
        state="skipped:not-built"
      else
        state="none"
      fi
    fi
    out=$(echo "$out" | jq -c --arg l "$lane" --arg s "$state" '.[$l] = $s' 2>/dev/null || echo "$out")
  done
  echo "$out"
}

# verify_cr_note <issue> <head-sha> <state-json> — the CodeRabbit coverage note
# (ADR-0036) for the report and the Testing-stage scenario. The note the card
# carried into Testing is kept in verifyCrNote ("<sha>:<note>") because the
# report goes out on a later tick and a fail-open "coverage unknown (lane
# error)" note is recorded nowhere else; for any other commit it is rebuilt
# from the lane's state, as the In Test sweep does. Stdout is the value.
verify_cr_note() {
  local issue_num="$1" head_sha="$2" state_json="$3" rec
  rec=$(echo "$state_json" | jq -r '.verifyCrNote // ""' 2>/dev/null || echo "")
  if [[ -n "$head_sha" && "$rec" == "$head_sha:"* ]]; then
    printf '%s\n' "${rec#"$head_sha":}"
    return 0
  fi
  if [[ "${FACTORY_CR_CLI:-0}" == "1" ]]; then
    cr_coverage_note "$issue_num" "$head_sha"
  fi
}

# verify_begin_round <issue> <head-sha> <cr-note> <state-json> — start the
# card's round for <head-sha>: the SHA, the hold-cap clock and the coverage
# note. lastFeedbackAt is set only when the card has none: it is the
# consumed-feedback high-water mark, and moving it would swallow a comment the
# implementer hasn't seen. Attempts and the CodeRabbit run cap are NOT reset
# here but at the promotion to In Test, so a card that keeps bouncing between
# Testing and In Review still spends its fix budget and ends in Blocked (#463).
verify_begin_round() {
  local issue_num="$1" head_sha="$2" cr_note="$3" state_json="$4" now hwm
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" verifySha "$head_sha" \
    --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" verifyStartedAt "$now" \
    --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" verifyCrNote "$head_sha:$cr_note" \
    --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  hwm=$(echo "$state_json" | jq -r '.lastFeedbackAt // ""' 2>/dev/null || echo "")
  if [[ -z "$hwm" || "$hwm" == "null" ]]; then
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" lastFeedbackAt "$now" \
      --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  fi
}

# verify_prepare <issue> <pr> <pr-obj> <pr-view> <head-sha> <diff-files>
#   <platforms> <cr-note> <state-json>
# What a Testing card needs before (and while) its lanes run, all idempotent so
# the sweep can call it every tick: learn how earlier beta lanes ended and
# re-arm failed ones, dispatch any beta lane missing for this commit, and write
# the scenario (Testing wording) if there is none for this commit yet. The same
# steps the In Test sweep runs, moved earlier so builds start sooner (amends
# ADR-0030's timing). <platforms> are the plain ones and drive the betas; the
# scenario is written with scenario_platforms, the verification variant once
# the round has started, so a packages/shared/-only PR gets the ### Web section
# its browser lane walks (ADR-0053, 5C).
verify_prepare() {
  local issue_num="$1" pr_num="$2" pr_obj="$3" pr_view="$4" head_sha="$5" diff_files="$6"
  local platforms="$7" cr_note="$8" state_json="$9" beta scenario_sha scenario_plats
  intest_check_lane_outcomes "$issue_num" "$head_sha" "$pr_num" || true
  beta=$(intest_dispatch_betas "$issue_num" "$pr_num" "$head_sha" "$platforms" 2>>"$LOG_FILE" \
    || echo '{"dispatched":[],"skipped":[],"manualCommands":[]}')
  [[ -n "$beta" ]] || beta='{"dispatched":[],"skipped":[],"manualCommands":[]}'
  scenario_sha=$(echo "$state_json" | jq -r '.intestCommentSha // ""' 2>/dev/null || echo "")
  if [[ "$scenario_sha" == "$head_sha" ]]; then
    return 0
  fi
  scenario_plats=$(scenario_platforms "$issue_num" "$head_sha" "$diff_files" "$platforms")
  INTEST_STAGE=testing intest_handoff "$issue_num" "$pr_num" "$pr_obj" "$(pr_preview_url "$pr_view")" \
    "$(pr_failing_advisory "$pr_view")" "$head_sha" "$diff_files" "$scenario_plats" "$beta" "$cr_note" || true
}

# verify_enter <item-id> <issue> <pr> <pr-obj> <pr-view> <head-sha>
#   <diff-files> <platforms> <cr-note>
# In Review → Testing, at the slot where today's In Test promotion sits. Advance
# first (ADR-0030): the card must reach Testing even if the scenario writer
# fails. Returns 1 only when the move itself failed, so the caller falls
# through to the In Test promotion exactly as it would without verification.
verify_enter() {
  local item_id="$1" issue_num="$2" pr_num="$3" pr_obj="$4" pr_view="$5" head_sha="$6"
  local diff_files="$7" platforms="$8" cr_note="${9:-}" state_json
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN: would move #$issue_num to Testing to verify ${head_sha:0:12} before In Test, write the Testing-stage scenario and dispatch betas"
    return 0
  fi
  if ! transition_status "$item_id" "$issue_num" "Testing"; then
    log "WARNING: couldn't move #$issue_num to Testing; promoting it straight to In Test as before"
    return 1
  fi
  log "Issue #$issue_num: → Testing (verifying ${head_sha:0:12} before In Test, ADR-0053)"
  state_json=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" \
    --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo "{}")
  verify_begin_round "$issue_num" "$head_sha" "$cr_note" "$state_json"
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" lastWatchAt \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  verify_prepare "$issue_num" "$pr_num" "$pr_obj" "$pr_view" "$head_sha" "$diff_files" \
    "$platforms" "$cr_note" "$state_json"
  return 0
}

# Seam: start or poll the verification lanes for one card. The shell lane
# starts here (verify_shell_work: verify-lane.mjs start when its state for
# <head-sha> isn't terminal); the browser lane queues its
# `verify:<issue>:<pr>:<sha>` candidate for --browser (verify_browser_work).
# Commentary like the rest of the stage: it must never fail the tick. Args:
# <issue> <pr> <head-sha> <platforms-json> <lane-states-json>, where the
# platforms are the verification variant (VERIFY_LANE_PLATFORMS: a
# packages/shared/ change counts as web, with webViaShared).
verify_work_lanes() {
  verify_shell_work "$@" || true
  verify_browser_work "$@" || true
  return 0
}

# Seam: stop whatever lane is still running for <issue> because its card is
# leaving Testing: a hand-back, or a promotion that didn't wait for every lane
# (hold cap, feedback, verification off). Called on every exit, so a no-op when
# nothing runs. verify_shell_stop kills the shell lane here; housekeeping also
# kills a run whose card left Testing, so this is the prompt path, not the only
# one. verify_browser_stop drops the card's browser candidate (a browser run is
# never in flight while --watch runs). Args: <issue> <head-sha> <reason>.
verify_stop_lanes() {
  verify_shell_stop "$@" || true
  verify_browser_stop "$@" || true
  return 0
}

# ── The shell lane (ADR-0053, Wave 5A) ─────────────────────────────────────
# A detached, guarded `--no-chrome` claude session in its own worktree of the
# PR head (scripts/lib/verify-lane.mjs, scripts/lib/verify-guard.mjs, prompt
# scripts/factory-verify-prompt.md): targeted tests, the scenario's command
# steps, the macOS --preflight, and API checks on the preview through the
# preview-curl wrapper. Like the CodeRabbit CLI lane (ADR-0036) it never blocks
# the tick: verify_shell_work starts it, verify_shell_housekeeping (top of
# --watch) collects it, verify_shell_stop kills it. Its claude call lives in
# node, never here.

# verify_shell_work <issue> <pr> <head-sha> <platforms-json> <lane-states-json>
# Start the shell lane for <head-sha> unless its state is already terminal.
# A refusal becomes a lane state where waiting can't help or the report should
# say why (attempts spent → skipped:attempts; a missing tool → unavailable:…;
# memory, disk, another card's run, a pause → deferred:…, which stays pending
# and reads as skipped:<why> if the hold cap comes first); anything else
# (a preview or scenario still on its way, a moved head, a failed start) is
# simply tried again next tick. Never fails the tick; logs only under
# --dry-run.
verify_shell_work() {
  local issue_num="$1" pr_num="$2" head_sha="$3" platforms="${4:-}" lanes="${5:-}"
  local state out started reason rec
  [[ -n "$platforms" ]] || platforms='{}'
  [[ -n "$lanes" ]] || lanes='{}'
  verify_lane_enabled shell || return 0
  [[ ",$VERIFY_BUILT_LANES," == *",shell,"* ]] || return 0
  state=$(echo "$lanes" | jq -r '.shell // "none"' 2>/dev/null || echo "none")
  case "${state%%:*}" in
    reported|timeout|unavailable|stale-branch|no-preview|skipped) return 0 ;;
  esac
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN: would start the verification shell lane for #$issue_num at ${head_sha:0:12}"
    return 0
  fi
  if ! out=$(node "$SCRIPT_DIR/lib/verify-lane.mjs" start --issue "$issue_num" --pr "$pr_num" \
      --sha "$head_sha" --platforms "$platforms" --state-file "$STATE_FILE" \
      --repo-root "$REPO_ROOT" --run-root "$VERIFY_DIR" --prompt-file "$VERIFY_PROMPT_FILE" \
      --account-file "$FACTORY_BROWSER_ACCOUNT_FILE" \
      --signin-key-file "$FACTORY_BROWSER_SIGNIN_KEY_FILE" --signin-lease-file "$SIGNIN_LEASE_FILE" \
      --effort "${FACTORY_PLAN_EFFORT:-xhigh}" --install-timeout-sec "${INSTALL_TIMEOUT_SEC:-600}" \
      --min-free-disk-gb "${FACTORY_MIN_FREE_DISK_GB:-3}" 2>>"$LOG_FILE"); then
    log "WARNING: issue #$issue_num: the verification shell lane couldn't be started (non-fatal; retried next tick)"
    return 0
  fi
  out=$(printf '%s\n' "$out" | tail -1)
  started=$(echo "$out" | jq -r '.started // false' 2>/dev/null || echo "false")
  if [[ "$started" == "true" ]]; then
    log "Issue #$issue_num: verification shell lane started for ${head_sha:0:12}: $out"
    return 0
  fi
  reason=$(echo "$out" | jq -r '.reason // ""' 2>/dev/null || echo "")
  case "$reason" in
    attempts) rec="skipped:attempts" ;;
    memory|disk|busy|lane-paused) rec="deferred:$reason" ;;
    factory-paused) rec="deferred:paused" ;;
    claude-missing|pnpm-missing|curl-missing|perl-missing|nice-missing|prompt-missing) rec="unavailable:$reason" ;;
    *) rec="" ;;
  esac
  # A deferral never hides an earlier attempt's outcome: a retry:<why> left by
  # the last run says more than why this start had to wait.
  if [[ "$state" == retry:* && "$rec" == deferred:* ]]; then
    rec=""
  fi
  if [[ -n "$rec" && "$state" != "$rec" ]]; then
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" verifyShell "$head_sha:$rec" \
      --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  fi
  case "$reason" in
    running|preview-wait|scenario-wait|hold-cap-near) ;;
    *) log "Issue #$issue_num: verification shell lane not started (${reason:-no reason}${rec:+ → $rec}): $out" ;;
  esac
  return 0
}

# verify_shell_stop <issue> <head-sha> <reason> — stop <issue>'s shell run, if
# one is in flight (the card is leaving Testing). Its attempt is refunded.
verify_shell_stop() {
  local issue_num="$1" head_sha="${2:-}" reason="${3:-stop}" out state
  [[ "$DRY_RUN" -eq 1 ]] && return 0
  if ! out=$(node "$SCRIPT_DIR/lib/verify-lane.mjs" stop --issue "$issue_num" --sha "$head_sha" \
      --reason "$reason" --state-file "$STATE_FILE" --repo-root "$REPO_ROOT" \
      --run-root "$VERIFY_DIR" 2>>"$LOG_FILE"); then
    log "WARNING: issue #$issue_num: stopping the verification shell lane failed; housekeeping reaps it"
    return 0
  fi
  out=$(printf '%s\n' "$out" | tail -1)
  state=$(echo "$out" | jq -r '.state // ""' 2>/dev/null || echo "")
  if [[ "$state" == "stopped" ]]; then
    log "Issue #$issue_num: verification shell lane stopped ($reason): $out"
  elif [[ "$state" == "error" ]]; then
    log "WARNING: issue #$issue_num: stopping the verification shell lane: $out"
  fi
  return 0
}

# verify_shell_housekeeping — top of every --watch tick, like
# cr_cli_housekeeping and NOT gated on FACTORY_VERIFY: a run started before the
# switch was flipped off still owns a worktree and the lane's slot, and the
# module winds it down itself. Collects a finished run (records verifyShell),
# kills an overdue one or one whose head moved, PR closed or card left
# Testing, and reaps old worktrees and run dirs. A run that ended on a Claude
# session limit comes back with sessionLimit: the factory is paused the same
# way every other claude call pauses it, and VERIFY_SESSION_LIMITED tells
# --watch to end the tick.
verify_shell_housekeeping() {
  local out state reaped reset
  VERIFY_SESSION_LIMITED=0
  if ! out=$(node "$SCRIPT_DIR/lib/verify-lane.mjs" housekeeping --state-file "$STATE_FILE" \
      --repo-root "$REPO_ROOT" --run-root "$VERIFY_DIR" --dry-run "${DRY_RUN:-0}" 2>>"$LOG_FILE"); then
    log "WARNING: verification shell-lane housekeeping failed (non-fatal; retried next tick)"
    return 0
  fi
  out=$(printf '%s\n' "$out" | tail -1)
  [[ -n "$out" ]] || return 0
  state=$(echo "$out" | jq -r '.state // ""' 2>/dev/null || echo "")
  reaped=$(echo "$out" | jq -r '((.reaped.worktrees // []) + (.reaped.runDirs // []) + (.reaped.privateDirs // [])) | length' 2>/dev/null || echo "0")
  [[ -n "$reaped" ]] || reaped="0"
  reset=$(echo "$out" | jq -r '.sessionLimit.resetAt // ""' 2>/dev/null || echo "")
  case "$state" in
    # Every tick, lane on or off: stay quiet unless something happened.
    idle|starting|running)
      [[ "$reaped" == "0" ]] && return 0
      ;;
    error)
      log "WARNING: verification shell-lane housekeeping error (non-fatal; retried next tick): $out"
      return 0
      ;;
  esac
  log "Verification shell lane: $out"
  if [[ -n "$reset" && "${DRY_RUN:-0}" -eq 0 ]]; then
    SESSION_LIMIT_RESET_AT="$reset"
    SESSION_LIMIT_REASON=$(echo "$out" | jq -r '.sessionLimit.reason // ""' 2>/dev/null || echo "")
    pause_for_session_limit
    VERIFY_SESSION_LIMITED=1
  fi
  return 0
}

# ── The browser lane (ADR-0053, Wave 5B) ───────────────────────────────────
# The browser runner's `verify` kind (ADR-0051): verify_browser_work queues a
# candidate, --browser runs it (browser_run verify), verify_browser_record and
# verify_browser_finish keep its result. There is still exactly one claude call
# with --chrome, run_browser_task.

# verify_state_terminal <state> — is a lane state (SHA stripped) final for its
# commit? The same kinds verify-decide.mjs counts as done (TERMINAL_KINDS
# there); anything else still has work to do: "none" and "", the shell lane's
# running, retry:<why> and deferred:<why>, the browser lane's
# waiting-preview:<iso>.
verify_state_terminal() {
  case "${1%%:*}" in
    reported|timeout|unavailable|stale-branch|no-preview|skipped) return 0 ;;
    *) return 1 ;;
  esac
}

# verify_browser_work <issue> <pr> <head-sha> <platforms-json> <lane-states-json>
# The browser lane's part of working the lanes. For a web card whose lane has
# no result for this commit yet, queue a `verify` candidate: --browser runs it
# after --release (browser_run verify), because a Chrome session must never hold
# up the tick or a merge (ADR-0051). <platforms-json> is the verification
# variant (verify_platforms_of), so "web" covers a diff that touches apps/web/
# or packages/shared/, which the web app imports (ADR-0053, 5C). What can be
# settled here, without Chrome, ends the lane at once instead of leaving it to
# the hold cap: a diff that reaches the web app through neither
# (skipped:not-web) and a runner whose verify kind is off (skipped:browser-off).
# Platforms that couldn't be read ({}) wait for the next tick. A lane switched
# off or not built does nothing, like verify_shell_work (verify_lane_states
# already reads it as skipped:lane-off / skipped:not-built). browser_run's
# verify kind re-checks no platform: it runs the scenario's ### Web section,
# which the Testing-stage scenario has for the same variant (verify_prepare).
verify_browser_work() {
  local issue_num="$1" pr_num="$2" head_sha="$3" platforms="$4" lanes="$5" st web
  verify_lane_enabled browser || return 0
  [[ ",$VERIFY_BUILT_LANES," == *",browser,"* ]] || return 0
  st=$(echo "$lanes" | jq -r '.browser // "none"' 2>/dev/null || echo "none")
  if verify_state_terminal "$st"; then
    return 0
  fi
  web=$(echo "$platforms" | jq -r 'if type == "object" and has("web") then (.web | tostring) else "unknown" end' \
    2>/dev/null || echo "unknown")
  case "$web" in
    true) ;;
    false)
      verify_browser_record "$issue_num" "$head_sha" "skipped:not-web" || true
      return 0
      ;;
    *)
      log "Issue #$issue_num: PR #$pr_num's platforms are unknown this tick; the browser lane waits"
      return 0
      ;;
  esac
  if ! browser_kind_enabled verify; then
    verify_browser_record "$issue_num" "$head_sha" "skipped:browser-off" || true
    return 0
  fi
  [[ "$issue_num" =~ ^[0-9]+$ && "$pr_num" =~ ^[0-9]+$ && "$head_sha" =~ ^[0-9a-f]{40}$ ]] || return 0
  case " ${VERIFY_BROWSER_CANDIDATES:-} " in
    *" verify:$issue_num:"*) ;;
    *) VERIFY_BROWSER_CANDIDATES="${VERIFY_BROWSER_CANDIDATES:+$VERIFY_BROWSER_CANDIDATES }verify:$issue_num:$pr_num:$head_sha" ;;
  esac
  if [[ "$(echo "$platforms" | jq -r '.webViaShared // false' 2>/dev/null)" == "true" ]]; then
    log "Issue #$issue_num: browser lane queued for --browser (${head_sha:0:12}; web via packages/shared/)"
  else
    log "Issue #$issue_num: browser lane queued for --browser (${head_sha:0:12})"
  fi
  return 0
}

# verify_browser_stop <issue> <head-sha> <reason> — the browser lane's part of
# stopping the lanes. A verify run is synchronous inside --browser, which never
# overlaps --watch (the loop runs the modes one after another), so no run is
# ever in flight when this is called; stopping means not starting one: drop the
# card's candidate if this tick queued it. --browser re-checks the column and
# the round before it runs anything anyway.
verify_browser_stop() {
  local issue_num="$1" c out=""
  for c in ${VERIFY_BROWSER_CANDIDATES:-}; do
    [[ "$c" == "verify:$issue_num:"* ]] || out="${out:+$out }$c"
  done
  VERIFY_BROWSER_CANDIDATES="$out"
  return 0
}

# verify_browser_record <issue> <head-sha> <state> [<run-dir>] — the browser
# lane's result for <head-sha> as verify_lane_states reads it
# (verifyBrowser="<sha>:<state>"), written with its run dir. The dir is always
# written first, empty when no session ran: verify_compose_report attaches
# verifyBrowserRunDir to any record for the head, so an older run's dir must
# never sit beside a newer result (a dir written without its state is never
# read). Returns 1 when the state itself couldn't be written, so a caller never
# acts on a result that isn't there. Nothing in a dry run.
verify_browser_record() {
  local issue_num="$1" head_sha="$2" st="$3" run_dir="${4:-}"
  [[ "$DRY_RUN" -eq 0 ]] || return 0
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" verifyBrowserRunDir "$run_dir" \
    --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  if ! node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" verifyBrowser "$head_sha:$st" \
      --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1; then
    log "WARNING: couldn't record #$issue_num's browser lane result for ${head_sha:0:12} ($st); the lane stays open"
    return 1
  fi
  log "Issue #$issue_num: browser lane for ${head_sha:0:12}: $st"
  return 0
}

# verify_browser_finish <issue> <head-sha> <state> <run-dir> — record the result
# of a verify run that got a browser session, but only while the run still
# belongs to the card's round: the round still for <head-sha> and the card
# still in Testing. A session can take FACTORY_BROWSER_TIMEOUT_SEC, and a card
# dragged out of Testing meanwhile keeps no result (the evidence stays in
# <run-dir>), so the In Test run can still report on the commit. Returns 0 when
# it recorded the result for a card the board shows in Testing, 2 when it
# recorded it although the board couldn't be read (the round check passed; the
# caller then doesn't claim the commit for the browser runner, so the In Test
# run stays possible), and 1 when it recorded nothing.
verify_browser_finish() {
  local issue_num="$1" head_sha="$2" st="$3" run_dir="${4:-}" items n confirmed=0
  if [[ "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" --state-file "$STATE_FILE" \
      2>>"$LOG_FILE" | jq -r '.verifySha // ""' 2>/dev/null)" != "$head_sha" ]]; then
    log "Issue #$issue_num: its verification round moved on during the browser run; not recording $st (evidence in $run_dir)"
    return 1
  fi
  if items=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items --status "Testing" 2>>"$LOG_FILE"); then
    n=$(echo "$items" | jq --argjson n "$issue_num" '[.[] | select(.issueNumber == $n)] | length' 2>/dev/null || echo "")
    if [[ "$n" == "0" ]]; then
      log "Issue #$issue_num: left Testing during the browser run; not recording $st (evidence in $run_dir)"
      return 1
    fi
    [[ ! "$n" =~ ^[1-9][0-9]*$ ]] || confirmed=1
  fi
  [[ "$confirmed" -eq 1 ]] \
    || log "WARNING: couldn't check that #$issue_num is still in Testing; recording its browser lane result anyway"
  verify_browser_record "$issue_num" "$head_sha" "$st" "$run_dir" || return 1
  [[ "$confirmed" -eq 1 ]] || return 2
  return 0
}

# verify_browser_preview_wait <issue> <head-sha> <state-json> — the verify lane
# found no successful preview deployment of <head-sha>. The wait is counted
# from the lane's first miss, kept in its state as the non-terminal
# waiting-preview:<iso>, not from the round's start: a round can start while CI
# is still running, well before the lane is first queued. After
# FACTORY_VERIFY_PREVIEW_WAIT_MIN the lane ends as no-preview. (A GitHub error
# never gets here: preview_url_for_sha returns 2 for it, and the run just waits.)
verify_browser_preview_wait() {
  local issue_num="$1" head_sha="$2" state_json="$3" st
  st=$(verify_sha_value "$(echo "$state_json" | jq -r '.verifyBrowser // ""' 2>/dev/null)" "$head_sha")
  if [[ "$st" != waiting-preview:* ]]; then
    verify_browser_record "$issue_num" "$head_sha" "waiting-preview:$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return
  fi
  [[ "$(iso_age_min "${st#waiting-preview:}")" -ge "$FACTORY_VERIFY_PREVIEW_WAIT_MIN" ]] || return 0
  log "Issue #$issue_num: still no successful Vercel preview deployment for ${head_sha:0:12} ${FACTORY_VERIFY_PREVIEW_WAIT_MIN} min after the browser lane first looked; it ends without a run"
  verify_browser_record "$issue_num" "$head_sha" "no-preview"
}

# verify_browser_unclaim <issue> <head-sha> <state-json> — the verification
# report can't carry the browser lane's result for <head-sha>: the minimal
# notice went out instead, or posting it was given up. When that result is what
# claimed the commit for the browser runner (browserRunSha), release it, so the
# In Test run reports on the commit after all (the fallback). A commit an In
# Test run claimed itself (skipped:already-run) keeps its claim.
verify_browser_unclaim() {
  local issue_num="$1" head_sha="$2" state_json="$3" st
  [[ -n "$head_sha" && "$DRY_RUN" -eq 0 ]] || return 0
  [[ "$(echo "$state_json" | jq -r '.browserRunSha // ""' 2>/dev/null)" == "$head_sha" ]] || return 0
  st=$(verify_sha_value "$(echo "$state_json" | jq -r '.verifyBrowser // ""' 2>/dev/null)" "$head_sha")
  case "$st" in
    reported|reported:*|stale-branch) ;;
    *) return 0 ;;
  esac
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" browserRunSha "" \
    --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  log "Issue #$issue_num: the verification report can't show the browser lane's result for ${head_sha:0:12}; the In Test browser run will report instead if the PR touches apps/web/ (a packages/shared/-only PR has no In Test run)"
  return 0
}

# verify_browser_preflight_reason <preflight-word> — the lane-state reason for a
# failed browser-health.mjs preflight (verify-report.mjs reads each as a
# sentence).
verify_browser_preflight_reason() {
  case "$1" in
    chrome-not-running) echo "chrome-not-running" ;;
    disabled:*) echo "runner-disabled" ;;
    account-*) echo "account" ;;
    signin-key-*) echo "signin-key" ;;
    *) echo "preflight" ;;
  esac
}

# verify_hand_back <item-id> <issue> <pr> <head-sha> <reason> <state-json>
#   [<open-threads>]
# Testing → In Review, for a reason about the commit rather than the evidence:
# head-moved, ci-red, not-reviewed or threads. In Review's fix loop is the only
# place those get fixed. Thread hand-backs are counted per commit
# (verifyBounces), the budget verify-decide.mjs stops bouncing on threads at;
# the others aren't, because each is already bounded (a new commit, the fix
# loop's attempts, a review that runs once per commit). Attempts are NOT reset,
# so an oscillation still burns the fix budget toward Blocked (#463). One short
# comment per commit and reason; a failed move leaves everything for the next
# tick.
verify_hand_back() {
  local item_id="$1" issue_num="$2" pr_num="$3" head_sha="$4" reason="$5" state_json="$6"
  local threads="${7:-}" bounces why marker
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN: would hand #$issue_num back to In Review ($reason) and stop its verification lanes"
    return 0
  fi
  verify_stop_lanes "$issue_num" "$head_sha" "$reason" || true
  if ! transition_status "$item_id" "$issue_num" "In Review"; then
    log "WARNING: couldn't hand #$issue_num back to In Review ($reason); it stays in Testing for the next tick"
    return 1
  fi
  if [[ "$reason" == "threads" ]]; then
    bounces=$(verify_sha_count "$(echo "$state_json" | jq -r '.verifyBounces // ""' 2>/dev/null || echo "")" "$head_sha")
    bounces=$((bounces + 1))
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" verifyBounces "$head_sha:$bounces" \
      --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    log "Issue #$issue_num: Testing → In Review (threads; thread hand-back $bounces/$FACTORY_VERIFY_BOUNCE_MAX for ${head_sha:0:12})"
  else
    log "Issue #$issue_num: Testing → In Review ($reason, ${head_sha:0:12})"
  fi
  case "$reason" in
    head-moved) why="PR #$pr_num's head moved to \`${head_sha:0:12}\` while the previous commit was being verified." ;;
    ci-red) why="A required check is red on PR #$pr_num at \`${head_sha:0:12}\`." ;;
    not-reviewed) why="\`${head_sha:0:12}\` hasn't been through the factory's code review yet." ;;
    threads) why="PR #$pr_num has ${threads:-some} unresolved review thread(s) on \`${head_sha:0:12}\`." ;;
    *) why="PR #$pr_num at \`${head_sha:0:12}\` isn't ready to verify ($reason)." ;;
  esac
  marker="drafto-factory-verify-handback:${head_sha:0:12}:$reason"
  if ! issue_has_marker "$issue_num" "$marker"; then
    gh issue comment "$issue_num" --repo JakubAnderwald/drafto \
      --body "🏭 **Back to In Review before verification.**

$why In Review's fix loop takes it from here; the card comes back to **Testing** \
by itself once CI is green, the commit is reviewed and every thread is answered. \
This is about the commit, not a test result: verification never holds a card back.

<!-- $marker -->" >>"$LOG_FILE" 2>&1 || true
  fi
  return 0
}

# verify_pr_platforms <pr> — set VERIFY_DIFF_FILES, VERIFY_PLATFORMS (the
# platforms derived from the PR diff, as the In Review path derives them; the
# betas use them) and VERIFY_LANE_PLATFORMS (their verification variant,
# verify_platforms_of; the lanes and the report use it). Returns 1, with both
# '{}', when the diff can't be read.
verify_pr_platforms() {
  VERIFY_DIFF_FILES=""
  VERIFY_PLATFORMS='{}'
  VERIFY_LANE_PLATFORMS='{}'
  if ! VERIFY_DIFF_FILES=$(gh pr diff "$1" --repo JakubAnderwald/drafto --name-only 2>>"$LOG_FILE"); then
    VERIFY_DIFF_FILES=""
    return 1
  fi
  VERIFY_PLATFORMS=$(printf '%s\n' "$VERIFY_DIFF_FILES" \
    | node "$SCRIPT_DIR/lib/dispatch-release.mjs" derive-platforms --diff-file - 2>>"$LOG_FILE" || echo '{}')
  [[ -n "$VERIFY_PLATFORMS" ]] || VERIFY_PLATFORMS='{}'
  VERIFY_LANE_PLATFORMS=$(verify_platforms_of "$VERIFY_DIFF_FILES")
  return 0
}

# verify_platforms_of <diff-files> — the verification variant of the PR's
# platforms (derive-platforms --verify, ADR-0053's 5C): mobile and desktop as
# the plain derivation has them, web also true when packages/shared/ changed
# (the web app imports it), and webViaShared when that is the only way web
# came in. Only the verification stage reads it: the betas, the In Test
# platforms, the parity check and the preview gate keep the plain derivation.
# '{}' when it can't be derived. Stdout is the value.
verify_platforms_of() {
  local out
  out=$(printf '%s\n' "$1" \
    | node "$SCRIPT_DIR/lib/dispatch-release.mjs" derive-platforms --verify --diff-file - 2>>"$LOG_FILE") \
    || out=""
  [[ -n "$out" ]] || out='{}'
  printf '%s\n' "$out"
}

# scenario_platforms <issue> <head-sha> <diff-files> <platforms> — the
# platforms a test scenario for <head-sha> is written with: <platforms> (the
# plain ones), unless <head-sha> has a verification round (verifySha). The
# Testing column's scenario is then written with the verification variant
# (verify_platforms_of), so a packages/shared/-only PR gets the ### Web section
# its browser lane walks, and any later rewrite for that same commit keeps it:
# the In Review promotion re-posts the scenario for a card handed back without
# a new commit (a thread, a red check, a drag back). Falls back to <platforms>
# when the state or the variant can't be read. Stdout is the value. Named
# outside verify_* because every scenario writer calls it, the In Test
# promotion and the In Test sweep included, not only the Testing stage.
scenario_platforms() {
  local issue_num="$1" head_sha="$2" diff_files="$3" platforms="$4" round out
  if [[ -n "$head_sha" ]]; then
    round=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" \
      --state-file "$STATE_FILE" 2>>"$LOG_FILE" | jq -r '.verifySha // ""' 2>/dev/null || echo "")
    if [[ "$round" == "$head_sha" ]]; then
      out=$(verify_platforms_of "$diff_files")
      if [[ "$out" != "{}" ]]; then
        printf '%s\n' "$out"
        return 0
      fi
    fi
  fi
  printf '%s\n' "$platforms"
}

# verify_scenario_file <comments-json> <head-sha> <out> — write the factory's
# scenario comment for exactly <head-sha> to <out>: the one the browser runner
# runs, chosen by factory-bundle.mjs's selectScenarioComment (OWNER, the exact
# full-SHA marker, not the fallback). Returns 1, with no file, when there is
# none. Arguments travel in the environment: an extra argv word would make the
# imported module think it is the entry point and run its own CLI.
verify_scenario_file() {
  local comments_json="$1" head_sha="$2" out="$3"
  if printf '%s' "$comments_json" \
      | VERIFY_BUNDLE_LIB="$SCRIPT_DIR/lib/factory-bundle.mjs" VERIFY_HEAD_SHA="$head_sha" node -e '
          let buf = "";
          process.stdin.on("data", (d) => { buf += d; });
          process.stdin.on("end", async () => {
            const { selectScenarioComment } = await import(process.env.VERIFY_BUNDLE_LIB);
            const c = selectScenarioComment(JSON.parse(buf || "[]"), process.env.VERIFY_HEAD_SHA);
            if (c) process.stdout.write(c.body);
          });' >"$out" 2>>"$LOG_FILE" && [[ -s "$out" ]]; then
    return 0
  fi
  rm -f "$out"
  return 1
}

# verify_compose_report <issue> <pr> <head-sha> <platforms> <lanes-json>
#   <cr-note> <comments-json> <state-json> <gaps-json> <body-file>
# Compose the verification report into <body-file> with verify-report.mjs. The
# secret files are the ones the lanes could have held: the browser runner's
# test account and sign-in key, and the bypass secret. Each is passed when its
# file exists, so an existing but unreadable one withholds the lane text
# (failing closed); a file that isn't there is passed as "", because the lanes
# read their secrets from these same paths and so never had it. The one
# exception is the bypass secret of a shell run that was given it: its path is
# passed even if the file has gone since, so the composer fails closed instead
# of skipping a literal the lane did hold. The shell run's own facts also add
# their coverage gaps (no bypass secret, no preview, no session). Returns 1
# when the composer fails.
verify_compose_report() {
  local issue_num="$1" pr_num="$2" head_sha="$3" platforms="$4" lanes="$5" cr_note="$6"
  local comments_json="$7" state_json="$8" gaps="$9" body_file="${10}"
  local scenario_file beta_lanes="" bypass="" account="" signin_key="" shell_dir="" browser_dir="" out
  local lane_facts merged
  mkdir -p "$VERIFY_DIR" 2>>"$LOG_FILE" || return 1
  scenario_file="$VERIFY_DIR/report-$issue_num-$head_sha.scenario.md"
  verify_scenario_file "$comments_json" "$head_sha" "$scenario_file" || scenario_file=""
  # The beta lanes dispatched for this commit, as intest_dispatch_betas recorded
  # them: read, never re-dispatched, so composing a report can't start a build.
  if [[ "$(echo "$state_json" | jq -r '.intestBetaSha // ""' 2>/dev/null)" == "$head_sha" ]]; then
    beta_lanes=$(echo "$state_json" | jq -r '.intestBetaLanes // ""' 2>/dev/null || echo "")
  fi
  [[ -e "$FACTORY_VERIFY_BYPASS_FILE" ]] && bypass="$FACTORY_VERIFY_BYPASS_FILE"
  [[ -e "$FACTORY_BROWSER_ACCOUNT_FILE" ]] && account="$FACTORY_BROWSER_ACCOUNT_FILE"
  [[ -e "$FACTORY_BROWSER_SIGNIN_KEY_FILE" ]] && signin_key="$FACTORY_BROWSER_SIGNIN_KEY_FILE"
  # A lane's run dir only belongs in this report when its result is for this commit.
  if [[ -n "$(verify_sha_value "$(echo "$state_json" | jq -r '.verifyShell // ""' 2>/dev/null)" "$head_sha")" ]]; then
    shell_dir=$(echo "$state_json" | jq -r '.verifyShellRunDir // ""' 2>/dev/null || echo "")
  fi
  if [[ -n "$(verify_sha_value "$(echo "$state_json" | jq -r '.verifyBrowser // ""' 2>/dev/null)" "$head_sha")" ]]; then
    browser_dir=$(echo "$state_json" | jq -r '.verifyBrowserRunDir // ""' 2>/dev/null || echo "")
  fi
  if [[ -n "$shell_dir" && -d "$shell_dir" ]] \
      && lane_facts=$(node "$SCRIPT_DIR/lib/verify-lane.mjs" gaps --run-dir "$shell_dir" 2>>"$LOG_FILE"); then
    lane_facts=$(printf '%s\n' "$lane_facts" | tail -1)
    if [[ "$(echo "$lane_facts" | jq -r '.bypassUsed // false' 2>/dev/null)" == "true" ]]; then
      bypass="$FACTORY_VERIFY_BYPASS_FILE"
    fi
    if merged=$(jq -nc --argjson a "$gaps" --argjson b "$lane_facts" '$a + ($b.gaps // [])' 2>/dev/null) \
        && [[ -n "$merged" ]]; then
      gaps="$merged"
    fi
  fi
  if ! out=$(node "$SCRIPT_DIR/lib/verify-report.mjs" render --issue "$issue_num" --pr "$pr_num" \
      --sha "$head_sha" --scenario-file "$scenario_file" --platforms "$platforms" \
      --beta-lanes "$beta_lanes" \
      --shell-state "$(echo "$lanes" | jq -r '.shell // "none"' 2>/dev/null || echo none)" \
      --shell-dir "$shell_dir" \
      --browser-state "$(echo "$lanes" | jq -r '.browser // "none"' 2>/dev/null || echo none)" \
      --browser-dir "$browser_dir" --gaps "$gaps" --cr-note "$cr_note" \
      --account-file "$account" --bypass-file "$bypass" \
      --signin-key-file "$signin_key" --out "$body_file" 2>>"$LOG_FILE"); then
    return 1
  fi
  [[ -s "$body_file" ]] || return 1
  log "Issue #$issue_num: verification report for ${head_sha:0:12} composed: $(printf '%s\n' "$out" | tail -1)"
  return 0
}

# verify_minimal_report <pr> <head-sha> <body-file> — the deterministic notice
# posted when the report can't be composed. It carries both report markers, so
# post-once and the feedback filter treat it like the real one.
verify_minimal_report() {
  local pr_num="$1" head_sha="$2" body_file="$3"
  mkdir -p "$VERIFY_DIR" 2>>"$LOG_FILE" || true
  printf '%s\n' "🏭 **Verification before In Test**

**Verdict: INCOMPLETE** for \`${head_sha:0:12}\` (PR #$pr_num): the verification \
report couldn't be composed, so there is no automated evidence for this commit.

Evidence, not a gate: the card is now In Test. Test it by hand from the test \
scenario above.

<!-- drafto-factory-verify-report -->
<!-- drafto-factory-verify-sha:$head_sha -->" >"$body_file" 2>>"$LOG_FILE"
}

# verify_post_report <issue> <head-sha> <body-file> — post the report once per
# commit. Skips (and records) when an OWNER comment already carries this
# commit's sha marker: anyone can paste a marker on a public repo, but only the
# factory's identity counts. Records verifyReportSha on success; counts a
# failure (unreadable comments included) in verifyReportPosts so the In Test
# sweep's retries stop at VERIFY_REPORT_POST_MAX. Returns 0 once it's posted.
verify_post_report() {
  local issue_num="$1" head_sha="$2" body_file="$3" comments rec n
  if comments=$(fetch_issue_comments "$issue_num" 2>>"$LOG_FILE") && [[ -n "$comments" ]]; then
    if echo "$comments" | jq -e --arg m "drafto-factory-verify-sha:$head_sha" \
        'any(.[]; .authorAssociation == "OWNER" and ((.body // "") | contains($m)))' >/dev/null 2>&1; then
      log "Issue #$issue_num: verification report for ${head_sha:0:12} is already on the issue"
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" verifyReportSha "$head_sha" \
        --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      return 0
    fi
    if [[ -s "$body_file" ]] && gh issue comment "$issue_num" --repo JakubAnderwald/drafto \
        --body-file "$body_file" >>"$LOG_FILE" 2>&1; then
      log "Issue #$issue_num: verification report for ${head_sha:0:12} posted"
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" verifyReportSha "$head_sha" \
        --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      return 0
    fi
    log "WARNING: posting the verification report on #$issue_num failed; it stays in $body_file"
  else
    log "WARNING: couldn't read #$issue_num's comments to post its verification report once; trying again later"
  fi
  rec=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" --state-file "$STATE_FILE" \
    2>>"$LOG_FILE" | jq -r '.verifyReportPosts // ""' 2>/dev/null || echo "")
  n=$(verify_sha_count "$rec" "$head_sha")
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" verifyReportPosts \
    "$head_sha:$((n + 1))" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  return 1
}

# verify_promote <item-id> <issue> <pr> <head-sha> <reason> <lanes-json>
#   <state-json> <comments-json>
# Testing → In Test with the report. Compose first (a composer failure becomes
# the minimal notice), then move the card (advance first, ADR-0030: the report
# says "the card is now In Test", so it is only posted once that's true), then
# post once and apply today's promotion resets. A failed move leaves the card in
# Testing, nothing posted, for the next tick. Runs with verification off too:
# the report then lists every lane as skipped, which still gives the human the
# manual steps.
verify_promote() {
  local item_id="$1" issue_num="$2" pr_num="$3" head_sha="$4" reason="$5" lanes="$6"
  local state_json="$7" comments_json="$8" cr_note gaps='[]' body_file minimal=0 report_plats
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN: would promote #$issue_num Testing → In Test ($reason) and post the verification report for ${head_sha:0:12}"
    return 0
  fi
  # A lane still running at the hold cap, or cut short by feedback, has nothing
  # left to contribute: stop it before composing, so its slot (and Chrome) is
  # free and the report shows it as cut off rather than racing its output.
  verify_stop_lanes "$issue_num" "$head_sha" "$reason" || true
  if ! verify_pr_platforms "$pr_num"; then
    log "WARNING: couldn't read PR #$pr_num's changed files; the report's platform rows may be wrong"
    gaps='[{"lane":"","reason":"the PR'"'"'s changed files couldn'"'"'t be read, so the platform rows may be wrong"}]'
  fi
  # The report shows the verification platforms (ADR-0053, 5C). When only that
  # variant couldn't be derived, the plain platforms still give the native
  # rows, and a gap says the Web row may be wrong.
  report_plats="$VERIFY_LANE_PLATFORMS"
  if [[ "$report_plats" == "{}" && "$VERIFY_PLATFORMS" != "{}" ]]; then
    report_plats="$VERIFY_PLATFORMS"
    gaps=$(jq -nc --argjson a "$gaps" \
      --arg r "the verification platforms couldn't be derived from the changed files, so the Web row may miss a packages/shared/ change" \
      '$a + [{lane: "browser", reason: $r}]' 2>/dev/null || echo "$gaps")
  fi
  cr_note=$(verify_cr_note "$issue_num" "$head_sha" "$state_json")
  body_file="$VERIFY_DIR/report-$issue_num-$head_sha.md"
  if ! verify_compose_report "$issue_num" "$pr_num" "$head_sha" "$report_plats" "$lanes" "$cr_note" \
      "$comments_json" "$state_json" "$gaps" "$body_file"; then
    log "WARNING: composing the verification report for #$issue_num failed; posting the minimal notice instead"
    verify_minimal_report "$pr_num" "$head_sha" "$body_file"
    minimal=1
  fi
  if ! transition_status "$item_id" "$issue_num" "In Test"; then
    log "WARNING: couldn't move #$issue_num from Testing to In Test ($reason); it stays in Testing for the next tick"
    return 1
  fi
  log "Issue #$issue_num: Testing → In Test ($reason)"
  # The minimal notice carries no browser result: the In Test run reports.
  [[ "$minimal" -eq 0 ]] || verify_browser_unclaim "$issue_num" "$head_sha" "$state_json"
  verify_post_report "$issue_num" "$head_sha" "$body_file" || true
  # Today's promotion resets (see the In Review → In Test block): a fresh fix
  # budget and CodeRabbit run cap for the next revision round.
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" lastWatchAt \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$issue_num" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$issue_num" crCliRuns "" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
  return 0
}

# verify_report_retry <issue> <head-sha> <state-json> — from the In Test sweep:
# post a report that its promotion composed but couldn't post. Only a report
# the promotion actually wrote to disk is retried (so a card that reached In
# Test without verification never gets one), at most VERIFY_REPORT_POST_MAX
# failed attempts per commit, the n-th retry no sooner than
# n × VERIFY_REPORT_RETRY_STEP_MIN after the report was composed (the body
# file's mtime): retrying in the promoting tick itself, or on each of the next
# two, would spend the budget inside one short outage. Silent when there is
# nothing to do.
verify_report_retry() {
  local issue_num="$1" head_sha="$2" state_json="$3" body_file n
  [[ "$DRY_RUN" -eq 0 && -n "$head_sha" ]] || return 0
  body_file="$VERIFY_DIR/report-$issue_num-$head_sha.md"
  [[ -s "$body_file" ]] || return 0
  [[ "$(echo "$state_json" | jq -r '.verifyReportSha // ""' 2>/dev/null)" != "$head_sha" ]] || return 0
  n=$(verify_sha_count "$(echo "$state_json" | jq -r '.verifyReportPosts // ""' 2>/dev/null || echo "")" "$head_sha")
  [[ "$n" -lt "$VERIFY_REPORT_POST_MAX" ]] || return 0
  if [[ "$n" -gt 0 && -n "$(find "$body_file" -mmin "-$((n * VERIFY_REPORT_RETRY_STEP_MIN))" 2>/dev/null)" ]]; then
    return 0
  fi
  log "Issue #$issue_num: the verification report for ${head_sha:0:12} isn't on the issue yet; posting it (failed attempts so far: $n/$VERIFY_REPORT_POST_MAX)"
  if ! verify_post_report "$issue_num" "$head_sha" "$body_file" && [[ $((n + 1)) -ge "$VERIFY_REPORT_POST_MAX" ]]; then
    log "WARNING: giving up on posting #$issue_num's verification report for ${head_sha:0:12}; it stays in $body_file"
    verify_browser_unclaim "$issue_num" "$head_sha" "$state_json"
  fi
  return 0
}

# verify_sweep_card <item-id> <issue> <labels> — one Testing card: gather the
# facts, ask verify-decide.mjs, carry out its action. Every lookup failure
# either skips the card for this tick or degrades to what the decision module
# treats as unknown; nothing here can fail the tick.
verify_sweep_card() {
  local item_id="$1" issue_num="$2" labels="$3"
  local pr_obj pr_num pr_view pr_state head_sha state_json comments_json enabled=0
  local failing pending ci threads_json threads="null" hwm feedback=false lanes facts out
  local action reason bounces cr_note
  pr_obj=$(find_prior_pr "$issue_num" || echo "")
  if [[ -z "$pr_obj" || "$pr_obj" == "null" ]]; then
    log "Issue #$issue_num: in Testing but no factory PR found; leaving it for the operator"
    return 0
  fi
  pr_num=$(echo "$pr_obj" | jq -r '.number')
  if ! pr_view=$(gh pr view "$pr_num" --repo JakubAnderwald/drafto \
      --json state,statusCheckRollup,comments,headRefOid 2>>"$LOG_FILE") || [[ -z "$pr_view" ]]; then
    log "WARNING: gh pr view #$pr_num failed (transient?); Testing card #$issue_num waits for the next tick"
    return 0
  fi
  pr_state=$(echo "$pr_view" | jq -r '.state // ""' 2>/dev/null || echo "")
  head_sha=$(echo "$pr_view" | jq -r '.headRefOid // ""' 2>/dev/null || echo "")
  if [[ "$pr_state" == "OPEN" && -z "$head_sha" ]]; then
    log "WARNING: PR #$pr_num has no head SHA in the snapshot (transient?); Testing card #$issue_num waits for the next tick"
    return 0
  fi
  # A failed read is not an empty record: read as one, it would hand the card
  # back as "not reviewed", with a public comment saying so.
  if ! state_json=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$issue_num" \
      --state-file "$STATE_FILE" 2>>"$LOG_FILE") || [[ -z "$state_json" ]]; then
    log "WARNING: couldn't read #$issue_num's factory state; Testing card waits for the next tick"
    return 0
  fi
  comments_json=$(fetch_issue_comments "$issue_num" 2>>"$LOG_FILE" || echo "[]")
  [[ -n "$comments_json" ]] || comments_json="[]"
  # Switched on for this card is enough here: the column lookup only decides
  # whether a card may ENTER Testing, and a failed lookup must not drain cards
  # that are already mid-round.
  verify_switched_on "$labels" && enabled=1

  # The rest only matters to a card that is really being verified: with the
  # switch off (or the PR gone) the decision is drain-or-leave either way.
  ci="pending"
  if [[ "$enabled" -eq 1 && "$pr_state" == "OPEN" ]]; then
    failing=$(pr_failing_required "$pr_view")
    pending=$(pr_pending_required "$pr_view")
    [[ "$failing" =~ ^[0-9]+$ ]] || failing=0
    [[ "$pending" =~ ^[0-9]+$ ]] || pending=0
    if [[ "$failing" -gt 0 ]]; then
      ci="red"
    elif [[ "$pending" -eq 0 ]] && ci_required_green "$pr_view"; then
      ci="green"
    fi
    # Threads only once CI has settled green, as In Review's fix loop reads
    # them: a re-run with a thread open waits here rather than bouncing early.
    if [[ "$ci" == "green" ]] && threads_json=$(fetch_review_threads "$pr_num" 2>>"$LOG_FILE") \
        && [[ -n "$threads_json" ]]; then
      threads=$(echo "$threads_json" | jq 'length' 2>/dev/null || echo "null")
      [[ "$threads" =~ ^[0-9]+$ ]] || threads="null"
    fi
    hwm=$(echo "$state_json" | jq -r '.lastFeedbackAt // ""' 2>/dev/null || echo "")
    has_actionable_feedback "$comments_json" "$hwm" && feedback=true
  fi
  bounces=$(verify_sha_count "$(echo "$state_json" | jq -r '.verifyBounces // ""' 2>/dev/null || echo "")" "$head_sha")
  lanes=$(verify_lane_states "$state_json" "$head_sha" "$enabled")
  # One jq pass: the record's own fields straight from state_json, the rest as
  # arguments.
  facts=$(echo "$state_json" | jq -c \
    --argjson enabled "$([[ "$enabled" -eq 1 ]] && echo true || echo false)" \
    --arg prState "$pr_state" --arg headSha "$head_sha" --arg requiredCi "$ci" \
    --argjson openThreads "$threads" --argjson bounces "$bounces" \
    --argjson bounceMax "$FACTORY_VERIFY_BOUNCE_MAX" --argjson newFeedback "$feedback" \
    --argjson lanes "$lanes" \
    --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson holdMaxMin "$FACTORY_VERIFY_HOLD_MAX_MIN" \
    '{enabled: $enabled, prState: $prState, headSha: $headSha,
      verifySha: (.verifySha // ""), verifyReportSha: (.verifyReportSha // ""),
      requiredCi: $requiredCi, lastReviewSha: (.lastReviewSha // ""),
      openThreads: $openThreads, bounces: $bounces, bounceMax: $bounceMax,
      newFeedback: $newFeedback, lanes: $lanes, startedAt: (.verifyStartedAt // ""),
      now: $now, holdMaxMin: $holdMaxMin}' 2>>"$LOG_FILE" || echo "")
  out=""
  if [[ -n "$facts" ]]; then
    out=$(node "$SCRIPT_DIR/lib/verify-decide.mjs" decide --facts "$facts" 2>>"$LOG_FILE" | tail -1 || true)
  fi
  action=$(echo "$out" | jq -r '.action // ""' 2>/dev/null || echo "")
  reason=$(echo "$out" | jq -r '.reason // ""' 2>/dev/null || echo "")
  if [[ -z "$action" ]]; then
    # Fail open, like the CodeRabbit gate: a broken decision module must never
    # strand a card, and evidence never gates. A PR that isn't open stays put.
    if [[ "$pr_state" != "OPEN" ]]; then
      action="skip"; reason="pr-${pr_state:-unknown}"
    else
      log "WARNING: verify-decide gave no usable decision for #$issue_num; promoting it (fail open)"
      action="promote"; reason="decide-error"
      out=$(jq -nc --argjson lanes "$lanes" '{lanes: $lanes}' 2>/dev/null || echo '{}')
    fi
  fi
  log "Issue #$issue_num: Testing → $action ($reason)"
  case "$action" in
    skip)
      log "Issue #$issue_num: PR #$pr_num is ${pr_state:-unreadable}; leaving the card in Testing for the operator"
      ;;
    wait) ;;
    init|work-lanes)
      if [[ "$DRY_RUN" -eq 1 ]]; then
        log "DRY-RUN: would $action #$issue_num's verification round for ${head_sha:0:12}"
        return 0
      fi
      # The note recorded for this head (work-lanes), or rebuilt for a new one
      # (init), which begin_round then records.
      cr_note=$(verify_cr_note "$issue_num" "$head_sha" "$state_json")
      if [[ "$action" == "init" ]]; then
        verify_begin_round "$issue_num" "$head_sha" "$cr_note" "$state_json"
        log "Issue #$issue_num: verification round started for ${head_sha:0:12}"
      fi
      if verify_pr_platforms "$pr_num"; then
        verify_prepare "$issue_num" "$pr_num" "$pr_obj" "$pr_view" "$head_sha" "$VERIFY_DIFF_FILES" \
          "$VERIFY_PLATFORMS" "$cr_note" "$state_json"
      else
        log "WARNING: couldn't read PR #$pr_num's changed files; #$issue_num's betas and scenario wait for the next tick"
      fi
      # The lanes get the verification variant: a packages/shared/ change
      # reaches the web app too (ADR-0053, 5C). The betas above keep the plain one.
      if [[ "$action" == "work-lanes" ]]; then
        verify_work_lanes "$issue_num" "$pr_num" "$head_sha" "$VERIFY_LANE_PLATFORMS" "$lanes" || true
      fi
      ;;
    hand-back)
      verify_hand_back "$item_id" "$issue_num" "$pr_num" "$head_sha" "$reason" "$state_json" \
        "$([[ "$threads" == "null" ]] || echo "$threads")" || true
      ;;
    promote)
      verify_promote "$item_id" "$issue_num" "$pr_num" "$head_sha" "$reason" \
        "$(echo "$out" | jq -c '.lanes // {}' 2>/dev/null || echo '{}')" "$state_json" "$comments_json" || true
      ;;
    *)
      log "WARNING: unknown verify-decide action '$action' for #$issue_num; leaving it for the next tick"
      ;;
  esac
  return 0
}

# The Testing sweep: every card in the Testing column, oldest issue first, with
# the per-card kill switches the other sweeps honour. Runs every --watch tick
# even with verification off: then it only drains (verify-decide promotes every
# card), which is what makes FACTORY_VERIFY=0 a safe rollback. A failed board
# query skips the sweep, never the In Test sweep after it. A pause set during
# this tick (a session limit hit by a scenario writer) stops it like any tick.
verify_sweep() {
  local testing_json count idx item item_id issue_num item_labels
  if ! testing_json=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items \
      --status "Testing" 2>>"$LOG_FILE"); then
    log "WARNING: query-status-items 'Testing' failed (transient?); skipping the Testing sweep this tick"
    return 0
  fi
  count=$(echo "$testing_json" | jq 'length' 2>/dev/null || echo "0")
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  # Quiet when there is nothing to do and verification is off: that is every
  # tick today, and the log should read as it did before the stage existed.
  if [[ "$count" -eq 0 ]]; then
    [[ "$FACTORY_VERIFY" == "1" ]] && log "--watch Testing sweep: 0 item(s)"
    return 0
  fi
  log "--watch Testing sweep: $count item(s) (verification $([[ "$FACTORY_VERIFY" == "1" ]] && echo on || echo "off: draining"))"
  testing_json=$(echo "$testing_json" | jq -c 'sort_by(.issueNumber)' 2>/dev/null || echo "$testing_json")
  for ((idx=0; idx<count; idx++)); do
    if node "$SCRIPT_DIR/lib/state-cli.mjs" factory:paused? --state-file "$STATE_FILE" 2>/dev/null; then
      log "Factory paused during this tick; stopping the Testing sweep"
      return 0
    fi
    item=$(echo "$testing_json" | jq -c ".[${idx}]")
    item_id=$(echo "$item" | jq -r '.itemId')
    issue_num=$(echo "$item" | jq -r '.issueNumber')
    item_labels=$(echo "$item" | jq -r '.labels // [] | join(",")')
    if [[ ",$item_labels," == *",factory-pause,"* ]]; then
      log "Issue #$issue_num: skipping (factory-pause label set)"; continue
    fi
    if [[ ",$item_labels," == *",support,"* ]]; then
      log "Issue #$issue_num: skipping (support label — nightly-support.sh owns these)"; continue
    fi
    verify_sweep_card "$item_id" "$issue_num" "$item_labels" || true
  done
  return 0
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

      if [[ ",$ITEM_LABELS," == *",support,"* ]]; then
        log "Issue #$ISSUE_NUM: skipping rescue (support label — nightly-support.sh owns these)"
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

    if [[ ",$ITEM_LABELS," == *",support,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (support label — nightly-support.sh owns these)"
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

    # Structural spec check before mutating board state. The parity override
    # (parity:infra-only) lets a no-app-platform change skip the
    # Affected-platforms requirement.
    SPEC=$(echo "$BUNDLE" | jq '.spec')
    SPEC_PARITY_OVERRIDE=$(echo "$BUNDLE" | jq -r '.parityOverride // ""')
    MISSING=$(spec_missing_section "$SPEC" "$SPEC_PARITY_OVERRIDE")
    if [[ -n "$MISSING" ]]; then
      log "Issue #$ISSUE_NUM: spec incomplete (missing: $MISSING)"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Spec problem: \`$MISSING\`.**

Please fix it using the [factory-feature template]\
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
    log "Invoking claude for #$ISSUE_NUM (--plan, phase=$PHASE, effort=$FACTORY_PLAN_EFFORT)"
    CLAUDE_OUTPUT_FILE=$(mktemp -t factory-agent-out.XXXXXX)
    CLAUDE_START_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    EXIT_CODE=0
    node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT" --dangerously-skip-permissions --effort "$FACTORY_PLAN_EFFORT" --no-chrome --strict-mcp-config \
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
      # Session limit? Pause until reset instead of burning the retry budget.
      # Return the card to Ready first: a card left in Planning with no plan
      # comment gets its attempts bumped by the next tick's rescue sweep.
      if check_session_limit "$REPO_ROOT" "$CLAUDE_START_ISO"; then
        rm -f "$CLAUDE_OUTPUT_FILE"
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Ready" || true
        pause_for_session_limit
        log "=== factory-agent --$MODE_NAME completed in $(( $(date +%s) - START_TIME ))s ==="
        exit 0
      fi
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

    if [[ ",$ITEM_LABELS," == *",support,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (support label — nightly-support.sh owns these)"
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

    # One reply per trigger comment that needs an answer, built here once for
    # the planner's bundle and the reply check after its run.
    PLAN_REPLY_MARKERS=$(reply_markers_for \
      "$(echo "$COMMENTS_JSON" | jq -c --argjson t "$UNACKED_JSON" '[.[] | select((.id | tostring) as $i | $t | index($i))]')" \
      "drafto-factory-plan-reply-")
    REPLAN_JSON=$(jq -n \
      --arg id "$PLAN_COMMENT_ID" \
      --arg issueNum "$ISSUE_NUM" \
      --arg body "$PLAN_BODY" \
      --argjson triggers "$UNACKED_JSON" \
      --arg replyDir "$(reply_dir_for "$ISSUE_NUM")" \
      --argjson replyMarkers "$PLAN_REPLY_MARKERS" \
      '{
         planCommentId: $id,
         planCommentUrl: ("https://github.com/JakubAnderwald/drafto/issues/" + $issueNum + "#issuecomment-" + $id),
         planCommentBody: $body,
         triggerCommentIds: $triggers,
         replyMarkers: $replyMarkers,
         replyDir: $replyDir
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
    reset_reply_dir "$ISSUE_NUM"
    POSTED_REPLY_IDS=" "
    log "Invoking claude for #$ISSUE_NUM (--plan replan, phase=$PHASE, effort=$FACTORY_PLAN_EFFORT)"
    CLAUDE_OUTPUT_FILE=$(mktemp -t factory-agent-out.XXXXXX)
    CLAUDE_START_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    EXIT_CODE=0
    node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT" --dangerously-skip-permissions --effort "$FACTORY_PLAN_EFFORT" --no-chrome --strict-mcp-config \
        >"$CLAUDE_OUTPUT_FILE" 2>>"$LOG_FILE" || EXIT_CODE=$?

    # Whatever the run returned, a trigger it acked has been handled, so it
    # gets its reply now, before any early exit.
    plan_reply_check "$ISSUE_NUM" "$PLAN_REPLY_MARKERS"

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
      transition_status "$ITEM_ID" "$ISSUE_NUM" "Plan Review" || true
      # Session limit? Pause until reset instead of burning the retry budget.
      # Card is already restored to Plan Review above.
      if check_session_limit "$REPO_ROOT" "$CLAUDE_START_ISO"; then
        rm -f "$CLAUDE_OUTPUT_FILE"
        pause_for_session_limit
        log "=== factory-agent --$MODE_NAME completed in $(( $(date +%s) - START_TIME ))s ==="
        exit 0
      fi
      rm -f "$CLAUDE_OUTPUT_FILE"
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
        # No replan will come for these comments now.
        plan_reply_check "$ISSUE_NUM" "$PLAN_REPLY_MARKERS" 1
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
        # The card leaves Plan Review, so no replan will answer these comments.
        plan_reply_check "$ISSUE_NUM" "$PLAN_REPLY_MARKERS" 1
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

    if [[ ",$ITEM_LABELS," == *",support,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (support label — nightly-support.sh owns these)"
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
        # A slot retained from an earlier tick would otherwise survive into
        # status:blocked, and the next --watch sweep would tear down a worktree
        # whose PR is still open. Release it here instead.
        release_slot_and_worktree "$ISSUE_NUM"
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

Only ${FREE_GB} GB free on the Mac mini's internal disk or the factory's build volume (need ≥ ${FACTORY_MIN_FREE_DISK_GB} GB). \
Reclaim space on the Mac mini, then drag this card back to **In Progress** to retry.

<!-- drafto-factory-disk-low -->" >>"$LOG_FILE" 2>&1 || true
        fi
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
        release_slot_and_worktree "$ISSUE_NUM"
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
        release_slot_and_worktree "$ISSUE_NUM"
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
    REPLY_MARKERS="[]"
    FEEDBACK_CONSUMED_AT=""
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
        # One reply per feedback comment, keyed on that comment, so a retry of
        # the same feedback finds the replies it already posted. Approval noise
        # ("thanks", "lgtm") needs no answer.
        REPLY_MARKERS=$(reply_markers_for "$REVISION_COMMENTS" "drafto-factory-revise-reply-")
        FEEDBACK_CONSUMED_AT=$(echo "$REVISION_COMMENTS" | jq -r 'sort_by(.createdAt) | .[-1].createdAt // ""' 2>/dev/null || echo "")
      fi
    fi

    # Acquire a slot (reuse the issue's own slot on a retry / revision).
    SLOT=$(slot_for_issue "$ISSUE_NUM")
    if [[ -z "$SLOT" ]]; then
      log "Issue #$ISSUE_NUM: both worktree slots busy; deferring to a later tick"
      break
    fi

    if ! BUNDLE=$(build_implement_bundle "$ISSUE_RECORD" "$PLAN_COMMENT_JSON" "$PRIOR_PR" "$ATTEMPTS" "$REVISION_COMMENTS" "$COMMENTS_JSON" "$REPLY_MARKERS" "$(reply_dir_for "$ISSUE_NUM")"); then
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
    WT_ERR_FILE=$(mktemp -t factory-wt-err)
    if ! WT_JSON=$(node "$SCRIPT_DIR/lib/worktree-cli.mjs" add --issue "$ISSUE_NUM" \
        --root "$REPO_ROOT" --base origin/main --fetch 2>"$WT_ERR_FILE"); then
      log "ERROR: worktree add failed for #$ISSUE_NUM: $(worktree_cli_error "$WT_ERR_FILE"); releasing slot $SLOT"
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-release "$SLOT" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      continue
    fi
    cat "$WT_ERR_FILE" >>"$LOG_FILE" 2>/dev/null || true; rm -f "$WT_ERR_FILE"
    WT_PATH=$(echo "$WT_JSON" | jq -r '.path')
    log "Issue #$ISSUE_NUM: worktree $WT_PATH (branchReused=$(echo "$WT_JSON" | jq -r '.branchReused // false'), fromRemote=$(echo "$WT_JSON" | jq -r '.fromRemote // false'), base=$(echo "$WT_JSON" | jq -r '.base // ""'))"
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

    # Record the PR head before handing over, so a claimed `implemented` can be
    # checked against what GitHub actually received. Captured after the install
    # (which takes minutes) to keep the TOCTOU window small. Empty on a fresh
    # implementation — there is no prior PR to compare against, and the
    # "no PR on head" check below already covers that case.
    # PRE_HEAD_KNOWN distinguishes "nothing to verify" from "couldn't find out".
    # Collapsing both into an empty PRE_HEAD_OID would silently skip the guard
    # on a revision run whose `gh pr view` hit a transient error — the exact
    # failure this guard exists to catch.
    PRE_HEAD_OID=""
    PRE_HEAD_KNOWN=1
    if [[ "$PRIOR_PR" != "null" ]]; then
      PRE_HEAD_OID=$(pr_head_oid "$(echo "$PRIOR_PR" | jq -r '.number')")
      if [[ -z "$PRE_HEAD_OID" ]]; then
        PRE_HEAD_KNOWN=0
        log "WARNING: #$ISSUE_NUM: could not read the PR head before this run; a success claim cannot be verified this tick"
      else
        log "Issue #$ISSUE_NUM: PR head before this run: $PRE_HEAD_OID"
      fi
    fi

    # Invoke claude inside the worktree with the implementer prompt + bundle.
    CLAUDE_INPUT=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
      "$PROMPT_TEXT" "$BUNDLE")
    reset_reply_dir "$ISSUE_NUM"
    log "Invoking claude for #$ISSUE_NUM (--implement, slot $SLOT, cap ${IMPLEMENT_TIMEOUT_SEC}s, effort=$FACTORY_EFFORT)"
    CLAUDE_OUTPUT_FILE=$(mktemp -t factory-agent-out.XXXXXX)
    CLAUDE_START_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    EXIT_CODE=0
    ( cd "$WT_PATH" && CLAUDE_CALL_TIMEOUT_SEC="$IMPLEMENT_TIMEOUT_SEC" \
        node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT" --dangerously-skip-permissions --effort "$FACTORY_EFFORT" --no-chrome --strict-mcp-config ) \
        >"$CLAUDE_OUTPUT_FILE" 2>>"$LOG_FILE" || EXIT_CODE=$?

    if [[ $EXIT_CODE -eq 124 ]]; then
      log "WARNING: claude timed out (>${IMPLEMENT_TIMEOUT_SEC}s) for #$ISSUE_NUM; keeping slot for retry"
      rm -f "$CLAUDE_OUTPUT_FILE"
      node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
      continue
    elif [[ $EXIT_CODE -ne 0 ]]; then
      log "ERROR: claude exited non-zero ($EXIT_CODE) for #$ISSUE_NUM --implement"
      cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE" 2>/dev/null || true
      # Session limit? Pause until reset instead of burning the retry budget.
      # Keep the slot + worktree (as the timeout branch does) so the resumed
      # tick reuses the warm worktree; the card stays In Progress.
      if check_session_limit "$WT_PATH" "$CLAUDE_START_ISO"; then
        rm -f "$CLAUDE_OUTPUT_FILE"
        log "Issue #$ISSUE_NUM: session limit — keeping slot $SLOT + worktree; card stays In Progress for resume"
        pause_for_session_limit
        log "=== factory-agent --$MODE_NAME completed in $(( $(date +%s) - START_TIME ))s ==="
        exit 0
      fi
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
    # On a revision run, mark as consumed only the feedback this run was given.
    # A comment posted while it ran (a scenario run can take most of the cap)
    # stays newer than the mark, so the In Test sweep picks it up next instead
    # of it being dropped unread.
    FEEDBACK_MARK="$NOW_ISO"
    if [[ "$IS_REVISION" -eq 1 && -n "$FEEDBACK_CONSUMED_AT" ]]; then
      FEEDBACK_MARK="$FEEDBACK_CONSUMED_AT"
    fi
    case "$ACTION" in
      implemented)
        PR_OBJ=$(find_prior_pr "$ISSUE_NUM")
        if [[ -z "$PR_OBJ" || "$PR_OBJ" == "null" ]]; then
          log "WARNING: #$ISSUE_NUM action=implemented but no PR on head factory/issue-$ISSUE_NUM; keeping slot for retry"
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          continue
        fi
        PR_NUM=$(echo "$PR_OBJ" | jq -r '.number')
        # Did the work actually land? An agent whose worktree does not descend
        # from the PR head gets its push rejected, and has historically still
        # reported action=implemented — which advanced the card AND marked the
        # reporter's feedback consumed, losing the change request silently.
        # Trust GitHub's head OID, not the agent's self-report.
        if [[ "$PRE_HEAD_KNOWN" -eq 0 ]]; then
          log "WARNING: #$ISSUE_NUM: the PR head before this run is unknown, so action=implemented cannot be verified; not advancing this tick"
          node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          continue
        fi
        if [[ -n "$PRE_HEAD_OID" ]]; then
          POST_HEAD_OID=$(pr_head_oid "$PR_NUM")
          if [[ -z "$POST_HEAD_OID" ]]; then
            log "WARNING: #$ISSUE_NUM: could not read PR #$PR_NUM head OID; not advancing this tick"
            node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
            continue
          fi
          if [[ "$POST_HEAD_OID" == "$PRE_HEAD_OID" ]]; then
            log "ERROR: #$ISSUE_NUM claimed action=implemented but PR #$PR_NUM head is unchanged (${PRE_HEAD_OID:0:12}); treating as a failed attempt"
            if ! echo "$COMMENTS_JSON" | jq -e 'any(.[]?; (.body // "") | contains("drafto-factory-head-unchanged"))' >/dev/null 2>&1; then
              gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
                --body "🏭 **A revision run reported success but pushed nothing.**

PR #$PR_NUM is still at \`${PRE_HEAD_OID:0:12}\`, so the requested change is *not* on the \
PR. The card stays In Progress and your feedback is left unconsumed, so the next attempt \
still sees it. If this repeats until the retry budget is exhausted, the card moves to \
**Blocked** for a human.

<!-- drafto-factory-head-unchanged -->" >>"$LOG_FILE" 2>&1 || true
            fi
            node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
            continue
          fi
        fi
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
        # Advancing lastFeedbackAt to FEEDBACK_MARK marks the comments this run
        # applied as consumed, so a revision we just applied can't re-trigger
        # next tick.
        transition_status "$ITEM_ID" "$ISSUE_NUM" "In Review" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastImplementAt "$NOW_ISO" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastFeedbackAt "$FEEDBACK_MARK" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        if [[ "$IS_REVISION" -eq 1 ]]; then
          log "Issue #$ISSUE_NUM: revision pushed → In Review (PR $PR_URL; slot $SLOT retained)"
          # Each feedback comment gets its own reply saying what changed, even
          # when the change answers it: the new In Test scenario comes later.
          revise_replies_check "$ISSUE_NUM" \
            "$(echo "$PRIOR_PR" | jq -r '.number // ""' 2>/dev/null || echo "")" \
            "$REPLY_MARKERS" implemented
        else
          log "Issue #$ISSUE_NUM: advanced to In Review (PR $PR_URL; slot $SLOT retained for --watch)"
        fi
        ;;
      noop)
        if [[ "$IS_REVISION" -eq 1 ]]; then
          # A genuine no-op commits nothing, so the worktree must still sit on
          # the PR head. If it has moved, work WAS committed and simply never
          # landed — the same false success as a bogus action=implemented, and
          # indistinguishable from it by PR head alone (unchanged either way).
          if [[ "$PRE_HEAD_KNOWN" -eq 0 ]]; then
            log "WARNING: #$ISSUE_NUM: the PR head before this run is unknown, so action=noop cannot be verified; not advancing this tick"
            node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
            continue
          fi
          LOCAL_HEAD=$(git -C "$WT_PATH" rev-parse HEAD 2>>"$LOG_FILE" || echo "")
          # Only "ahead of / diverged from" the PR head means work was committed
          # and never landed. A worktree merely BEHIND the PR head (someone else
          # pushed) is not this failure, and treating it as one would burn the
          # retry budget on a run that correctly did nothing.
          if [[ -n "$PRE_HEAD_OID" && -n "$LOCAL_HEAD" && "$LOCAL_HEAD" != "$PRE_HEAD_OID" ]] \
             && ! git -C "$WT_PATH" merge-base --is-ancestor "$LOCAL_HEAD" "$PRE_HEAD_OID" 2>>"$LOG_FILE"; then
            log "ERROR: #$ISSUE_NUM returned action=noop but the worktree HEAD (${LOCAL_HEAD:0:12}) differs from the PR head (${PRE_HEAD_OID:0:12}) — work was committed and not landed; treating as a failed attempt"
            node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
            continue
          fi
          # The feedback needed no code change. The existing PR + preview are
          # still valid, so re-present them. The PR number comes from bash's own
          # lookup, not the directive's pr=.
          revision_return_to_test "$ISSUE_NUM" "$ITEM_ID" "$PRE_HEAD_OID" "$ITEM_LABELS" \
            "$(echo "$PRIOR_PR" | jq -r '.number // ""' 2>/dev/null || echo "")" \
            "$REPLY_MARKERS" "$FEEDBACK_MARK" noop
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
        implement_park_blocked "$ITEM_ID" "$ISSUE_NUM" "$SLOT" "implementer returned blocked"
        ;;
      declined)
        # Revision feedback the implementer declined as outside the approved
        # plan, with the PR left as it was (ADR-0058). It goes back where the
        # reporter tests and ships, with the reply saying why, instead of hiding
        # a finished PR in Blocked. Only for a head that was already shown at In
        # Test (a card dragged out of Blocked hasn't been through In Review's
        # gates on it), that is still the PR's head now the run is over (nobody
        # pushed meanwhile; an unreadable head counts as moved), and a worktree
        # holding nothing the PR lacks. Anything else parks in Blocked as
        # action=blocked does.
        DECLINE_SHOWN_SHA=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$ISSUE_NUM" \
          --state-file "$STATE_FILE" 2>>"$LOG_FILE" | jq -r '.intestCommentSha // ""' 2>/dev/null || echo "")
        DECLINE_NOW_SHA=""
        if [[ "$IS_REVISION" -eq 1 && "$PRE_HEAD_KNOWN" -eq 1 && -n "$PRE_HEAD_OID" ]]; then
          DECLINE_NOW_SHA=$(pr_head_oid "$(echo "$PRIOR_PR" | jq -r '.number')")
        fi
        if [[ "$IS_REVISION" -eq 1 && "$PRE_HEAD_KNOWN" -eq 1 && -n "$PRE_HEAD_OID" \
              && "$DECLINE_SHOWN_SHA" == "$PRE_HEAD_OID" && "$DECLINE_NOW_SHA" == "$PRE_HEAD_OID" ]] \
           && worktree_untouched "$WT_PATH" "$PRE_HEAD_OID"; then
          revision_return_to_test "$ISSUE_NUM" "$ITEM_ID" "$PRE_HEAD_OID" "$ITEM_LABELS" \
            "$(echo "$PRIOR_PR" | jq -r '.number // ""' 2>/dev/null || echo "")" \
            "$REPLY_MARKERS" "$FEEDBACK_MARK" declined
        else
          implement_park_blocked "$ITEM_ID" "$ISSUE_NUM" "$SLOT" \
            "implementer declined, but the PR head wasn't the one shown at In Test or the worktree changed"
        fi
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
#      left the active states — In Progress / In Review / Testing / In Test —
#      (merged by the operator, Blocked, Done, or closed). Without this the two
#      slots would leak. Testing must stay in the active set: a card verifying
#      there still owns its slot + worktree (ADR-0053).
#   2. In Review → In Test — for each open factory PR: if CI is failing or
#      review comments are unresolved, resume the worktree and invoke Claude
#      (factory-watch-prompt) to push one fix; once CI is green AND a Vercel
#      preview is reachable, advance the card to In Test and post the URL.
# PHASE is guaranteed != "A" here (Phase A --watch no-op'd at the gate above).
if [[ "$MODE_WATCH" -eq 1 ]]; then
  # Clear the last tick's browser candidates before anything else, so a
  # --watch that exits anywhere (a failed query, a session-limit pause) can
  # never leave --browser a stale list. Only browser_write_candidates refills it.
  [[ "$DRY_RUN" -eq 1 ]] || : >"$BROWSER_CANDIDATES_FILE" 2>/dev/null || true
  WATCH_PROMPT_FILE="$SCRIPT_DIR/factory-watch-prompt.md"
  # Re-assert the In Test scenario prompt path for this mode. (It also has a
  # top-level default, so intest_handoff can never trip `set -u` on it.)
  INTEST_PROMPT_FILE="${INTEST_PROMPT_FILE:-$SCRIPT_DIR/factory-intest-prompt.md}"
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
      '((.state == "OPEN") and ((.labels | map(.name)) | any(. == "status:in-progress" or . == "status:in-review" or . == "status:testing" or . == "status:in-test")))')
    if [[ "$STILL_ACTIVE" != "true" ]]; then
      log "Slot $SLOT: issue #$SLOT_ISSUE left In Progress/In Review/Testing/In Test; releasing slot + worktree"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-release "$SLOT" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        # Not necessarily done with the issue: a card relabelled status:blocked
        # by a retry-exhausted path still has an OPEN PR, so the branch is only
        # deleted once no live PR points at it.
        remove_worktree_for "$SLOT_ISSUE"
      fi
    fi
  done

  # ── 1b. CodeRabbit CLI run housekeeping (ADR-0036) ──
  # Collect a background CLI review that finished since the last tick BEFORE the
  # In Review loop reads threads, so its findings enter this tick's fix loop.
  # Runs whether or not FACTORY_CR_CLI is on (off, it only terminates and
  # discards a leftover run, never posts); never fails the tick.
  cr_cli_housekeeping

  # ── 1c. Verification shell-lane housekeeping (ADR-0053) ──
  # Collect a finished shell run BEFORE the Testing sweep decides, so a lane
  # that reported since the last tick lets its card promote this tick. Runs
  # whether or not FACTORY_VERIFY is on (off, it only winds a run down). A run
  # that hit a Claude session limit pauses the factory; the tick ends there,
  # as it does when any other claude call hits one.
  verify_shell_housekeeping
  if [[ "${VERIFY_SESSION_LIMITED:-0}" == "1" ]]; then
    log "=== factory-agent --$MODE_NAME completed in $(( $(date +%s) - START_TIME ))s ==="
    exit 0
  fi

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
  # CI gate reads branch-protection required contexts (advisory bots ignored).
  fetch_required_contexts

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

    if [[ ",$ITEM_LABELS," == *",support,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (support label — nightly-support.sh owns these)"; continue
    fi

    PR_OBJ=$(find_prior_pr "$ISSUE_NUM")
    if [[ -z "$PR_OBJ" || "$PR_OBJ" == "null" ]]; then
      log "Issue #$ISSUE_NUM: In Review but no factory PR found; skipping (implement may not have completed)"
      continue
    fi
    PR_NUM=$(echo "$PR_OBJ" | jq -r '.number')
    PR_URL=$(echo "$PR_OBJ" | jq -r '.url')

    # Pull CI rollup + the Vercel preview URL from the PR in one call.
    # headRefOid rides along (no extra API call): the In Test hand-off keys its
    # scenario/beta idempotency on the exact commit that CI went green on.
    PR_VIEW=$(gh pr view "$PR_NUM" --repo JakubAnderwald/drafto \
      --json state,mergeable,statusCheckRollup,comments,headRefOid 2>>"$LOG_FILE" || echo "")
    if [[ -z "$PR_VIEW" ]]; then
      log "WARNING: gh pr view #$PR_NUM failed (transient?); skipping this tick"; continue
    fi

    # Gate only on branch-protection *required* contexts: an advisory bot's red
    # or pending check (e.g. CodeRabbit, including its "Review rate limited"
    # status) must not trigger the fix loop or block the In Test advance. The
    # helpers normalise the CheckRun/StatusContext rollup and fall back to
    # counting all checks when the required set is unknown.
    FAILING=$(pr_failing_required "$PR_VIEW")
    PENDING=$(pr_pending_required "$PR_VIEW")
    [[ "$FAILING" =~ ^[0-9]+$ ]] || FAILING=0
    [[ "$PENDING" =~ ^[0-9]+$ ]] || PENDING=0

    # Vercel preview URL: the Vercel bot posts a comment with the preview link,
    # and the deployment also surfaces as a rollup target URL. Search both.
    PREVIEW_URL=$(pr_preview_url "$PR_VIEW")

    # Unresolved inline review threads are a fix-loop trigger in their own right.
    # Before this, the whole fix path was gated on failing CI, so a green PR with
    # ten findings sailed through to In Test and the findings were force-resolved
    # unread at merge. A query failure yields "[]" and simply defers to the next
    # tick — --release fails closed on the same query, so nothing merges blind.
    #
    # Only consult threads once CI has SETTLED. CodeRabbit posts its findings
    # within a minute of the PR opening, long before CI finishes; triggering on
    # them while checks are still queued would push a fix commit on top of an
    # in-flight run, invalidate it, and — since watch_bound_thread_loop spends an
    # attempt whenever FAILING is 0 — burn the retry budget toward Blocked while
    # CI never gets a stable head to finish against. Failing CI is handled first
    # on its own; threads are a green-PR concern.
    REVIEW_THREADS="[]"
    THREAD_COUNT=0
    if [[ "$FAILING" -eq 0 && "$PENDING" -eq 0 ]] && ci_required_green "$PR_VIEW"; then
      REVIEW_THREADS=$(fetch_review_threads "$PR_NUM" 2>>"$LOG_FILE" || echo "[]")
      [[ -n "$REVIEW_THREADS" ]] || REVIEW_THREADS="[]"
      THREAD_COUNT=$(echo "$REVIEW_THREADS" | jq 'length' 2>/dev/null || echo "0")
      [[ "$THREAD_COUNT" =~ ^[0-9]+$ ]] || THREAD_COUNT=0
    fi

    # Required checks GitHub cancelled before any runner picked them up are not
    # something a fix pass can repair: re-run them instead of spending a Claude
    # attempt, and once the re-runs are spent tell the operator rather than loop
    # the fix agent. Only with a known required set — the all-checks fallback
    # would classify advisory bots too.
    if [[ "$FAILING" -gt 0 && "${REQUIRED_CONTEXTS_JSON:-[]}" != "[]" ]]; then
      WATCH_HEAD_SHA=$(echo "$PR_VIEW" | jq -r '.headRefOid // ""')
      if [[ -z "$WATCH_HEAD_SHA" ]]; then
        log "WARNING: PR #$PR_NUM has no head SHA in the snapshot (transient?); skipping this tick"; continue
      fi
      case "$(classify_failing_required "$PR_VIEW")" in
        infra)
          recover_cancelled_ci "$ISSUE_NUM" "$PR_NUM" "$WATCH_HEAD_SHA" "$PR_VIEW" "In Review"
          continue ;;
        unknown)
          log "WARNING: couldn't look up PR #$PR_NUM's cancelled jobs (transient?); skipping this tick"
          continue ;;
      esac
    fi

    if [[ "$FAILING" -gt 0 || "$THREAD_COUNT" -gt 0 ]]; then
      if [[ "$FAILING" -gt 0 ]]; then
        log "Issue #$ISSUE_NUM: PR #$PR_NUM has $FAILING failing check(s), $THREAD_COUNT open thread(s) → fix loop"
      else
        log "Issue #$ISSUE_NUM: PR #$PR_NUM is green but has $THREAD_COUNT open review thread(s) → fix loop"
      fi

      # Retry budget for the fix loop.
      ATTEMPTS=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-attempts "$ISSUE_NUM" \
        --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo "0")
      [[ "$ATTEMPTS" =~ ^[0-9]+$ ]] || ATTEMPTS=0
      if [[ "$ATTEMPTS" -ge "$FACTORY_MAX_ATTEMPTS" ]]; then
        log "Issue #$ISSUE_NUM: watch retry budget exhausted ($ATTEMPTS); advancing to Blocked"
        if [[ "$DRY_RUN" -eq 0 ]]; then
          gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
            --body "🏭 **Fix retry budget exhausted ($ATTEMPTS attempts).**

The factory could not get PR #$PR_NUM to green CI with every review thread \
answered after $ATTEMPTS fix passes. \
A human should take a look. Reset with \
\`node scripts/lib/state-cli.mjs factory:reset-attempts $ISSUE_NUM\` once fixed.

<!-- drafto-factory-retry-exhausted -->" >>"$LOG_FILE" 2>&1 || true
          transition_status "$ITEM_ID" "$ISSUE_NUM" "Blocked" || true
          # The slot is still held from the --implement run that opened this PR.
          # Leaving it held is what armed the sweep to delete a branch backing an
          # open PR — the #463 failure. Release it, keeping the branch.
          release_slot_and_worktree "$ISSUE_NUM"
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
      # Only the required failures the fix agent can act on — never hand it an
      # advisory bot's red (e.g. CodeRabbit) to "fix". Falls back to all reds
      # when the required set is unknown.
      CI_SUMMARY=$(pr_failing_required_summary "$PR_VIEW")
      # Also drop the CodeRabbit CLI lane's PR-conversation summary (ADR-0036).
      # It lists the findings that did NOT become threads (lower severities,
      # outside the diff, next to an existing thread, past the thread cap,
      # rejected by GitHub, or a run whose head moved on), in vendor prose phrased
      # as orders; the lane records cli-partial when a serious one ends up there. A conversation comment can't be resolved, so it
      # would reach every later fix pass as feedback and pull those findings back
      # in. Only the owner identity posts it: the author check stops a public
      # commenter hiding a comment by pasting the marker. The Claude review summary
      # (drafto-factory-code-review) stays — it is meant to be acted on.
      UNRESOLVED=$(echo "$PR_VIEW" | jq -c '
        [ .comments[]? | select((.author.login // "") | test("vercel|github-actions"; "i") | not)
          | select(((.author.login // "") == "JakubAnderwald"
                    and ((.body // "") | contains("<!-- drafto-factory-cr-cli sha="))) | not)
          | { id: .id, user: { login: (.author.login // "") }, body: (.body // "") } ]')
      [[ -n "$UNRESOLVED" ]] || UNRESOLVED="[]"

      if ! BUNDLE=$(build_watch_bundle "$ISSUE_RECORD" "$PLAN_COMMENT_JSON" "$PR_OBJ" "$CI_SUMMARY" "$UNRESOLVED" "$ATTEMPTS" "$COMMENTS_JSON" "$REVIEW_THREADS"); then
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
      WT_ERR_FILE=$(mktemp -t factory-wt-err)
      if ! WT_JSON=$(node "$SCRIPT_DIR/lib/worktree-cli.mjs" add --issue "$ISSUE_NUM" \
          --root "$REPO_ROOT" --base origin/main --fetch 2>"$WT_ERR_FILE"); then
        # Release the slot we just acquired, mirroring the --implement site: an
        # unreachable origin now fails the add instead of silently branching
        # from base, and holding both slots through a network fault would
        # starve --implement for as long as it lasts.
        log "ERROR: worktree resume failed for #$ISSUE_NUM: $(worktree_cli_error "$WT_ERR_FILE"); releasing slot $SLOT"
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-release "$SLOT" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        continue
      fi
      cat "$WT_ERR_FILE" >>"$LOG_FILE" 2>/dev/null || true; rm -f "$WT_ERR_FILE"
      WT_PATH=$(echo "$WT_JSON" | jq -r '.path')
      log "Issue #$ISSUE_NUM: worktree $WT_PATH (branchReused=$(echo "$WT_JSON" | jq -r '.branchReused // false'), fromRemote=$(echo "$WT_JSON" | jq -r '.fromRemote // false'), base=$(echo "$WT_JSON" | jq -r '.base // ""'))"
      copy_worktree_env "$WT_PATH"
      seed_worktree_node_modules "$WT_PATH"
      log "Issue #$ISSUE_NUM: seeding node_modules (clonefile) + reconciling deps (--watch, slot $SLOT, cap ${INSTALL_TIMEOUT_SEC}s)"
      run_pnpm_install "$WT_PATH" || log "WARNING: install failed/timed out for #$ISSUE_NUM --watch; proceeding"

      CLAUDE_INPUT=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
        "$WATCH_PROMPT_TEXT" "$BUNDLE")
      log "Invoking claude for #$ISSUE_NUM (--watch fix, slot $SLOT, cap ${WATCH_TIMEOUT_SEC}s, effort=$FACTORY_EFFORT)"
      CLAUDE_OUTPUT_FILE=$(mktemp -t factory-agent-out.XXXXXX)
      CLAUDE_START_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      EXIT_CODE=0
      ( cd "$WT_PATH" && CLAUDE_CALL_TIMEOUT_SEC="$WATCH_TIMEOUT_SEC" \
          node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT" --dangerously-skip-permissions --effort "$FACTORY_EFFORT" --no-chrome --strict-mcp-config ) \
          >"$CLAUDE_OUTPUT_FILE" 2>>"$LOG_FILE" || EXIT_CODE=$?

      if [[ $EXIT_CODE -ne 0 ]]; then
        [[ $EXIT_CODE -eq 124 ]] && log "WARNING: claude timed out for #$ISSUE_NUM --watch fix" \
          || log "ERROR: claude exited $EXIT_CODE for #$ISSUE_NUM --watch fix"
        cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE" 2>/dev/null || true
        # Session limit (never a 124 timeout)? Pause until reset, don't bump.
        if [[ $EXIT_CODE -ne 124 ]] && check_session_limit "$WT_PATH" "$CLAUDE_START_ISO"; then
          rm -f "$CLAUDE_OUTPUT_FILE"
          pause_for_session_limit
          log "=== factory-agent --$MODE_NAME completed in $(( $(date +%s) - START_TIME ))s ==="
          exit 0
        fi
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
          watch_bound_thread_loop
          ;;
        noop)
          log "Issue #$ISSUE_NUM: watcher found nothing actionable (transient CI?); leaving In Review"
          watch_bound_thread_loop
          # A no-op pass on red CI is a wasted Claude run. Cancelled-before-a-
          # runner checks never get here (re-run above), so what's left is a red
          # the agent can't fix: spend an attempt so it ends in Blocked, not an
          # endless loop (--release hands red Approved cards back here — ADR-0041).
          if [[ "$FAILING" -gt 0 ]]; then
            log "Issue #$ISSUE_NUM: no-op fix pass on $FAILING failing required check(s); spending one attempt"
            node "$SCRIPT_DIR/lib/state-cli.mjs" factory:bump-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
          fi
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
      log "Issue #$ISSUE_NUM: PR #$PR_NUM has $PENDING required check(s) still running; waiting"
      continue
    fi

    # Confirm required checks are actually green — a required context could be
    # missing from the rollup (not failing, not pending, just absent). Advisory
    # non-required reds (CodeRabbit) are intentionally ignored here.
    if ! ci_required_green "$PR_VIEW"; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM required checks not all green yet; waiting"
      continue
    fi

    # Required CI green. The changed files decide what "testable" even means
    # here, so fetch them once and derive the platforms.
    if ! INTEST_DIFF_FILES=$(gh pr diff "$PR_NUM" --repo JakubAnderwald/drafto --name-only 2>>"$LOG_FILE"); then
      log "WARNING: gh pr diff #$PR_NUM failed (transient?); skipping this tick"; continue
    fi
    INTEST_PLATFORMS=$(printf '%s\n' "$INTEST_DIFF_FILES" | node "$SCRIPT_DIR/lib/dispatch-release.mjs" derive-platforms --diff-file - 2>>"$LOG_FILE" || echo '{}')
    WEB_TOUCHED=$(echo "$INTEST_PLATFORMS" | jq -r '.web // false' 2>/dev/null || echo "false")

    # A Vercel preview is the test artefact for a web change, so a web PR still
    # waits for one. For a native-only PR the preview exercises nothing — gating
    # on it would deadlock the card behind a URL that means nothing to the test.
    if [[ "$WEB_TOUCHED" == "true" && -z "$PREVIEW_URL" ]]; then
      log "Issue #$ISSUE_NUM: CI green but no Vercel preview URL yet; waiting"
      continue
    fi
    HEAD_SHA=$(echo "$PR_VIEW" | jq -r '.headRefOid // ""')

    # Code review, once per head SHA, on a fully-green PR. Reviewing earlier
    # would burn a pass on code that is still moving; reviewing here means the
    # diff is stable and this is the last stop before a human is asked to test.
    # Any finding becomes an inline review thread, which the next tick picks up
    # via the fix loop above — so we stop here and let the card come round again
    # rather than promoting on the same tick (ADR-0035).
    LAST_REVIEW_SHA=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$ISSUE_NUM" \
      --state-file "$STATE_FILE" 2>>"$LOG_FILE" | jq -r '.lastReviewSha // ""' 2>/dev/null || echo "")
    if [[ -n "$HEAD_SHA" && "$LAST_REVIEW_SHA" != "$HEAD_SHA" ]]; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        log "DRY-RUN: would code-review #$ISSUE_NUM PR #$PR_NUM at ${HEAD_SHA:0:12}"
      else
        review_stage "$ISSUE_NUM" "$PR_NUM" "$PR_OBJ" "$HEAD_SHA" "$INTEST_DIFF_FILES" || true
        continue
      fi
    fi

    # CodeRabbit gap-fill lane (ADR-0036). This is the converged state — required
    # CI green, preview present if needed, no open threads, Claude review already
    # run for HEAD_SHA — so the diff is stable and a CLI run started here isn't
    # wasted on a commit the fix loop is about to replace. A hold keeps the card in
    # In Review only while CodeRabbit may still cover this SHA; coderabbit-cli.mjs
    # bounds it (FACTORY_CR_HOLD_MAX_MIN plus the run timeout) and the gate fails
    # open, so the lane can delay a card but never strand it.
    CR_NOTE=""
    if [[ "${FACTORY_CR_CLI:-0}" == "1" && -n "$HEAD_SHA" ]]; then
      if ! cr_lane_gate "$ISSUE_NUM" "$PR_NUM" "$HEAD_SHA"; then
        continue
      fi
    fi

    # Pre-In-Test verification (ADR-0053). With FACTORY_VERIFY=1 (and the canary
    # label, when one is set, and the Testing column ready) a card whose head has
    # no verification report yet stops in Testing: verify_enter moves it there,
    # writes the scenario and dispatches the betas, and the Testing sweep below
    # promotes it to In Test with the report. CR_NOTE travels with it and is
    # kept for the report. With the switch off verify_target_status returns at
    # once and the promotion below runs exactly as before; a failed move to
    # Testing falls through to it too.
    if verify_target_status "$ISSUE_NUM" "$HEAD_SHA" "$ITEM_LABELS" \
        && verify_enter "$ITEM_ID" "$ISSUE_NUM" "$PR_NUM" "$PR_OBJ" "$PR_VIEW" "$HEAD_SHA" \
          "$INTEST_DIFF_FILES" "$INTEST_PLATFORMS" "$CR_NOTE"; then
      continue
    fi

    # Threads are guaranteed zero here: any open thread would have entered the
    # fix loop above, which always `continue`s. The CodeRabbit lane doesn't break
    # that — a finished CLI run's findings are posted by cr_cli_housekeeping at the
    # top of the tick, before fetch_review_threads reads them.
    log "Issue #$ISSUE_NUM: required CI green (platforms: $(echo "$INTEST_PLATFORMS" | jq -c . 2>/dev/null)) → In Test"
    # The scenario is re-posted here even for a commit that already has one (a
    # card handed back to In Review without a new commit). A commit that went
    # through pre-In-Test verification had its scenario written with the
    # verification platforms (packages/shared/ counts as web, ADR-0053 5C), so
    # the re-post keeps that variant and its ### Web section; the betas keep
    # INTEST_PLATFORMS.
    SCENARIO_PLATFORMS=$(scenario_platforms "$ISSUE_NUM" "$HEAD_SHA" "$INTEST_DIFF_FILES" "$INTEST_PLATFORMS")
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "DRY-RUN: would advance #$ISSUE_NUM to In Test and post a test scenario"
      INTEST_BETA=$(intest_dispatch_betas "$ISSUE_NUM" "$PR_NUM" "$HEAD_SHA" "$INTEST_PLATFORMS" 2>>"$LOG_FILE" || echo '{"dispatched":[],"skipped":[],"manualCommands":[]}')
      intest_handoff "$ISSUE_NUM" "$PR_NUM" "$PR_OBJ" "$PREVIEW_URL" "$(pr_failing_advisory "$PR_VIEW")" "$HEAD_SHA" "$INTEST_DIFF_FILES" "$SCENARIO_PLATFORMS" "$INTEST_BETA" "$CR_NOTE" || true
      continue
    fi
    # Advance FIRST: the card must reach In Test even if writing the scenario
    # fails. The comment is commentary; the transition is the state machine.
    transition_status "$ITEM_ID" "$ISSUE_NUM" "In Test" || true
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastWatchAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:reset-attempts "$ISSUE_NUM" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    # Reset the per-card CodeRabbit CLI run cap alongside attempts: a revision
    # round (In Test → feedback → In Review again) is new code and earns
    # CodeRabbit coverage again, instead of inheriting a cap spent on the last one.
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" crCliRuns "" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    # Surface any advisory (non-required) red checks — e.g. CodeRabbit — so the
    # operator can glance before Approving, even though they didn't block advance.
    # The CodeRabbit lane's coverage note (CR_NOTE, "" when covered or the lane is
    # off) travels as its own trailing argument, not inside ADVISORY: it is not a
    # check and must never be rendered as one.
    ADVISORY=$(pr_failing_advisory "$PR_VIEW")
    # Dispatch is its own step with its own SHA key, so a lane gated off here
    # (low disk, knob off) can still fire on a later tick.
    INTEST_BETA=$(intest_dispatch_betas "$ISSUE_NUM" "$PR_NUM" "$HEAD_SHA" "$INTEST_PLATFORMS" 2>>"$LOG_FILE" || echo '{"dispatched":[],"skipped":[],"manualCommands":[]}')
    intest_handoff "$ISSUE_NUM" "$PR_NUM" "$PR_OBJ" "$PREVIEW_URL" "$ADVISORY" "$HEAD_SHA" "$INTEST_DIFF_FILES" "$SCENARIO_PLATFORMS" "$INTEST_BETA" "$CR_NOTE" || true
  done

  # ── 2b. Testing sweep (pre-In-Test verification, ADR-0053) ──
  # Between the In Review loop and the In Test sweep, so a card the loop just
  # moved to Testing is looked at in the same tick, and a card promoted here
  # reaches the In Test sweep (feedback roll-back, browser candidates) in it
  # too. Runs with verification off as well, to drain the column.
  verify_sweep

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
    # The Testing sweep's verify candidates still go to --browser.
    browser_write_candidates
    log "=== factory-agent --watch completed in $(( $(date +%s) - START_TIME ))s ==="
    exit 0
  fi
  INTEST_COUNT=$(echo "$INTEST_JSON" | jq 'length' 2>/dev/null || echo "0")
  [[ "$INTEST_COUNT" =~ ^[0-9]+$ ]] || INTEST_COUNT=0
  log "--watch In Test feedback sweep: $INTEST_COUNT item(s)"
  # In Test web-run candidates (ADR-0051), "intest:issue:pr:sha" words.
  # Collected in the loop and handed to --browser, which runs after --release: a
  # browser session can take 15 minutes and must delay neither this sweep nor a
  # merge. The Testing sweep's verify ones are in VERIFY_BROWSER_CANDIDATES.
  BROWSER_CANDIDATES=""

  for ((IDX=0; IDX<INTEST_COUNT; IDX++)); do
    ITEM=$(echo "$INTEST_JSON" | jq ".[${IDX}]")
    ITEM_ID=$(echo "$ITEM" | jq -r '.itemId')
    ISSUE_NUM=$(echo "$ITEM" | jq -r '.issueNumber')
    ITEM_LABELS=$(echo "$ITEM" | jq -r '.labels // [] | join(",")')
    [[ ",$ITEM_LABELS," == *",factory-pause,"* ]] && continue
    if [[ ",$ITEM_LABELS," == *",support,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (support label — nightly-support.sh owns these)"; continue
    fi

    if ! COMMENTS_JSON=$(fetch_issue_comments "$ISSUE_NUM"); then
      log "WARNING: fetch_issue_comments failed for #$ISSUE_NUM (feedback sweep); skipping"; continue
    fi
    ISSUE_STATE_JSON=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue "$ISSUE_NUM" \
      --state-file "$STATE_FILE" 2>>"$LOG_FILE" || echo "{}")

    # Beta dispatch and scenario refresh are evaluated INDEPENDENTLY, each keyed
    # on its own recorded SHA. They used to be nested — dispatch happened only
    # inside the scenario hand-off — which meant a dispatch blocked by a
    # transient condition (low disk, a knob still off, an unavailable build
    # root) was never retried: once the scenario existed for that SHA, the
    # hand-off never ran again and no build was ever produced for the card.
    # Splitting them lets the blocked half retry on any later tick while the
    # already-written scenario stays put. (Observed for #463: the disk guard
    # skipped both lanes, the scenario was written, and freeing disk changed
    # nothing until the state key was cleared by hand.)
    SCENARIO_SHA=$(echo "$ISSUE_STATE_JSON" | jq -r '.intestCommentSha // ""' 2>/dev/null || echo "")
    INTEST_PR_OBJ=$(find_prior_pr "$ISSUE_NUM")
    if [[ -n "$INTEST_PR_OBJ" && "$INTEST_PR_OBJ" != "null" ]]; then
      INTEST_PR_NUM=$(echo "$INTEST_PR_OBJ" | jq -r '.number')
      INTEST_PR_VIEW=$(gh pr view "$INTEST_PR_NUM" --repo JakubAnderwald/drafto \
        --json statusCheckRollup,comments,headRefOid 2>>"$LOG_FILE" || echo "")
      INTEST_HEAD_SHA=$(echo "${INTEST_PR_VIEW:-}" | jq -r '.headRefOid // ""' 2>/dev/null || echo "")
      if [[ -n "$INTEST_HEAD_SHA" ]]; then
        INTEST_FILES=$(gh pr diff "$INTEST_PR_NUM" --repo JakubAnderwald/drafto --name-only 2>>"$LOG_FILE" || echo "")
        INTEST_PLATS=$(printf '%s\n' "$INTEST_FILES" | node "$SCRIPT_DIR/lib/dispatch-release.mjs" derive-platforms --diff-file - 2>>"$LOG_FILE" || echo '{}')

        # Is this card about to roll back to In Progress on the reporter's
        # feedback? If so, spend nothing on it: dispatching a 40-minute native
        # build for a commit that is about to be superseded burns a build number
        # and a build slot for nothing. (The rollback itself still happens below,
        # from the same comment set.)
        INTEST_HWM=$(echo "$ISSUE_STATE_JSON" | jq -r '.lastFeedbackAt // ""' 2>/dev/null || echo "")
        INTEST_PENDING_FEEDBACK=0
        if has_actionable_feedback "$COMMENTS_JSON" "$INTEST_HWM"; then
          INTEST_PENDING_FEEDBACK=1
        fi

        # Learn how previously-dispatched lanes ended BEFORE deciding what to
        # dispatch: a lane that failed is dropped from the confirmed set here,
        # which is what lets the dispatch below pick it up again.
        intest_check_lane_outcomes "$ISSUE_NUM" "$INTEST_HEAD_SHA" "$INTEST_PR_NUM" || true

        # Dispatch is idempotent per lane (intestBetaSha + intestBetaLanes), so
        # calling it every tick costs one state read and re-fires only for lanes
        # that are missing, were gated off, or have just been re-armed.
        if [[ "$INTEST_PENDING_FEEDBACK" -eq 1 ]]; then
          log "Issue #$ISSUE_NUM: actionable feedback pending; not dispatching a beta for a commit about to be superseded"
          INTEST_BETA='{"dispatched":[],"skipped":[],"manualCommands":[]}'
        else
          INTEST_BETA=$(intest_dispatch_betas "$ISSUE_NUM" "$INTEST_PR_NUM" "$INTEST_HEAD_SHA" "$INTEST_PLATS" 2>>"$LOG_FILE" \
            || echo '{"dispatched":[],"skipped":[],"manualCommands":[]}')
        fi
        [[ -n "$INTEST_BETA" ]] || INTEST_BETA='{"dispatched":[],"skipped":[],"manualCommands":[]}'

        if [[ "$INTEST_HEAD_SHA" != "$SCENARIO_SHA" ]]; then
          log "Issue #$ISSUE_NUM: In Test with no current scenario (have '${SCENARIO_SHA:-none}', head $INTEST_HEAD_SHA); writing one"
          INTEST_PREVIEW=$(pr_preview_url "${INTEST_PR_VIEW:-}")
          # Rebuild the CodeRabbit coverage note from state for this exact head
          # (ADR-0036): the promotion's CR_NOTE lived only in its own tick, and a
          # re-write without it would hide that the commit had no CodeRabbit review.
          INTEST_CR_NOTE=""
          if [[ "${FACTORY_CR_CLI:-0}" == "1" ]]; then
            INTEST_CR_NOTE=$(cr_coverage_note "$ISSUE_NUM" "$INTEST_HEAD_SHA")
          fi
          # A commit verified in Testing keeps the platforms its scenario had
          # there (packages/shared/ counts as web, ADR-0053 5C); the betas and
          # the In Test browser candidate below keep INTEST_PLATS.
          INTEST_SCEN_PLATS=$(scenario_platforms "$ISSUE_NUM" "$INTEST_HEAD_SHA" "$INTEST_FILES" "$INTEST_PLATS")
          intest_handoff "$ISSUE_NUM" "$INTEST_PR_NUM" "$INTEST_PR_OBJ" "$INTEST_PREVIEW" \
            "$(pr_failing_advisory "${INTEST_PR_VIEW:-}")" "$INTEST_HEAD_SHA" "$INTEST_FILES" "$INTEST_SCEN_PLATS" \
            "$INTEST_BETA" "$INTEST_CR_NOTE" || true
          # The scenario we just posted carries a drafto-factory marker, so
          # owner_comments_since ignores it — it can never look like feedback.
          COMMENTS_JSON=$(fetch_issue_comments "$ISSUE_NUM" 2>>"$LOG_FILE" || echo "$COMMENTS_JSON")
        fi

        # A verification report the Testing promotion composed but couldn't
        # post (ADR-0053). Inert for a card that never went through Testing:
        # only a report already on disk for this exact head is retried.
        verify_report_retry "$ISSUE_NUM" "$INTEST_HEAD_SHA" "$ISSUE_STATE_JSON" || true

        # A web change with no revision pending is a browser-run candidate;
        # browser_run makes the per-SHA checks when its turn comes, and skips a
        # head the Testing column's verify lane already reported on.
        if browser_kind_enabled intest && [[ "$INTEST_PENDING_FEEDBACK" -eq 0 ]] \
            && [[ "$(echo "$INTEST_PLATS" | jq -r '.web // false' 2>/dev/null)" == "true" ]]; then
          BROWSER_CANDIDATES="${BROWSER_CANDIDATES:+$BROWSER_CANDIDATES }intest:$ISSUE_NUM:$INTEST_PR_NUM:$INTEST_HEAD_SHA"
        fi
      fi
    fi

    HWM=$(echo "$ISSUE_STATE_JSON" | jq -r '.lastFeedbackAt // ""' 2>/dev/null || echo "")
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

A code change goes onto the open PR's branch and comes back through In Review \
to In Test with the preview redeployed. Each comment that asks for something \
gets its own reply here, saying what changed or answering it. (To ship as-is \
instead, drag the card to **Approved**.)

<!-- drafto-factory-revising -->" >>"$LOG_FILE" 2>&1 || true
  done

  browser_write_candidates

  log "=== factory-agent --watch completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# ── --browser mode (Phase B+, ADR-0051) ─────────────────────────────────────
# The web runs in Chrome. --watch found the candidates; this runs at most one of
# them, after --release in the loop, so a 15-minute Chrome session never holds
# up a merge. The Testing column's verify candidates go first (ADR-0053): a card
# there waits on its browser lane, while an In Test card only waits for a
# report. Each candidate is re-checked against its own column (Testing for
# verify, In Test for intest: a card dragged out since --watch ran is skipped),
# and browser_run re-checks every per-SHA condition itself.
if [[ "$MODE_BROWSER" -eq 1 ]]; then
  if ! browser_kind_enabled verify && ! browser_kind_enabled intest; then
    log "Browser runner off (FACTORY_BROWSER=$FACTORY_BROWSER, kinds='$FACTORY_BROWSER_KINDS'); nothing to do"
    log "=== factory-agent --browser completed in $(( $(date +%s) - START_TIME ))s ==="
    exit 0
  fi
  BROWSER_LIST=""
  # A list older than two ticks came from a --watch that didn't finish since:
  # ignore it rather than act on a board that has moved on. Verify lines first,
  # whatever order the file has them in. A bare "<issue>:<pr>:<sha>" line, the
  # format before ADR-0053, is read as intest.
  if [[ -s "$BROWSER_CANDIDATES_FILE" ]] && \
      [[ -z "$(find "$BROWSER_CANDIDATES_FILE" -mmin +10 2>/dev/null)" ]]; then
    BROWSER_LIST=$( { grep -E '^verify:[0-9]+:[0-9]+:[0-9a-f]{40}$' "$BROWSER_CANDIDATES_FILE"
      grep -E '^(intest:)?[0-9]+:[0-9]+:[0-9a-f]{40}$' "$BROWSER_CANDIDATES_FILE"; } 2>/dev/null || true)
  fi
  if [[ -z "$BROWSER_LIST" ]]; then
    log "--browser: no browser-run candidates this tick"
    log "=== factory-agent --browser completed in $(( $(date +%s) - START_TIME ))s ==="
    exit 0
  fi
  # Each column's board items, read once per run on first need ("!" = the
  # query failed: that column's candidates wait for the next tick).
  BROWSER_TESTING_JSON=""
  BROWSER_INTEST_JSON=""
  # Set by browser_run when the preflight fails: later candidates reuse it.
  BROWSER_PREFLIGHT_FAILED=""
  for BROWSER_CAND in $BROWSER_LIST; do
    case "$BROWSER_CAND" in
      verify:*) BROWSER_KIND=verify; BROWSER_COLUMN="Testing"; BROWSER_CAND="${BROWSER_CAND#verify:}" ;;
      *) BROWSER_KIND=intest; BROWSER_COLUMN="In Test"; BROWSER_CAND="${BROWSER_CAND#intest:}" ;;
    esac
    BROWSER_ISSUE="${BROWSER_CAND%%:*}"
    if ! browser_kind_enabled "$BROWSER_KIND"; then
      log "Issue #$BROWSER_ISSUE: the browser runner's $BROWSER_KIND kind is off; skipping its browser run"
      continue
    fi
    if [[ "$BROWSER_KIND" == verify ]]; then
      if [[ -z "$BROWSER_TESTING_JSON" ]]; then
        BROWSER_TESTING_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items \
          --status "Testing" 2>>"$LOG_FILE") || BROWSER_TESTING_JSON="!"
        [[ -n "$BROWSER_TESTING_JSON" ]] || BROWSER_TESTING_JSON="!"
      fi
      BROWSER_COLUMN_JSON="$BROWSER_TESTING_JSON"
    else
      if [[ -z "$BROWSER_INTEST_JSON" ]]; then
        BROWSER_INTEST_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items \
          --status "In Test" 2>>"$LOG_FILE") || BROWSER_INTEST_JSON="!"
        [[ -n "$BROWSER_INTEST_JSON" ]] || BROWSER_INTEST_JSON="!"
      fi
      BROWSER_COLUMN_JSON="$BROWSER_INTEST_JSON"
    fi
    if [[ "$BROWSER_COLUMN_JSON" == "!" ]]; then
      log "WARNING: query-status-items '$BROWSER_COLUMN' failed (transient?); #$BROWSER_ISSUE's browser run waits for the next tick"
      continue
    fi
    # Still in its column, and not paused or support-owned since --watch looked.
    if [[ "$(echo "$BROWSER_COLUMN_JSON" | jq --argjson n "$BROWSER_ISSUE" \
        '[.[] | select(.issueNumber == $n)
              | select(((.labels // []) | index("factory-pause")) == null)
              | select(((.labels // []) | index("support")) == null)] | length' 2>/dev/null)" != "1" ]]; then
      log "Issue #$BROWSER_ISSUE: no longer a $BROWSER_COLUMN candidate; skipping its browser run"
      continue
    fi
    BROWSER_RC=0
    browser_run "$BROWSER_KIND" "$BROWSER_ISSUE" "$(echo "$BROWSER_CAND" | cut -d: -f2)" \
      "${BROWSER_CAND##*:}" || BROWSER_RC=$?
    [[ "$BROWSER_RC" -eq 1 ]] || break
  done
  log "=== factory-agent --browser completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# ── --release mode (Phase B+) ───────────────────────────────────────────────
# Approved → Released. For each card a human (or an allowlisted reporter) has
# dragged to Approved: confirm the open factory PR is green + mergeable, enforce
# the migration gate (supabase/migrations/** requires the migration-approved
# label), squash-merge via the GitHub API (gh pr merge --delete-branch is broken
# in worktrees — CLAUDE.md), advance the card to Released, and release the slot +
# worktree. Vercel auto-deploys main → prod for web. Beta-channel dispatch
# (iOS/Android/macOS) is a Phase D concern and is NOT done here.
#
# The Approved drag is the human merge-authorisation gate (ADR-0026); --release
# only ever acts on a card a human already moved. Anything that can't merge
# cleanly (conflicts, missing migration approval, no PR, CI that couldn't run) is
# left in Approved for the operator. The two exceptions need a code change, so
# they hand the card back to In Review for the fix loop and re-require the
# Approved drag: a genuinely red required check and an unresolved review thread.
# PHASE is guaranteed != "A" here (Phase A --release no-op'd at the gate above).
if [[ "$MODE_RELEASE" -eq 1 ]]; then
  if ! APPROVED_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items \
      --status "Approved" 2>>"$LOG_FILE"); then
    log "WARNING: query-status-items Approved failed (transient?); skipping --release this tick"
    exit 0
  fi
  APPROVED_COUNT=$(echo "$APPROVED_JSON" | jq 'length' 2>/dev/null || echo "0")
  if ! [[ "$APPROVED_COUNT" =~ ^[0-9]+$ ]]; then
    log "ERROR: unexpected non-numeric APPROVED_COUNT='$APPROVED_COUNT'"; exit 1
  fi
  log "--release (phase=$PHASE): $APPROVED_COUNT Approved item(s)"

  # Branch-protection required status contexts (fetched once). The CI gate below
  # requires every one of these to be SUCCESS before merging, so an empty/partial
  # check rollup can't masquerade as green. Falls back to "[]" (any-success) if
  # protection isn't readable.
  fetch_required_contexts
  log "--release: required CI contexts: $(echo "$REQUIRED_CONTEXTS_JSON" | jq -c . 2>/dev/null || echo '[]')"

  for ((IDX=0; IDX<APPROVED_COUNT; IDX++)); do
    ITEM=$(echo "$APPROVED_JSON" | jq ".[${IDX}]")
    ITEM_ID=$(echo "$ITEM" | jq -r '.itemId')
    ISSUE_NUM=$(echo "$ITEM" | jq -r '.issueNumber')
    ITEM_LABELS=$(echo "$ITEM" | jq -r '.labels // [] | join(",")')
    if [[ ",$ITEM_LABELS," == *",factory-pause,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (factory-pause label set)"; continue
    fi

    if [[ ",$ITEM_LABELS," == *",support,"* ]]; then
      log "Issue #$ISSUE_NUM: skipping (support label — nightly-support.sh owns these)"; continue
    fi

    PR_OBJ=$(find_prior_pr "$ISSUE_NUM")
    if [[ -z "$PR_OBJ" || "$PR_OBJ" == "null" ]]; then
      log "Issue #$ISSUE_NUM: Approved but no factory PR found; leaving for the operator"
      continue
    fi
    PR_NUM=$(echo "$PR_OBJ" | jq -r '.number')
    PR_STATE=$(echo "$PR_OBJ" | jq -r '.state')

    # Idempotency: a prior tick may have merged the PR but failed to advance the
    # card (e.g. a transient board-write error). Never re-merge — just finish the
    # Released transition + teardown.
    if [[ "$PR_STATE" == "MERGED" ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM already merged; finishing Released transition"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Released" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastReleaseAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        release_slot_and_worktree "$ISSUE_NUM" "MERGED"
      fi
      continue
    fi
    if [[ "$PR_STATE" == "CLOSED" ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM is closed (unmerged); leaving for the operator"
      continue
    fi

    # Fresh PR snapshot: CI rollup, mergeability, branch-protection merge state,
    # draft/base, and labels. (Changed files come from `gh pr diff --name-only`
    # below — unlike `--json files`, it is NOT capped at 100 files, so a migration
    # sorting past file #100 can't slip through the gate.)
    PR_VIEW=$(gh pr view "$PR_NUM" --repo JakubAnderwald/drafto \
      --json state,mergeable,mergeStateStatus,isDraft,baseRefName,statusCheckRollup,labels,headRefOid 2>>"$LOG_FILE" || echo "")
    if [[ -z "$PR_VIEW" ]]; then
      log "WARNING: gh pr view #$PR_NUM failed (transient?); skipping this tick"; continue
    fi

    # TOCTOU: the PR may have merged/closed out-of-band between find_prior_pr and
    # now (a human clicking Merge, or a prior tick racing). Trust the fresh state.
    PR_VIEW_STATE=$(echo "$PR_VIEW" | jq -r '.state // ""')
    if [[ "$PR_VIEW_STATE" == "MERGED" ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM merged out-of-band; finishing Released transition"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        transition_status "$ITEM_ID" "$ISSUE_NUM" "Released" || true
        node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastReleaseAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
        release_slot_and_worktree "$ISSUE_NUM" "MERGED"
      fi
      continue
    fi
    if [[ "$PR_VIEW_STATE" == "CLOSED" ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM closed (unmerged); leaving for the operator"; continue
    fi

    # Never merge a draft or a PR that doesn't target main.
    if [[ "$(echo "$PR_VIEW" | jq -r '.isDraft // false')" == "true" ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM is a draft; leaving for the operator"; continue
    fi
    PR_BASE=$(echo "$PR_VIEW" | jq -r '.baseRefName // ""')
    if [[ "$PR_BASE" != "main" ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM targets '$PR_BASE', not main; refusing to merge"; continue
    fi

    # Changed files (uncapped) for the migration + parity gates.
    if ! DIFF_FILES=$(gh pr diff "$PR_NUM" --repo JakubAnderwald/drafto --name-only 2>>"$LOG_FILE"); then
      log "WARNING: gh pr diff #$PR_NUM failed (transient?); skipping this tick"; continue
    fi
    PR_LABELS=$(echo "$PR_VIEW" | jq -r '(.labels // []) | map(.name) | join(",")')

    # Migration gate — hard stop. Leave the card in Approved (a human adds the
    # label); comment once so the operator knows why it's parked.
    MIG_VIOLATION=$(migration_violation "$DIFF_FILES" "$PR_LABELS")
    if [[ -n "$MIG_VIOLATION" ]]; then
      log "Issue #$ISSUE_NUM: migration gate held PR #$PR_NUM — $MIG_VIOLATION"
      if [[ "$DRY_RUN" -eq 0 ]] && ! issue_has_marker "$ISSUE_NUM" "drafto-factory-migration-gate"; then
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Hold — database migration needs sign-off.**

PR #$PR_NUM changes files under \`supabase/migrations/\`, so the factory won't \
merge it until the **\`migration-approved\`** label is on the PR. Review the \
migration, add the label, and the next cycle merges automatically. The card \
stays in **Approved**.

<!-- drafto-factory-migration-gate -->" >>"$LOG_FILE" 2>&1 || true
      fi
      continue
    fi

    # Parity gate — re-assert phase scope at merge time (the implement-time check
    # can be stale if the diff changed). parity_violation's Phase-B clause blocks
    # any apps/mobile|desktop file at Phase B; it's a no-op for that clause at C/D.
    # Empty platforms/override args exercise only that phase-scope guard.
    PARITY_VIOLATION=$(parity_violation "" "" "$DIFF_FILES")
    if [[ -n "$PARITY_VIOLATION" ]]; then
      log "Issue #$ISSUE_NUM: parity gate held PR #$PR_NUM — $PARITY_VIOLATION"
      if [[ "$DRY_RUN" -eq 0 ]] && ! issue_has_marker "$ISSUE_NUM" "drafto-factory-parity-violation"; then
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Hold — out of phase scope.**

PR #$PR_NUM $PARITY_VIOLATION, which this phase doesn't allow. The card stays in \
**Approved**; an operator can re-scope the phase or the PR.

<!-- drafto-factory-parity-violation -->" >>"$LOG_FILE" 2>&1 || true
      fi
      continue
    fi

    # CI gate. A failing *required* check never parks the card silently (#654 sat
    # in Approved for days on checks GitHub had cancelled — ADR-0041):
    #  - cancelled before any runner picked them up: CI didn't judge the code, so
    #    re-run them; once re-runs are spent, comment once and hold in Approved
    #    (a stale branch is refreshed by the BEHIND step below once green);
    #  - anything else red: comment once and hand the card back to In Review for
    #    the fix loop, re-requiring approval (the diff will change).
    # With an unknown required set the fallback counts advisory bots too, so the
    # card just waits in Approved, as before. Then every branch-protection
    # required context must be SUCCESS (ci_required_green). An empty/partial
    # rollup (checks never ran) can't pass — "no checks" is not "green". Advisory
    # non-required reds (CodeRabbit) never block the merge.
    FAILING=$(pr_failing_required "$PR_VIEW")
    [[ "$FAILING" =~ ^[0-9]+$ ]] || FAILING=0
    if [[ "$FAILING" -gt 0 ]]; then
      if [[ "${REQUIRED_CONTEXTS_JSON:-[]}" == "[]" ]]; then
        log "Issue #$ISSUE_NUM: PR #$PR_NUM has $FAILING failing check(s) and the required set is unknown; not merging (left in Approved)"
        continue
      fi
      HEAD_SHA=$(echo "$PR_VIEW" | jq -r '.headRefOid // ""')
      if [[ -z "$HEAD_SHA" ]]; then
        log "WARNING: PR #$PR_NUM has no head SHA in the snapshot (transient?); skipping this tick"; continue
      fi
      case "$(classify_failing_required "$PR_VIEW")" in
        infra)
          recover_cancelled_ci "$ISSUE_NUM" "$PR_NUM" "$HEAD_SHA" "$PR_VIEW" "Approved"
          continue ;;
        unknown)
          log "WARNING: couldn't look up PR #$PR_NUM's cancelled jobs (transient?); not merging this tick"
          continue ;;
      esac
      log "Issue #$ISSUE_NUM: PR #$PR_NUM has $FAILING failing required check(s); not merging, handing back to In Review"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        log "DRY-RUN: would comment on #$ISSUE_NUM and move it back to In Review"; continue
      fi
      SHA12="${HEAD_SHA:0:12}"
      if ! issue_has_marker "$ISSUE_NUM" "drafto-factory-ci-red:$SHA12"; then
        RED_LIST=$(pr_failing_required_summary "$PR_VIEW" | sed 's/^/- /')
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Not merging — required CI is red on \`$SHA12\`.**

$RED_LIST

Moving the card back to **In Review** so the fix loop can repair PR #$PR_NUM. It \
comes back to In Test for your approval once CI is green again.

<!-- drafto-factory-ci-red:$SHA12 -->" >>"$LOG_FILE" 2>&1 || true
      fi
      # Same hand-back as an unresolved review thread (below): --watch is the
      # only mode that runs the fix loop and it never looks at Approved cards.
      transition_status "$ITEM_ID" "$ISSUE_NUM" "In Review" || true
      continue
    fi
    if ! ci_required_green "$PR_VIEW"; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM required checks not all green yet; waiting"
      continue
    fi

    MERGEABLE=$(echo "$PR_VIEW" | jq -r '.mergeable // ""')
    if [[ "$MERGEABLE" == "CONFLICTING" ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM has merge conflicts; leaving for the operator"
      if [[ "$DRY_RUN" -eq 0 ]] && ! issue_has_marker "$ISSUE_NUM" "drafto-factory-merge-conflict"; then
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Can't merge — the branch has conflicts.**

PR #$PR_NUM no longer merges cleanly into \`main\`. Rebase/resolve it (or comment \
a change request to have the factory revise it), then it merges on the next \
cycle. The card stays in **Approved**.

<!-- drafto-factory-merge-conflict -->" >>"$LOG_FILE" 2>&1 || true
      fi
      continue
    fi
    if [[ "$MERGEABLE" != "MERGEABLE" ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM mergeable=$MERGEABLE (GitHub still computing?); waiting"
      continue
    fi

    # Branch-protection merge state. With strict mode on, a PR whose checks ran
    # against an out-of-date base reports BEHIND: update it and let CI re-run, then
    # merge on a later tick once it's current — never squash a stale base into main.
    MERGE_STATE=$(echo "$PR_VIEW" | jq -r '.mergeStateStatus // ""')
    if [[ "$MERGE_STATE" == "BEHIND" ]]; then
      log "Issue #$ISSUE_NUM: PR #$PR_NUM is behind main; updating branch (merges once CI re-runs green)"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        if gh api --method PUT "repos/JakubAnderwald/drafto/pulls/$PR_NUM/update-branch" >>"$LOG_FILE" 2>&1; then
          if ! issue_has_marker "$ISSUE_NUM" "drafto-factory-branch-updated"; then
            gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
              --body "🏭 **Updating the branch with latest \`main\`.**

PR #$PR_NUM was behind \`main\`; I've updated it so CI re-runs against the current \
base. I'll squash-merge automatically once it's green again.

<!-- drafto-factory-branch-updated -->" >>"$LOG_FILE" 2>&1 || true
          fi
        else
          log "WARNING: update-branch failed for PR #$PR_NUM (conflict?); leaving for the operator"
        fi
      fi
      continue
    fi

    log "Issue #$ISSUE_NUM: PR #$PR_NUM green + mergeable → squash-merging"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "DRY-RUN: would squash-merge PR #$PR_NUM and advance #$ISSUE_NUM to Released"; continue
    fi

    # VERIFY, don't clear. The owner-token merge bypasses the repo's
    # required_conversation_resolution rule, so this is the only thing standing
    # between an unanswered finding and main. Previously this call force-resolved
    # every thread without reading one — the rule was satisfied on paper and the
    # findings were thrown away. Now an open thread refuses the merge and hands
    # the card back to --watch, which answers and resolves it (ADR-0035).
    #
    # A failed query is NOT "no threads": fail closed and retry next tick.
    if ! OPEN_THREADS_JSON=$(fetch_review_threads "$PR_NUM"); then
      log "WARNING: review-thread query failed for PR #$PR_NUM (transient?); not merging this tick"
      continue
    fi
    OPEN_THREADS=$(echo "$OPEN_THREADS_JSON" | jq 'length' 2>/dev/null || echo "0")
    [[ "$OPEN_THREADS" =~ ^[0-9]+$ ]] || OPEN_THREADS=0
    if [[ "$OPEN_THREADS" -gt 0 ]]; then
      log "Issue #$ISSUE_NUM: $OPEN_THREADS unresolved review thread(s) on PR #$PR_NUM; refusing to merge"
      # Marker-guarded like every other hard hold in this block. Without it, a
      # transient failure of the transition below (which swallows its own error)
      # leaves the card in Approved and re-posts this comment on every tick.
      THREAD_LIST=$(echo "$OPEN_THREADS_JSON" | jq -r '.[] | "- `" + (.path // "?") + ":" + ((.line // 0)|tostring) + "`"' 2>/dev/null || echo "")
      if ! issue_has_marker "$ISSUE_NUM" "drafto-factory-threads-open"; then
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Not merging — $OPEN_THREADS unresolved review thread(s).**

$THREAD_LIST

Every review comment has to be answered and resolved before this ships. Moving the
card back to **In Review** so the fix loop can address each one; it will come back
to In Test for your approval once they are all answered.

<!-- drafto-factory-threads-open -->" >>"$LOG_FILE" 2>&1 || true
      fi
      # Hand the card back to --watch, which is the only mode that runs the fix
      # loop. Leaving it in Approved would strand it: --release can't answer a
      # review thread and --watch never looks at Approved cards. The operator's
      # Approved drag is re-required afterwards — the diff changed after they
      # authorised it, so the ship authorisation is genuinely stale (ADR-0026).
      transition_status "$ITEM_ID" "$ISSUE_NUM" "In Review" || true
      continue
    fi

    # Squash-merge via the API form. gh pr merge --delete-branch fails in
    # worktrees (it tries to check out main locally — CLAUDE.md gotcha); the
    # merge endpoint is a PUT, so --method PUT is required.
    MERGE_OK=0
    if MERGE_OUT=$(gh api --method PUT "repos/JakubAnderwald/drafto/pulls/$PR_NUM/merge" \
        -f merge_method=squash 2>>"$LOG_FILE"); then
      if [[ "$(echo "$MERGE_OUT" | jq -r '.merged // false')" == "true" ]]; then MERGE_OK=1; fi
    else
      # The merge may have landed even if the HTTP response was lost (network
      # drop): the endpoint commits server-side before replying. Re-check the PR
      # state before crying failure, to avoid a false "merge failed" comment.
      RECHECK_STATE=$(gh pr view "$PR_NUM" --repo JakubAnderwald/drafto --json state --jq '.state' 2>>"$LOG_FILE" || echo "")
      if [[ "$RECHECK_STATE" == "MERGED" ]]; then
        log "Issue #$ISSUE_NUM: merge response lost but PR #$PR_NUM is MERGED; finishing"
        MERGE_OK=1
        MERGE_OUT=""
      fi
    fi
    if [[ "$MERGE_OK" -ne 1 ]]; then
      log "ERROR: squash-merge of PR #$PR_NUM failed; leaving card in Approved for the operator"
      if ! issue_has_marker "$ISSUE_NUM" "drafto-factory-merge-failed"; then
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Automatic merge failed.**

The factory couldn't squash-merge PR #$PR_NUM (it was green and conflict-free, \
so this is likely a transient GitHub error or a branch-protection rule). I'll \
retry next cycle; if it keeps failing, merge it by hand. The card stays in \
**Approved**.

<!-- drafto-factory-merge-failed -->" >>"$LOG_FILE" 2>&1 || true
      fi
      continue
    fi
    MERGE_SHA=$(echo "${MERGE_OUT:-}" | jq -r '.sha // ""' 2>/dev/null || echo "")
    log "Issue #$ISSUE_NUM: PR #$PR_NUM squash-merged${MERGE_SHA:+ (${MERGE_SHA:0:12})}"

    transition_status "$ITEM_ID" "$ISSUE_NUM" "Released" || true
    node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field "$ISSUE_NUM" lastReleaseAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1 || true
    release_slot_and_worktree "$ISSUE_NUM" "MERGED"
    # The API merge leaves the remote head branch behind; delete it (matches /merge).
    gh api --method DELETE "repos/JakubAnderwald/drafto/git/refs/heads/factory/issue-$ISSUE_NUM" >>"$LOG_FILE" 2>&1 || true

    # Phase D: dispatch beta builds for the changed native platforms via the local
    # Fastlane lanes (the CI release workflows are non-functional — see
    # builds-and-releases.md). Fire-and-forget; the Fastlane post-hook posts the
    # "now live" notice. Dormant at Phase B/C. Marker-guarded so a re-tick (e.g.
    # if the Released transition raced) can't re-trigger a build.
    BETA_NOTE="Mobile/desktop beta builds are not dispatched at this phase."
    if [[ "$PHASE" == "D" ]] && ! issue_has_marker "$ISSUE_NUM" "drafto-factory-beta-dispatched"; then
      # The mobile lane builds from $REPO_ROOT (this checkout), so bring it up to
      # the just-merged commit first. Best-effort ff-only — never clobber local
      # state; if it can't fast-forward, log and let the operator's C→D
      # validation catch a stale build rather than forcing.
      #
      # The DESKTOP lane does NOT build from $REPO_ROOT: this checkout is a
      # normal install carrying React 19.2, which compiles a macOS app that
      # crashes at runtime. It builds from the fossil root instead, which the
      # factory never fetches into or mutates — so verify by hand that it is
      # already at the merged commit, and skip the lane rather than ship a build
      # of the wrong code. See docs/operations/desktop-build-fossil.md.
      git -C "$REPO_ROOT" fetch origin main >>"$LOG_FILE" 2>&1 \
        && git -C "$REPO_ROOT" merge --ff-only origin/main >>"$LOG_FILE" 2>&1 \
        || log "WARNING: could not fast-forward $REPO_ROOT to merged main; beta lanes may build stale code"
      DESKTOP_SKIP_NOTE=""
      DESKTOP_ROOT_FLAG=""
      DISPATCH_PLATFORMS=$(printf '%s\n' "$DIFF_FILES" | node "$SCRIPT_DIR/lib/dispatch-release.mjs" derive-platforms --diff-file - 2>>"$LOG_FILE" || echo "")
      if [[ "$(echo "$DISPATCH_PLATFORMS" | jq -r '.desktop // false' 2>/dev/null)" == "true" ]]; then
        # Prepare the dedicated desktop build root at the merged commit. The
        # factory can't update the fossil checkout itself (it's the operator's
        # working tree), so it builds from a disposable clonefile replica of it.
        if DESKTOP_ROOT_READY=$(ensure_beta_build_root desktop "${MERGE_SHA:-origin/main}" 2>>"$LOG_FILE") && [[ -n "$DESKTOP_ROOT_READY" ]]; then
          DESKTOP_ROOT_FLAG="--desktop-root $DESKTOP_ROOT_READY"
        else
          log "Issue #$ISSUE_NUM: desktop beta build root unavailable; skipping the desktop lane"
          DESKTOP_SKIP_NOTE=" ⚠️ macOS beta skipped: the desktop build root (\`$BETA_DESKTOP_ROOT\`) could not be prepared — run \`pnpm release:beta\` from a fossil checkout by hand."
          DISPATCH_PLATFORMS=$(echo "$DISPATCH_PLATFORMS" | jq -c '.desktop = false' 2>/dev/null || echo "$DISPATCH_PLATFORMS")
        fi
      fi
      DISPATCH_CSV=$(echo "$DISPATCH_PLATFORMS" | jq -r '[to_entries[] | select(.value) | .key] | join(",")' 2>/dev/null || echo "")
      # shellcheck disable=SC2086 # DESKTOP_ROOT_FLAG is a deliberately word-split flag pair
      DISPATCH_JSON=$(node "$SCRIPT_DIR/lib/dispatch-release.mjs" dispatch --platforms "$DISPATCH_CSV" --repo-root "$REPO_ROOT" $DESKTOP_ROOT_FLAG \
        --log-dir "$LOG_DIR" --log-key "release-${MERGE_SHA:0:12}" 2>>"$LOG_FILE" || echo "")
      # Only the desktop lane builds in a shared build root here (mobile builds
      # from $REPO_ROOT), so only its lock is handed to the lane — or dropped if
      # the lane did not start, rather than held until this process exits.
      if [[ -n "$DESKTOP_ROOT_FLAG" ]]; then
        claim_beta_build_root desktop "$(echo "$DISPATCH_JSON" | jq -r '[.dispatched[]? | select(.id == "desktop") | .pid // empty][0] // empty' 2>/dev/null || echo "")"
        release_beta_build_root desktop
      fi
      DISPATCHED=$(echo "$DISPATCH_JSON" | jq -r '[.dispatched[]?.id] | join(", ")' 2>/dev/null || echo "")
      # A lane refused by its guard (e.g. the desktop root lost its fossil) OR
      # one that could not start at all is reported, never silently dropped — a
      # missing beta must be visible. `.failed` is folded in here for the same
      # reason it exists at all: an unreported non-delivery is the bug family
      # this whole change set is closing.
      SKIPPED_LANES=$(echo "$DISPATCH_JSON" | jq -r '[(.skipped[]?, .failed[]?) | .id] | join(", ")' 2>/dev/null || echo "")
      if [[ -n "$SKIPPED_LANES" ]]; then
        SKIP_REASON=$(echo "$DISPATCH_JSON" | jq -r '[(.skipped[]?, .failed[]?) | .reason] | join("; ")' 2>/dev/null || echo "")
        log "Issue #$ISSUE_NUM: beta lane(s) refused: $SKIPPED_LANES ($SKIP_REASON)"
        DESKTOP_SKIP_NOTE="$DESKTOP_SKIP_NOTE ⚠️ Beta lane(s) refused: **$SKIPPED_LANES** — $SKIP_REASON"
      fi
      if [[ -n "$DISPATCHED" ]]; then
        log "Issue #$ISSUE_NUM: dispatched beta lane(s): $DISPATCHED"
        BETA_NOTE="Dispatched beta builds for: $DISPATCHED (TestFlight / Play internal). You'll get a \"now live\" note when each build lands.$DESKTOP_SKIP_NOTE"
        gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
          --body "🏭 **Beta builds dispatching.**

Kicked off beta builds for: **$DISPATCHED**. They run as local Fastlane lanes on \
the Mac mini; a \"now live in version X\" note follows when each build is up. \
(Production store submission stays a separate manual step.)

<!-- drafto-factory-beta-dispatched -->" >>"$LOG_FILE" 2>&1 || true
      elif [[ -n "$DESKTOP_SKIP_NOTE" ]]; then
        BETA_NOTE="No beta builds were dispatched.$DESKTOP_SKIP_NOTE"
      else
        BETA_NOTE="No mobile/desktop changes — nothing to dispatch (web deploys via Vercel)."
      fi
    fi

    # The merge only happens with zero open review threads (verified above), so
    # this is a statement of fact rather than a tally of what we cleared.
    THREADS_NOTE=" All review threads were answered and resolved before merge."
    gh issue comment "$ISSUE_NUM" --repo JakubAnderwald/drafto \
      --body "🏭 **Merged + released.**

PR #$PR_NUM is squash-merged into \`main\`${MERGE_SHA:+ (\`${MERGE_SHA:0:12}\`)}.${THREADS_NOTE} Vercel \
is deploying the web app to production now. ${BETA_NOTE}

<!-- drafto-factory-released -->" >>"$LOG_FILE" 2>&1 || true
  done

  log "=== factory-agent --release completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# All reachable modes have returned above. Anything that lands here is a bug.
log "ERROR: factory-agent reached unreachable tail (mode=$MODE_NAME phase=$PHASE)"
exit 1
