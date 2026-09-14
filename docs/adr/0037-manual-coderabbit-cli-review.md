# 0037 — Manual CodeRabbit CLI Review for Hand-Made PRs

- **Status**: Accepted
- **Date**: 2026-09-14
- **Authors**: Jakub Anderwald

## Context

[ADR-0036](./0036-factory-coderabbit-cli-gap-fill.md) added a CodeRabbit CLI step that reviews a factory PR's head commit when the PR bot didn't. The factory's `--watch` stage runs it only for a factory card sitting in In Review. A PR opened by hand has no card, so nothing starts a CLI review on it.

The `/merge` skill checks review coverage with `coderabbit-cli.mjs coverage --pr N` before merging. On this public, OSS-tier repo the PR bot is often rate-limited, so hand-made PRs often reach `/merge` with an unreviewed head. #637 did: its docs-only follow-up commit landed while the bot was rate-limited, and the gate stopped the merge. The only fix was waiting for the bot's hourly limit to reset.

Two limits shape any fix:

- The vendor allows **3 CLI reviews per rolling hour** per developer.
- Two CLI runs at once fail with a WebSocket error.

A review started by hand therefore competes with the factory for the same allowance and the same single slot.

## Decision

**Add `coderabbit-cli.mjs review --pr N --repo-root R [--state-file F] [--timeout-min M]`.** It runs the CLI review on a hand-made PR's head commit and waits for the result.

- **Same checks, same posting.** It skips a head that the bot reviewed or is reviewing, or that a CLI review already covered. It reviews incrementally from the nearest commit the bot reviewed, or in full against the merge-base, using the same base-selection logic. Findings go through the lane's `postFindings`, so they become review threads, and the summary marker makes `coverage` count the result. The summary says the review was run by hand, not by the factory.
- **Shares the factory's run log (`crCli` in factory state) when given `--state-file`.** A new `reserveManualCrCliRun` applies the factory's guards: it refuses while the lane is paused, busy or out of hourly budget. It records a budget entry and holds the lane's in-progress slot (`inFlight`) with `manual: true` and the caller's pid, so the factory's gate holds at `cli-busy` rather than starting a concurrent run. It creates no card record. A vendor rate limit, billing prompt or auth failure pauses the lane, just as a factory run's would.
- **Housekeeping never collects a manual run.** A manual run holds the slot from its own process, which waits for the vendor, posts, and frees the slot. Housekeeping leaves it alone while that process is alive, even with the lane switched off, because the run isn't the lane's. It frees the slot, with the hour still counted as used, only when the process is gone or more than 70 minutes past its deadline. A reused pid counts only if its command line is a `review` of the same PR. On SIGTERM, SIGINT or SIGHUP the process kills its CLI child, removes its worktree and frees the slot before exiting. So `factory:cr-cli-finish` (which sends it SIGTERM and matches the process the same way) and a user skipping the review never leave an orphaned vendor run holding the account's single connection.
- **Without a state file** (another machine, a cloud session) the vendor's own rate limit is the only guard. A `--state-file` path that doesn't exist is treated as no state file and never created.
- **`/merge` uses it and never blocks on coverage.** When the head isn't covered and nothing is reviewing it, `/merge` runs `review` in the background (capped at 30 minutes) against the factory's state file. If a PR-bot review is already running, `/merge` waits for it instead, for up to 20 minutes. Threads that either review opens block the merge like any other thread. If no review can run (busy, out of budget, unavailable, failed, or the head moved), `/merge` tells the user and merges anyway. The user can skip either wait.

## Consequences

- **Positive**: hand-made PRs get the same second reviewer as factory PRs, without waiting for the PR bot's hourly limit to reset. Findings arrive as ordinary threads, so `/push` answers them the same way.
- **Positive**: one run log and one slot for both paths. A manual run can't collide with a factory run or silently spend the factory's hourly budget.
- **Negative**: `/merge` can now take up to about 30 minutes on an unreviewed PR. It still merges when the review can't run.
- **Negative**: while a manual run holds the slot, factory cards wait at `cli-busy`. That wait is bounded by their usual hold cap.
- **Negative**: the factory state file gains a second writer outside the factory's tick. Like `state-cli`'s operator commands, each write is one reload, change and save with no IO in between, so the race window is milliseconds.
- **Neutral**: the manual run is synchronous, with no detached supervisor. The caller (a background shell in Claude Code) is already the long-lived process.

## Alternatives Considered

- **Make `/merge` merge without any review.** Tried first, and kept as the fallback when a review can't run. On its own, every rate-limited hand-made PR would merge unreviewed.
- **Wait for the PR bot.** Its limit lifts on the hour, and it auto-pauses after two reviewed commits, so a wait can last indefinitely.
- **Create a factory card for the PR so the factory reviews it.** The factory would take the PR through its whole pipeline (fix loop, In Test, release) when all we want is one review.
- **Run the CLI without touching the run log.** Simpler, but a concurrent factory run would fail on the WebSocket, and neither path would see the other's use of the hourly budget.
- **Use the detached supervisor and let housekeeping collect.** That ties a hand-made PR's review to the factory's 5-minute tick and its kill switch, and the caller would still have to poll for the result.
