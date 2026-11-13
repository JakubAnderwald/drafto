# 0076 — Factory Watch Effort and Retry Budget

- **Status**: Accepted
- **Date**: 2026-11-13
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

On 2026-11-10, #797 (PR #819) went to Blocked with its retry budget of 5 used up. Only three of the five attempts went to real fix passes. The other two were lost to the factory itself:

- **A watch fix pass timed out at ultracode.** `--watch` ran Claude at `ultracode` effort ([ADR-0029](./0029-factory-ultracode-effort.md)). The agent finished the five review-thread fixes in 14 minutes. It then started a multi-agent review Workflow, waited about 12 minutes for it, and began the full test suite. The 1800s wall cap killed it 18 seconds later. Nothing had been committed, so the work was lost and an attempt was spent. A later pass made the same fixes at the same effort in 9 minutes without starting a workflow.
- **A conflict pass was falsely reported as not landed.** `conflict_pass_verified` pushed the merge, then immediately read the PR's head through `gh pr view`. GitHub's PR view lags a push by a few seconds, so it still showed the old head, and the factory logged "the resolution never reached the PR" and spent an attempt. The next tick reviewed the merge commit it had called missing. This was not a one-off. The warning fired nine times on five cards (#688, #469 twice, #461, #794 four times, #797), and all nine merge commits are on GitHub. It was wrong every time.

The last straw was a nit. The factory's code review ([ADR-0035](./0035-factory-code-review-gate.md)) reviews every new head. On #819 each review opened one new thread, and every thread-driven fix pass spends an attempt (`watch_bound_thread_loop`). The final thread, a missing row in a runbook table, arrived when no attempts were left.

## Decision

1. **`--watch` fix passes run at `xhigh`.** A new knob, `FACTORY_WATCH_EFFORT` (default `xhigh`), sets the effort of the `--watch` fix call. That covers CI fixes, review-thread fixes and conflict passes. `FACTORY_EFFORT` (default `ultracode`) now covers `--implement` only. Fix passes are small and targeted, and they don't need multi-agent fan-out. At `xhigh` the Workflow tool needs an explicit opt-in, which the watch prompt doesn't give. The 1800s watch cap is unchanged, which leaves plenty of headroom at `xhigh`.
2. **The retry budget `FACTORY_MAX_ATTEMPTS` goes from 5 to 10.** It is still shared by `--plan`, `--implement` and `--watch`. Planning's three checks (plan, replan and the Planning orphan rescue) compared against a hard-coded `5` and never read the knob, so they now read it too. The knob also gains the same numeric guard as its neighbours, so a value bash can't compare (`08`, `abc`) falls back to 10 instead of silently making the budget unlimited.
3. **A conflict pass trusts its own push.** `worktree-cli.mjs push` is a plain, non-force `git push`. It prints `{"pushed":true,"head":…}` only after GitHub has accepted the ref. When the push reports the verified commit, `conflict_pass_verified` treats the merge as landed and doesn't read the PR view again. Only when the push gives no such proof (it failed, or its output didn't parse) does it fall back to the PR view. If that doesn't show the commit either, the pass still fails with "never reached the PR", rolls back and spends an attempt as before.

## Consequences

- **Positive**: The two factory-side failures above stop spending attempts. A card in a long review conversation gets ten fix rounds instead of five before it needs a human. Fix passes use less of the shared subscription, because the review fan-out they used to start is gone.
- **Negative**: A card that genuinely can't progress now uses about twice as much Claude time before it reaches Blocked. That is up to 10 × 45 min on `--implement`, 10 × 30 min on `--watch`, and 10 × the plan cap on planning. The plan cap is 6 min by default, and the Mac mini's plist raises it to 15 min (`FACTORY_PLAN_TIMEOUT_SEC=900`). A watch fix pass no longer gets ultracode's independent review of its own diff. The factory's code review of every new head still covers that.
- **Neutral**: ADR-0035's "caps the review conversation at five rounds" now reads as ten. ADR-0029's split stays in place for `--implement` and planning; only `--watch` moves. `FACTORY_WATCH_EFFORT` doesn't follow `FACTORY_EFFORT`, so an operator who lowers `FACTORY_EFFORT` to cut cost must lower it too. Decisions 1 and 2 can be reverted from the plist, by setting `FACTORY_WATCH_EFFORT=ultracode` or `FACTORY_MAX_ATTEMPTS=5`. Decision 3 has no knob, and reverting it needs a code change.

## Alternatives Considered

- **Raise the watch wall cap.** Rejected. The pass on #797 had finished its fix and was waiting on a review it didn't need. A longer cap spends more time on the same wait and still loses everything if the workflow runs long.
- **Keep ultracode, and tell the watch prompt not to start workflows.** Rejected. It relies on the agent following an instruction to avoid a tool that its effort level offers it. Lowering the effort removes the tool's opt-in instead, and it is a single, reversible knob.
- **Poll the PR view after the push until it catches up.** Rejected as the primary check. The push's exit status is already GitHub's answer. Polling would add sleeps and a timeout to tune, and could still give up early on a slow day.
- **Keep the budget at 5 and fix only the two bugs.** Rejected at the user's request. Thread-driven fix passes, CodeRabbit and the factory's own review all spend from one budget, so 5 leaves little room for a longer review conversation on a large PR.
