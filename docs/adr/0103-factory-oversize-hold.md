# 0103 — Factory Holds Unsplit Oversize Cards Before Implementing

- **Status**: Accepted
- **Date**: 2026-11-25
- **Authors**: Jakub Anderwald, with Claude Code

## Context

[ADR-0083](./0083-planner-size-estimate-and-oversize-label.md) made every plan carry a size estimate, labelled cards estimated at 1,500 added lines or more `factory-oversize`, and gave large plans a **Proposed split** as advice. The label informs the operator; it doesn't change what the factory does. Once the plan is approved, the card is implemented as one PR whatever its size.

The audit of 506 factory sessions over 30 days found that this wasn't enough. Three XL PRs took 45% of the period's spend. They are the PRs that hit the implement deadline, conflict with `main` repeatedly and take the most review rounds. The estimates were also low: actual PRs added 1.1–2.4× the **top** of the planner's range. The misses were mostly tests, fixtures, docs and ADRs, helpers, and prompt and runbook churn, which the prompt's "code, tests, docs, migrations" didn't call out.

A label that the operator can overlook at the Plan Review gate doesn't stop that spend. The decision to run a card that large should be an explicit act, not the default.

## Decision

1. **`--implement` holds an unsplit oversize card that hasn't started.** Right after `find_prior_pr`, before a slot, a worktree or a bundle is spent, `oversize_hold` re-reads the approved plan's size marker (`parsePlanSize`, through `scripts/lib/plan-size.mjs`). The card is held when all of these are true:
   - the estimate is at least `FACTORY_PLAN_OVERSIZE_LINES` (default 1,500);
   - neither the board item nor the issue has the `oversize-approved` label;
   - the card hasn't started: no prior PR (open or closed), no worktree slot assigned to it, no implement resume record ([ADR-0084](./0084-factory-implement-deadline-and-resume.md)), no implement run on record in its state (`implementSessionId`, which every implement start writes), and no `factory/issue-<n>` branch on origin. `lastImplementAt` doesn't count: the Phase A plan-only stub writes it without writing code. Because `find_prior_pr` returns null for a failed `gh` call as well as for no PR, the hold lists the PRs again itself.

   A card mid-run, such as a retry after a timeout or a revision back from In Test, never bounces. A plan with no size marker isn't held, and a dry run only logs.

2. **A held card goes back to Plan Review with one comment.** The factory posts a 🏭 comment that explains the hold and how to release it, then moves the card to **Plan Review**. The comment carries `<!-- drafto-factory-oversize-hold:<planCommentId>:<estLines> -->`. The estimate is part of the marker because replans edit the plan comment in place: a new estimate gets a new comment, and the same estimate never gets a second one. The comment is posted first and the move happens only once it is on the issue, so a failure in either step is retried on the next tick without a duplicate. If the factory can't read its state, list the PRs or check the branch on origin to tell whether the card has started, the card waits a tick: it neither bounces nor starts.

3. **The operator releases the hold in one of three ways:**
   - **split it**: comment `/split` to have the factory file the sub-cards from the **Proposed split** (the command comes with ADR-0104, the follow-up to this one), or file them by hand;
   - **run it as-is**: add the `oversize-approved` label and drag the card back to **In Progress**;
   - **narrow it**: comment to replan. A replan that brings the estimate under the threshold releases the hold when the card is dragged to In Progress again.

   The comment warns that a plain "approved" comment doesn't release the hold. It starts a replan, which is a paid planner run.

4. **The planner estimates honestly.** `scripts/factory-plan-prompt.md` lists what the count must include (tests and their fixtures, docs and ADRs, new helpers, migrations, and prompt and runbook edits). It says estimates have run 1.1–2.4× low and asks for `<estLines>` near the top of the range. It also tells the planner that an XL card is held until it is split or overridden. The class bounds and the marker are unchanged.

5. **Knobs and labels.**
   - `FACTORY_OVERSIZE_HOLD` (default `1`). `0`, or `FACTORY_PLAN_OVERSIZE_LINES=0`, turns the hold off. A bad value warns and means `1`.
   - `oversize-approved` is created by `scripts/setup-factory-labels.sh`. The override isn't voided automatically when the plan changes: a replan already needs a fresh drag to In Progress, which is the operator's decision point.
   - No `/drive-issue` twin. An interactive session's card carries `driver:interactive`, which the factory skips, and the hold catches it if it is handed back to the factory unstarted. Work the session pushed to `factory/issue-<n>` counts as started, even without a PR.

## Consequences

- **Positive**: an XL card can no longer be implemented by default. Running one is an explicit choice, a label, and the cheaper paths (split, narrow) are spelled out at the moment it matters. The hold costs no Claude run: it reads the plan the implement sweep already holds and two state records.
- **Negative**: an operator who meant to run a big card as-is has to add a label and drag it a second time. A low estimate still slips through, since the hold is only as good as the planner's guess; the prompt change aims to make that guess higher.
- **Neutral**: `/split` in the hold comment depends on ADR-0104. Until that lands, a `/split` comment is an ordinary Plan Review comment, which starts a replan. `oversize-approved` must be created once with `scripts/setup-factory-labels.sh` before an operator can add it.

## Alternatives Considered

1. **Hold at the Plan Review gate instead of at implement time.** The factory doesn't see the approval drag as an event; it sees an In Progress card on its next `--implement` tick. Holding there is the first point where the factory can act on the approval, before anything is spent.
2. **Hold every card with `factory-oversize`.** The label is synced only while the card is in Plan Review. The hold re-parses the approved plan instead, so it acts on the same estimate the operator approved, even if the label edit failed.
3. **Hold cards already in flight too.** A card that has a PR or an implement run on record has already cost most of what the hold saves. Bouncing it would also throw away a resumable session or a branch with work on it.
4. **Void `oversize-approved` when a replan changes the estimate**, as the migration gate voids `migration-approved` ([ADR-0078](./0078-migration-approval-tied-to-sql.md)). A replan already needs the operator to drag the card back to In Progress. That drag, with the label still on, is a fresh decision.
5. **Count "started" by the `attempts` counter.** `issues[n].attempts` is shared by `--plan` and `--implement`. A replan that fails bumps it and a `noop` replan after it doesn't reset it, so a card that has never been implemented can reach In Progress with `attempts` above 0, and the hold would let it run. The implement session id is written only when an implement run starts, so it says whether implementing began. (`lastImplementAt` isn't used: the Phase A stub writes it too.)
