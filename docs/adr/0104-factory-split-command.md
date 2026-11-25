# 0104 — `/split`: the Factory Files a Plan's Proposed Split

- **Status**: Accepted
- **Date**: 2026-11-25
- **Authors**: Jakub Anderwald, with Claude Code

## Context

[ADR-0083](./0083-planner-size-estimate-and-oversize-label.md) gave every plan a size estimate and, from class `L` up, a **Proposed split**: 2–4 sub-cards that can each ship on their own. The split stayed advice: the operator filed any sub-issues by hand. ADR-0083 also rejected an automated split on request (its Alternative 1), built in PR #841 and dropped because its edge cases made a large, security-sensitive surface.

The factory audit of 506 sessions ([report](https://claude.ai/artifact/JcSyvJoExc7WkHP3FgwUHE)) found that three XL PRs took 45% of 30-day spend. The split was proposed each time, and filing it by hand was the step that didn't happen. The operator asked for a one-word way to accept a proposed split from the card itself.

PR #841 failed on a model that both decided and wrote the split, triggered by any comment that read like a request. The edge cases it hit fall into four groups:

- recognising the request;
- creating issues idempotently;
- board membership;
- a split interrupted part-way.

This decision answers each one with a narrow trigger and bash-owned writes.

## Decision

1. **The trigger is one exact command.** In the `--plan` Plan Review sweep, before any replan, the factory looks for an OWNER comment newer than the plan whose whole body, trimmed, is `/split`.
   - **Exact match.** Quoted text, a code fence, a second line or any other wording is ordinary feedback for the planner.
   - **Same gate as feedback.** Each candidate goes through the OWNER and support-forward gate that replan feedback uses (`owner_comments_since`, [ADR-0066](./0066-support-forward-provenance-gate.md)).
   - **Ack markers.** A directive counts until a factory comment acks it with `<!-- drafto-factory-split-ack:<commentId> -->`, or the plan body acks it with a `replan-ack` marker (the planner already took it as feedback, with the knob off at the time).
   - **Never replan feedback.** The replan detector drops every directive. With the knob off it drops only the answered ones.
2. **A tool-less splitter writes the bodies.** `split_write_cards` runs Claude with `scripts/factory-split-prompt.md`.
   - **Flags.** It runs at `FACTORY_PLAN_EFFORT` on `${FACTORY_MODEL:-opus[1m]}`, with `--tools ""`, `--no-chrome` and `--strict-mcp-config`. It has no shell, no files and no network.
   - **Input.** The bundle (`factory-split.mjs bundle`) holds the parent's spec, the plan and its Proposed split, each enveloped as data.
   - **Output.** A JSON array of 2–4 `{title, body}` between `BEGIN DRAFTO SPLIT` and `END DRAFTO SPLIT` lines, or `{"refused": "<why>"}`.
   - **Body format.** Each body uses the issue form's six headings: `### What`, `### Acceptance criteria`, `### Affected platforms`, `### Schema changes?`, `### UI design (if applicable)` and `### Out of scope`.
   - **No Proposed split.** If the plan has no such section, nothing runs.
3. **Bash checks everything before it files anything.**
   - **Structure.** `parseSplitOutput` requires the six headings, each exactly once, in the form's order, and no other heading. It also enforces:
     - 2–4 cards;
     - one-line titles of at most 120 characters, none repeated;
     - bodies of at most 12,000 characters;
     - no `drafto-factory` or `drafto-support` text and no HTML comments.
   - **Mentions.** It breaks every @mention, since the issues are filed under the operator's identity.
   - **Spec gate.** Every parsed spec then goes through `spec_missing_section`, the gate a Ready card meets.
   - **One failure stops the split.** Any failure, a refusal or a failed run posts one 🏭 "Split not filed" comment with the reason and the ack. Nothing is created, the card stays in Plan Review, and a new `/split` comment tries again. A session limit pauses the factory instead, as the plan runs do.
4. **Bash files the sub-cards, in order.** `split_file_children` handles the writes.
   - **The record.** The checked cards are kept in `logs/factory/split/issue-<n>/plan-<planCommentId>.json` (mode 600), with the plan body's sha256 in `plan-<planCommentId>.sha256`. A replan keeps the plan comment's id, so cards saved from an earlier plan are split again, unless one of them is already filed.
   - **Each card's body.** Card _i_ is filed with `gh issue create`. Its body gets a `### Split from` section:
     - the parent's number;
     - for every card after the first, `Depends on #<previous>`;
     - a hidden `<!-- drafto-factory-split-child:<parent>:<planCommentId>:<i> -->` marker.
   - **State.** Each number is recorded at once in the new state field `splitChildren` (`<planCommentId>:<total>:<n1>,<n2>…`). Once the split comment is posted the record becomes `done:<planCommentId>:<n1>,<n2>…` and the saved cards are deleted, so a later `/split` of the same plan comment (a replan keeps its id) starts afresh.
   - **Lost replies.** Before filing card _i_, bash lists the repo's 50 newest issues and takes an open OWNER issue that already carries card _i_'s marker. A closed one belongs to an earlier split of the same plan comment, so it doesn't count. A `gh issue create` whose reply was lost is then found instead of filed twice. If that lookup fails, nothing is filed this tick.
5. **Then the board and the parent.** `split_finish` makes the remaining moves.
   - **Board membership.** It puts each sub-card on the board with `factory-project.mjs ensure-item`, which adds a missing one.
   - **Sub-issue links.** It links each sub-card as a GitHub sub-issue of the parent. This is best effort: a failed link is logged, and the "Split from" line still names the parent.
   - **Columns.** It moves the **first** sub-card to Ready, unless it has already moved on. The rest stay in Backlog, so a later part is never planned against code that hasn't merged. Every sub-card still passes the human plan gate.
   - **The parent.** It labels the parent `factory-split` and posts one 🏭 comment that lists the sub-cards and carries `<!-- drafto-factory-split:<planCommentId> -->` and the acks. Then it moves the parent to Backlog, which the factory ignores, without a status label.
   - **Retries.** Any failure before the comment returns early, and the next tick repeats the steps without a second Claude run. Each step is safe to repeat.
   - **A split parent stays parked.** If a parent that carries `factory-split` and its split comment comes back to Plan Review, the next tick moves it back to Backlog.
6. **Knob and label.**
   - **`FACTORY_SPLIT`** defaults to `1`. With `0`, a `/split` comment is ordinary feedback again, and the planner answers it.
   - **The label.** `scripts/setup-factory-labels.sh` creates `factory-split`.
   - **The planner prompt.** It now says the operator can comment `/split`, and it asks for Proposed split titles and acceptance criteria concrete enough to expand.

## Consequences

- **Positive**: accepting a proposed split costs one comment, so XL cards get split instead of implemented whole. The model never writes to GitHub, and nothing it prints is filed until it passes the parser and the same spec gate as a hand-filed card. A split interrupted at any step resumes on the next tick, without duplicates and without a second paid run.
- **Negative**: the factory now files public issues under the operator's identity from model-written text. The exact-command trigger, the OWNER and support-forward gate, the validator and the mention defang limit that, but a body's prose is still the model's. The first sub-card's move to Ready can race the board's "Item added to project" workflow, which sets new items to Backlog. If that happens, the sub-card sits in Backlog and must be dragged to Ready by hand. Any other feedback posted with `/split` gets no replan, because the card leaves Plan Review.
- **Neutral**: one more Claude call site (eight in all), the `splitChildren` state field, the `factory-split` label and a new prompt file. `factory-project.mjs` gains `ensure-item`.

## Alternatives Considered

1. **ADR-0083's split on request, unchanged.** In PR #841 the planner wrote the specs in its own run, and any comment that read like a request triggered it. That merged deciding with writing, gave a model with tools a say over what got filed, and made "recognising the request" a fuzzy-matching problem. Here the trigger is one exact word, the splitter has no tools, and bash owns every write.
2. **`gh issue create --project "Drafto Factory"`.** Rejected. A create that succeeds but fails to add the issue to the board is reported as a failure, which can't be told apart from a create that failed outright. Creating plainly and then running an idempotent `ensure-item` makes board membership a step of its own that a retry can catch up.
3. **Move every sub-card to Ready.** Rejected. Later parts would be planned against code that doesn't exist yet. One card in Ready at a time keeps the merge order.
4. **Close the parent.** Rejected. Backlog plus the label keeps the plan and the conversation in one open place until the sub-cards ship, and the operator closes it.
