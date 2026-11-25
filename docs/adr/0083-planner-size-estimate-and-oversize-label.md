# 0083 — Planner Size Estimate and Oversize Label

- **Status**: Accepted
- **Date**: 2026-11-16
- **Authors**: Jakub Anderwald, with Claude Code

> **Amended by [ADR-0103](./0103-factory-oversize-hold.md)** (2026-11-25): an oversize estimate no longer only labels the card. `--implement` sends a card that hasn't started, whose approved plan estimates at least `FACTORY_PLAN_OVERSIZE_LINES`, back to Plan Review unless the operator added `oversize-approved` (`FACTORY_OVERSIZE_HOLD`, default on). The planner prompt now counts tests, fixtures, docs and ADRs, helpers, and prompt and runbook edits, and asks for `<estLines>` near the top of the range. The label, the marker and the size classes are unchanged.

> **Amended by [ADR-0104](./0104-factory-split-command.md)** (2026-11-25): the factory now files a plan's **Proposed split** when the operator comments `/split` on the card. Decision 2's "the operator files any sub-issues by hand" and "the factory never files issues" no longer hold, and Alternative 1 (automated split on request) is revisited there in a narrower form. The planner itself still never files issues. A tool-less splitter run writes the bodies, and bash checks and files them.

## Context

The factory analysis of Oct 17 – Nov 13 (337 sessions, 31 cards) found that PRs adding 1,500 lines or more cost about 4× more than the rest: a median of 32M weighted tokens against 8.7M. They time out, conflict with `main` again and again (#794 three times) and take the most review rounds. Nothing at plan time flagged them. By the time a card was visibly too big, it was already In Progress.

The planner already reads the code and lists the files a change touches, so it can estimate a PR's size before anything is built. Whether to split a card stays the operator's call at the Plan Review gate ([ADR 0026](./0026-dark-factory-pipeline.md)).

## Decision

1. **Every plan carries a size estimate.** The planner prompt (`scripts/factory-plan-prompt.md`) adds a `### Size` section after `### Confidence`, and after **Browser probe** when the plan has one. It gives:
   - the added lines as a range;
   - the number of files and the platforms;
   - a class: `S` (under 200 lines), `M` (200–699), `L` (700–1,499) or `XL` (1,500 and up).

   The count covers every line the diff adds: code, tests, docs and migrations.

2. **Large plans propose a split, as advice.** From `L` upward the plan adds `### Proposed split`: 2–4 sub-cards that can each ship on their own, in merge order. Each has a title, one line of what, acceptance criteria and platforms. A closing **If approved as-is:** line says which slice this card keeps when the operator approves the plan unchanged (normally all of them, in one PR).
   - The section is advice for the operator, who files any sub-issues by hand.
   - The prompt tells the planner it never files issues (`gh issue create` stays on its refuse-list).
   - A comment asking the planner to split the card gets a reply that the operator files the sub-issues from the **Proposed split**.
3. **The estimate is machine-readable.** The plan body ends with `<!-- drafto-factory-plan-size:<class>:<estLines> -->`, after "Estimated affected platforms" and before any ack markers. Every replan re-estimates and re-emits it, as it does the ack markers. `<estLines>` is the planner's best single estimate, an integer inside the range.
4. **Bash labels oversize cards.** `plan_size_label` reads the marker from the OWNER plan comment with the tested export `parsePlanSize(body)` (`factory-bundle.mjs`, through the `scripts/lib/plan-size.mjs` CLI).
   - **When it runs.** After the plan run's `case` statement, for `planned` or `replanned`, and for a first-plan `noop`.
   - **Add and remove.** If the estimate is at least `FACTORY_PLAN_OVERSIZE_LINES` (default 1500), it adds the `factory-oversize` label. If a replan drops the estimate below that, it removes the label.
   - **How it writes.** Each change is its own `gh issue edit`, never part of `transition_status`'s status-label swap. Before adding the label, it checks once per tick that the repo has it, as `verify_column_ready` checks `status:testing`.
   - **Every-tick re-sync.** The replan sweep also re-syncs the label on every tick, for every Plan Review card. It uses the plan and board labels it already reads there, so a failed edit, or a label created after the plan, catches up without waiting for another replan. This costs no extra API call unless the label must change. Within a tick, `PLAN_SIZE_LAST` records the edit it just made, so a later call doesn't act on the board's stale labels.
   - **Off switch and missing markers.** A plan with no marker leaves the label alone, and `FACTORY_PLAN_OVERSIZE_LINES=0` turns the labelling off. Repeated log lines (no marker, label missing from the repo) are written once per daily log.
   - **Untouched code.** The directive regexes are unchanged (bash still reads only `action=`), and nothing runs between the `ACTION=` line and `plan_probe_finalize`.
5. **The label is bootstrapped like the others.** `scripts/setup-factory-labels.sh` creates `factory-oversize`, and the docs' label table lists it. Until the script has run, oversize plans go unlabelled and the plan log says so once per day.

## Consequences

- **Positive**: every plan states its size, and an oversize card is visible on the board before anyone approves it. The proposed split gives the operator a ready-made breakdown to file by hand. The factory itself never creates issues, so none of the risks of filing public issues from model output apply.
- **Negative**: the estimate is the model's guess from a read-only run, and the label is only as good as that guess. Splitting a card still takes the operator's time: filing each sub-issue and closing or narrowing the original.
- **Neutral**: the plan has two new sections, and the implementer reads them as part of the plan. `factory-oversize` must be created once with `scripts/setup-factory-labels.sh`.

## Alternatives Considered

1. **Automated split on request.** A Plan Review comment such as "Split this card" made the planner write one spec per part, and bash validated them and filed them as Backlog cards before closing the original. It was built in PR #841 and then dropped by the operator's decision, after three review rounds kept turning up edge cases:
   - **Recognising the request:** quote levels in forwarded emails, fenced and indented code, and CR or U+2028 inside a line.
   - **Idempotent creation:** a lost `gh issue create` reply, a tick killed mid-split, retries that must reuse earlier parts only when their spec and dependencies still match, and duplicate titles.
   - **Board membership:** a part created but never added to the board, or whose Backlog status failed.
   - **Interrupted splits:** an original left open beside parts already filed.

   Each case had a fix, but together they made a large, security-sensitive surface. It would have filed public issues under the operator's identity from text written by a model that reads untrusted issue content. That was too much for a step the operator can do by hand in a few minutes from the **Proposed split**.

2. **Split automatically above the threshold.** This was rejected because what to build is the operator's decision at Plan Review. An automatic split would also file cards nobody asked for whenever the estimate is wrong.
3. **Compare the class, not the line estimate, with the threshold.** This was rejected because the classes are fixed in the prompt, while the line threshold is a knob the operator can tune without a prompt change.
