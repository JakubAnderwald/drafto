# 0083 — Planner Size Estimate and Split on Request

- **Status**: Accepted
- **Date**: 2026-11-16
- **Authors**: Jakub Anderwald, with Claude Code

## Context

The factory analysis of Oct 17 – Nov 13 (337 sessions, 31 cards) found that PRs adding 1,500 lines or more cost about 4× more than the rest: a median of 32M weighted tokens against 8.7M. They time out, conflict with `main` again and again (#794 three times) and take the most review rounds. Nothing at plan time flagged them. By the time a card was visibly too big it was already In Progress, and splitting it then meant filing the parts by hand.

The planner already reads the code and lists the files a change touches, so it can estimate a PR's size before anything is built. It can't decide on its own to split a card: what to build stays the operator's call at the Plan Review gate ([ADR 0026](./0026-dark-factory-pipeline.md)). So the operator chooses. When the operator asks, the factory should file the parts as new cards, because filing them by hand means copying the spec template four times.

The planner also reads untrusted text: anyone can write in an issue on this public repo. Whatever it writes into a sub-card is posted publicly under the operator's identity. So its output can't be trusted to be well-formed or safe.

## Decision

1. **Every plan carries a size estimate.** The planner prompt (`scripts/factory-plan-prompt.md`) adds a `### Size` section after `### Confidence`. It gives the added lines as a range, the number of files, the platforms, and a class: `S` (under 200 lines), `M` (200–699), `L` (700–1,499) or `XL` (1,500 and up). The count covers every line the diff adds: code, tests, docs and migrations.
2. **Large plans propose a split.** From `L` upward the plan adds `### Proposed split`, with 2–4 sub-cards that can each ship on their own, in merge order. Each has a title, one line of what, acceptance criteria and platforms. A closing **If approved as-is:** line says which slice this card keeps when the operator approves without asking for a split (normally all of them, in one PR).
3. **The estimate is machine-readable.** The plan body ends with `<!-- drafto-factory-plan-size:<class>:<estLines> -->`, after "Estimated affected platforms" and before any ack markers. Every replan re-estimates and re-emits it, as it does the ack markers. `<estLines>` is the planner's best single estimate, an integer inside the range.
4. **Bash labels oversize cards.** After a `planned` or `replanned` run (also a first-plan `noop`, and a `split` that left the card in Plan Review), after the plan run's `case` statement, `plan_size_label` reads the marker from the OWNER plan comment with the new tested export `parsePlanSize(body)` (`factory-bundle.mjs`, through `plan-split.mjs size`).
   - If the estimate is at least `FACTORY_PLAN_OVERSIZE_LINES` (default 1500), it adds the `factory-oversize` label.
   - If a replan drops the estimate below that, it removes the label.
   - The label change is its own `gh issue edit`, never part of `transition_status`'s status-label swap. Before adding the label it checks, once per tick, that the repo has it, as `verify_column_ready` checks `status:testing`.
   - A plan with no marker leaves the label alone. `FACTORY_PLAN_OVERSIZE_LINES=0` turns the labelling off.
   - The directive regexes are unchanged (bash still reads only `action=`), and nothing runs between the `ACTION=` line and `plan_probe_finalize`.
5. **The operator can ask for a split.** An OWNER comment on a Plan Review card (or an allowlisted, provenance-checked forward, [ADR 0066](./0066-support-forward-provenance-gate.md)) that asks for a split triggers the replan sweep like any other feedback. While `FACTORY_PLAN_SPLIT=1` (the default), the replan bundle carries `replan.splitDir` (`<replyDir>/split`), and the planner then:
   - writes 2–4 full factory specs to `01.md` … `04.md` there. Each has a `# <conventional-commit title>` line, a `Depends on: none | 01, …` line, and the issue form's rendered headings (`### What`, `### Acceptance criteria`, `### Affected platforms` with checkbox lines, `### Schema changes?`, `### UI design (if applicable)`, `### Out of scope`);
   - PATCHes the plan with an ack for the comment and writes its reply as usual;
   - returns `action=split`.

   Without `splitDir` it treats the request as ordinary feedback and replies that splitting is off.

6. **Bash is the gate, and it checks everything before it creates anything.** `plan_split` refuses the split, posts one 🏭 reply saying why (with the `drafto-factory-plan-split-failed` marker, so the reply never reads as feedback) and returns the card to Plan Review unless all of these hold:
   - splitting is on;
   - a comment the replan answered has a line, its author's own and not quoted, that starts with "Split this card" or "Please split this card" and asks no question. Bash doesn't rely only on the planner's reading of the comment, so "Don't split this card" or "Should we split this card?" never splits a card, whatever the issue text told the planner. In an allowlisted forward, exactly one `> ` level (the forward's own quoting) is ignored. A deeper level is someone the reporter quoted, and never counts;
   - the OWNER plan acks every comment the replan answered. Otherwise a later tick would replan on the same request and could split twice;
   - `plan-split.mjs validate` passes. There must be 2–4 files numbered `01.md` on with no gap, and nothing else in the directory. Each must be a regular file, not a link, at most 20,000 bytes. Each needs a valid title, a `Depends on:` line naming only earlier parts, nothing else before `### What`, and no unclosed HTML comment. Sanitising drops everything after an unclosed `<!--`, so such a file is refused rather than filed cut short. Each must also pass the plan probe's secret scan ([ADR 0071](./0071-plan-stage-browser-probe.md)), which fails closed when it can't load every secret. An account or sign-in key file that doesn't exist is allowed: both live in the scanned secrets dir;
   - every part's spec, parsed from the sanitised text that will be posted, passes the gate a fresh issue gets: `parseSpec` and `spec_missing_section`.

   Before the gate, every HTML comment is stripped (a forged support footer or factory marker), every `drafto-factory` token is broken and every @mention gets a zero-width space. The secret scan runs on the raw file and again on the sanitised text, because stripping a comment can join a secret it split in two. A failure message never quotes a file's content.

7. **Filing.** Bash files the parts in order with `gh issue create --project "Drafto Factory" --body-file -`. Each body starts with where the part came from and a **Depends on** line that links the issues already filed for earlier parts. Bash then sets each new card's board Status to **Backlog** through a new read-only lookup, `factory-project.mjs item-for-issue`, so nothing starts until the operator drags it to Ready. A card it can't put in Backlog has no Status, which the factory never acts on either, so the split still finishes and its comment says so. Then bash:
   - closes the original as "not planned";
   - posts one comment on it that links the new issues (`drafto-factory-plan-split:done`), so the comment is true when it appears;
   - moves it to Done.

   If a create fails, bash stops there, and its reply lists the issues already created. If the close fails, the card goes back to Plan Review with a comment asking the operator to close it, and no summary is posted.

8. **Retries reconcile before they file.** Each part's body ends with a hidden `<!-- drafto-factory-split-part:<issue>:<part> -->` marker. The marker goes on in the same `gh issue create` call that files the part, so there is no window between filing a part and recording it.
   - **Finding earlier parts.** Each part names the original issue, so GitHub lists it on the original's timeline as a cross-reference, even when the run that filed it never saw gh's reply (a lost response, a killed tick). Before filing anything, `plan_split_earlier` reads that timeline. It keeps only issues that the factory's own gh identity opened, that are still open and that carry this card's part marker: anyone can open an issue that mentions the card.
   - **Planning the filing.** `plan-split.mjs plan` (`planSplitFiling`) then works out the whole filing before anything is created. A part reuses the earlier issue with its title only when that issue's spec matches the part's spec exactly and its **Depends on** line names exactly the issues this split resolves the part's dependencies to.
   - **A mismatch stops the split.** A changed spec, other dependencies, or a dependency on a part this split files anew (part A replaced, part B kept) files nothing and leaves the original open. A 🏭 reply names each conflict and asks the operator to close or edit those issues. Reusing such a part would keep a stale spec, or a card that depends on an obsolete issue; filing a new one beside it would leave two.
   - **Failing closed.** If the timeline or an issue can't be read, bash files nothing rather than risk a duplicate. Earlier parts that match no part are named in the summary for the operator to close.
9. **A card bash can't put in Backlog has no Status.** This was checked on the board (read-only, 2026-11-16): its "Item added to project" workflow is disabled, and Status is a single-select field with no default. `gh issue create --project` only adds the item. So when the `item-for-issue` lookup or `set-status Backlog` fails, the new card has no Status. No factory sweep reads a card with no Status, since every sweep queries a named column. The split therefore finishes, and its summary names the card to fix by hand. Enabling that workflow to set an active column would change this; the runbook says so.

## Consequences

- **Positive**: every plan states its size, and an oversize card is visible on the board before anyone approves it. Splitting a card is one comment, and the parts arrive as complete specs that pass the factory's own spec gate. Nothing starts without the operator: the parts sit in Backlog. The split is all or nothing up to the first `gh issue create`.
- **Negative**: the estimate is the model's guess from a read-only run, and the label is only as good as that guess. The planner's reply to the request is posted before bash checks the files, so it says what the factory will try, and bash's own comment says what happened. A failure partway through filing leaves the parts already filed. A retry reuses them only when a part's title, spec and dependencies are unchanged; any other difference stops the retry until the operator closes or edits them. The request rule is a fixed phrase: the operator has to start a line with "Split this card", and a request in other words is answered, not acted on. The sub-issues are posted under the operator's identity, so a planner misled by issue text could still file well-formed but unwanted cards in Backlog. Every check above still applies to them, and the original can be reopened.
- **Neutral**: the plan has two new sections, and the implementer reads them as part of the plan. `factory-oversize` must be created once with `scripts/setup-factory-labels.sh`; until it exists, oversize plans go unlabelled, with a warning in the log.

## Alternatives Considered

1. **Split automatically above the threshold.** This was rejected because what to build is the operator's decision at Plan Review. An automatic split would also file cards nobody asked for whenever the estimate is wrong.
2. **Let the planner run `gh issue create` itself.** This was rejected because the planner reads untrusted issue text, and its `gh` access is limited to the plan comment by design. Bash can check every file before anything becomes public; a model in the middle of its run can't be relied on to.
3. **Keep the original card as part 1.** This was rejected because the original's plan, acks and history describe the whole change. Closing it as "not planned" and filing every part fresh gives each part a clean spec and its own plan.
4. **Compare the class, not the line estimate, with the threshold.** This was rejected because the classes are fixed in the prompt, while the line threshold is a knob the operator can tune without a prompt change.
