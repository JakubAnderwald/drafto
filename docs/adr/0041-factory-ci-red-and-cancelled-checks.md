# 0041 — Factory Handling of Red and Cancelled CI

- **Status**: Accepted
- **Date**: 2026-10-08
- **Authors**: Jakub Anderwald

## Context

On 2026-10-05 GitHub cancelled three required checks (E2E Tests, Scripts Tests, SonarCloud) on PR #657, the PR for factory card #654. The annotation read "The job was not acquired by Runner of type hosted even after multiple attempts": the jobs never got a runner, never ran a step, and so never judged the code. The card was already in **Approved**.

`--release` counted any `CANCELLED` required check as a failure, and its CI gate did only `log …; continue`. It posted no comment, re-ran nothing and made no transition. Its BEHIND → `update-branch` step, which would have started a fresh run, came after that gate and was never reached. The card sat in Approved for about 2.5 days, logging the same line every five minutes, until a human noticed. The feature doc already promised that every hard hold posts a one-time comment. Red CI was the one hold that didn't.

`--watch` had the same blind spot from the other side. A cancelled required check sent the card into the Claude fix loop, which spent a fix attempt trying to "fix" an infrastructure hiccup. Separately, a `noop` fix pass on red CI never spent an attempt, so a red the agent can't fix would loop without limit.

GitHub reports several different things as `CANCELLED`: a job no runner picked up, a job that hit its `timeout-minutes`, a manual cancel, and a concurrency cancellation. Only the first is clearly not about the code.

## Decision

Classify failing **required** checks before acting (`classify_failing_required` in `scripts/factory-agent.sh`). This only happens when the required set is known; when branch protection can't be read, the all-checks fallback would include advisory bots, so the card keeps the old behaviour and waits.

1. **CI couldn't run.** Every failing required check is `CANCELLED`, and the Actions job behind each one has no `runner_name` and no steps. Both modes re-run the jobs with `gh run rerun <run> --failed`, at most `FACTORY_CI_RERUN_MAX` times (default 2) per head SHA, without spending a fix attempt. They wait for the whole workflow run to finish first. After that, the factory comments once per head SHA (`drafto-factory-ci-infra:<sha12>`) and holds the card where it is.
2. **CI is red.** Anything else, including `TIMED_OUT`, `STARTUP_FAILURE`, a job cancelled after it started, and a non-Actions check.
   - `--watch` runs its fix loop, and a `noop` pass on red now spends an attempt.
   - `--release` comments once per head SHA (`drafto-factory-ci-red:<sha12>`) and moves the Approved card back to **In Review**. This is the same hand-back ADR-0035 uses for unresolved review threads, and it means the Approved drag is required again, because the diff will change after the human authorised it.

## Consequences

- **Positive**: A runner outage heals itself, and when it can't, the operator is told on the issue. A red PR in Approved goes to the only mode that can fix it, instead of being stranded silently. An unfixable red ends in Blocked rather than an endless Claude loop.
- **Negative**:
  - A flaky genuine red on an Approved card now costs a fix pass and a fresh approval, where before the card would wait for someone to re-run CI by hand.
  - Classification costs one job-API call per cancelled check, but only while checks are failing.
  - A card held in In Review keeps its worktree slot until someone re-runs CI.
- **Neutral**: Re-run budgets and comment markers are keyed on the head SHA (`ciRerun` in the factory state), like the existing In Test and review keys, so every new push re-arms them.

## Alternatives Considered

- **Comment and leave red cards in Approved.** This is simpler and never changes the diff after approval. But only `--watch` runs the fix loop, and it never looks at Approved cards, so the card would still be stranded. It would just be stranded with a comment.
- **Treat every `CANCELLED` as infra.** This would re-run a job that hit its timeout (usually a hang in the code), or one an operator cancelled on purpose, and then claim the code was fine. The job API's runner and steps fields tell the cases apart for the cost of one call.
- **Update a stale branch before re-running.** This gives a single fresh run against current `main`. But during a long outage with `main` moving, each update produces a new head SHA with a fresh budget, so the card would never run out of budget and never comment, which is the silence this ADR removes. The existing BEHIND step updates the branch once checks are green.
