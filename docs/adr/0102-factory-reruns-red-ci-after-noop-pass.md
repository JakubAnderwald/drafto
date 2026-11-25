# 0102 — Factory Re-runs Red CI a No-op Fix Pass Left, Then Parks the Card

- **Status**: Accepted
- **Date**: 2026-11-25
- **Authors**: Jakub Anderwald

## Context

[ADR-0041](./0041-factory-ci-red-and-cancelled-checks.md) split failing required checks into "CI couldn't run" (re-run in bash) and "CI is red" (the `--watch` fix loop). For red CI it also made a `noop` fix pass spend an attempt, so a red the agent can't fix ends in **Blocked** instead of looping forever.

That bound turned out to be loose. The fix agent ends `noop` when it finds nothing in the code to change, usually a flaky test or an outside service. On the next tick the same head is still red with the same checks, so `--watch` starts another Claude pass, which sees the same thing. Card #899 (PR #915) spent ten `noop` passes on one head before its attempts ran out (`FACTORY_MAX_ATTEMPTS` is 10, [ADR-0076](./0076-factory-watch-effort-and-retry-budget.md)). Not one of them could change the outcome, and a single `gh run rerun --failed` was what the red actually needed. The watch prompt also told the agent to emit `noop` on a flaky failure "rather than burning the retry budget", which had stopped being true with ADR-0041. The prompt now says what a `noop` on red CI leads to.

## Decision

A `noop` fix pass on red CI is the agent's verdict on that head and that red. Bash keeps it, and doesn't ask again.

1. **Record it.** The `noop` arm, when required checks are failing, still spends the attempt. It also records `ciNoop = "<head sha>:<failing required check names, sorted, comma-joined>"` in the factory state (`record_ci_noop`).
2. **Re-run, don't re-ask.** The next `--watch` tick classifies the failing checks as before. A red (not "infra", not "unknown") on the recorded head SHA, whose failing names are the recorded ones or some of them (`ci_noop_repeat`), goes to `recover_noop_red_ci`, with no Claude run and no fix attempt:
   - It calls `rerun_infra_failures`, so it shares the per-head `ciRerun` budget (`FACTORY_CI_RERUN_MAX`, default 2) with the "CI couldn't run" path. It waits while the workflow run is still going.
   - A subset counts as a match. The jobs of one re-run finish minutes apart, so a tick mid-re-run often sees the faster job red again and the slower one still running, and a re-run that turns some checks green leaves red the agent already judged. A red check the pass didn't see is new, and goes to the fix loop.
   - A check with no Actions run behind it is skipped (`pr_infra_rerun_ids` now tolerates non-Actions URLs).
   - A re-run that goes green carries on as normal.
3. **Park it.** When the budget is spent and the checks are still red, `comment_ci_noop_hold` posts one comment per head SHA (`<!-- drafto-factory-ci-noop-hold:<sha12> -->`) listing the red checks and the `gh run rerun` commands. It sets `lastError`, moves the card to **Blocked** and releases its worktree slot. If the issue's comments can't be read or the comment can't be posted, the card stays in In Review for the next tick, so it is never parked without the notice. That path still returns success: the `--watch` loop runs under `set -e`, and a failure there would end the tick for every later card.
4. **Re-arming.** A new push changes the head SHA, so the record no longer matches. Nothing picks cards out of Blocked, so after the push the operator drags the card back to In Review. To give the agent another pass on the same commit, clear the record with `factory:set-issue-field <n> ciNoop ""`. Clearing `ciRerun` too grants fresh re-runs.

`--release` is unchanged: it already hands a red Approved card back to In Review, where this applies. The ciNoop check only runs when the required set is known, like the rest of ADR-0041's classification.

## Consequences

- **Positive**:
  - A red the agent can't fix costs one Claude pass instead of up to `FACTORY_MAX_ATTEMPTS`. #899 would have had one pass, two re-runs and a Blocked card with the commands to try.
  - A flaky red now gets re-run automatically, which is what it needed.
  - A parked card frees its slot, matching the intent of the `noop` arm.
- **Negative**:
  - A `noop` that was wrong (the agent missed a real fix) now ends in Blocked after the re-runs rather than another pass or two. The operator re-arms it by clearing `ciNoop`, or by pushing, and then dragging the card back to In Review.
  - The infra and noop paths share one re-run budget per head, so a head whose budget an outage spent goes to Blocked without a re-run.
  - A job someone cancelled by hand, which ADR-0041 never re-runs, can be re-run here if the fix agent passed over it.
- **Neutral**: One more per-issue state field, `ciNoop`, keyed on the head SHA like `ciRerun`.

## Alternatives Considered

- **Leave it to the attempts budget (ADR-0041).** It does stop the loop, but only after spending every attempt on passes that can't change anything.
- **Count `noop` passes per head and stop after N.** This would still spend Claude passes on a question already answered, and it re-runs nothing, so a flaky red still never gets the re-run it needs.
- **Re-run in bash before the first fix pass.** A genuine red would then always cost CI time before the agent sees it, and most reds are genuine. The agent's `noop` is the signal that the code isn't the problem.
- **Hold in In Review instead of Blocked.** The card would keep a worktree slot while it waits on a person, which [ADR-0070](./0070-factory-in-test-frees-slot-and-updates-behind-prs.md) moved away from. Blocked is where the attempts budget would have put it anyway.
