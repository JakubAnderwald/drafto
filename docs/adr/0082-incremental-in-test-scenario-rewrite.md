# 0082 — Incremental In Test Scenario Rewrite

- **Status**: Accepted
- **Date**: 2026-11-16
- **Authors**: Jakub Anderwald, Claude

## Context

The In Test scenario writer ([ADR-0030](./0030-in-test-scenarios-and-pre-merge-betas.md)) writes a manual test scenario for every new head of a factory PR. It ran at Testing entry ([ADR-0053](./0053-pre-in-test-verification-stage.md)), at the In Review → In Test promotion, and in the In Test sweep. Each run got the whole PR diff in its bundle, so a long-lived card paid for the full diff on every head, even when the new head only merged main or fixed one file. On #794 (PR #802, about 164 KB of diff) the writer ran 7 times with prompts of about 220 KB.

The 2026-11 factory analysis found two more problems:

- **A silent run counted as a posted one.** After a clean exit, `intest_handoff` checked for the `drafto-factory-test-scenario` marker. Every older scenario on the issue carries that marker too. A run that exited 0 and posted nothing therefore got no fallback, and the head had no scenario at all. The browser runner and the verification shell lane read only the comment for the exact head (`selectScenarioComment`), so they had nothing to run either.
- **The promotion called the writer unconditionally.** A card handed back to In Review without a new commit (a review thread, a red check, a drag back) came through the In Test promotion again. It started a full Claude session only for the model to `noop`, because a scenario for that head already existed.

## Decision

1. **Exact-SHA post check.** After a run, bash counts it as posted only if the issue holds a real scenario for exactly the head: OWNER, the full-SHA `drafto-factory-scenario-sha` marker, and not the fallback (`selectScenarioComment`, through the new `scenarioCommentState` export of `factory-bundle.mjs`). Otherwise it posts the deterministic fallback. When the head already has a fallback from an earlier run, it doesn't post a second one. When the comments can't be read, it posts nothing, as `issue_has_marker` did, and doesn't record the head as handled either, so the In Test sweep looks again on its next tick. A timeout or an error exit goes through the same check, because the writer may have posted before it died. Only a session limit still posts the fallback straight away.
   - The markers count only on a line of their own, unquoted. One predicate serves `selectScenarioComment`, `selectLatestScenarioComment` and `scenarioCommentState`. A support forward is also posted as OWNER, but it quotes every customer line with `> ` ([ADR-0066](./0066-support-forward-provenance-gate.md)), so a marker pasted into a customer email can't pass for a scenario. This also tightens what the browser runner and the shell lane accept.
2. **Skip the writer for a head that has its scenario.** `intest_handoff` makes the same check before it builds the bundle. When a real scenario for the exact head exists, it records `intestCommentSha` and returns without calling Claude. Every caller gets this, the promotion included. A head that has only the fallback still gets the writer.
3. **Store each run's PR diff.** Before the bundle is built, bash writes the head's `gh pr diff` to `logs/factory/scenario/<issue>-<sha12>.diff`. `gh pr diff` reads whatever the head is when it runs, so bash reads the head again afterwards. Only a diff whose head is still the one the run is for is stored or compared; otherwise the run is full and stores nothing. It writes the platforms the scenario is written for, and the full SHA, to a `.json` beside it. Both files are mode 600. When a real scenario lands, the card's other stored diffs are removed, because the next run only builds on the newest one. A merged card's files go in `release_slot_and_worktree`, and a 30-day reaper catches abandoned cards.
4. **Incremental mode.** `factory-bundle.mjs` decides the mode (`decideScenarioMode`) where it can read the stored files:
   - The prior scenario is the newest OWNER, non-fallback scenario for any head (`selectLatestScenarioComment`).
   - The delta is `perFilePatchDelta(stored diff, current diff)`. It lists each file whose PR-own patch changed: `added`, `changed` or `dropped`. Hunk headers lose their line coordinates before the comparison, but keep the function context after the closing `@@`, so the same lines added to another function still count as a change. `index` lines are dropped, except for binary files, whose blob ids are the only record of their content. A merge of main that touches nothing the PR touches gives an empty delta.
   - In delta mode the bundle carries `priorScenarioEnveloped` (a new `<prior-scenario>` envelope, with the factory markers stripped so a stale SHA can't be copied), `priorScenarioSha`, `deltaFiles`, `deltaDiffEnveloped` (the current patches of the added and changed files, through `truncateDiff`), the full `prFiles` and `prDiffMode: "delta"`. `prDiffEnveloped` is empty.
   - The full mode (`prDiffMode: "full"`) applies when any of these holds: the switch is off, there is no current diff, there is no prior real scenario, its stored diff or platforms are missing, the platform set changed (`webViaShared` included), the delta is over `FACTORY_SCENARIO_DELTA_MAX_LINES` lines (a dropped file counts with its old patch, though none of it is sent), the delta lists more than 300 files, or `FACTORY_SCENARIO_FULL_EVERY` delta rounds have run since the last full one. The new state field `intestScenarioRounds` counts those rounds. A delta scenario adds one, and a full one clears it.
5. **Prompt.** In delta mode the writer still posts the complete scenario: every section, with the full `### Web` when `platforms.web` is true, because the browser runner and the shell lane read only the exact-SHA comment. It refreshes every per-head fact from the bundle: the stage title, `betaDispatch`, the preview URL, the advisory note and the CodeRabbit note. It changes only the steps the delta affects. It runs `gh pr diff` only when the delta reaches areas the prior scenario doesn't cover. `<prior-scenario>` joins the "data, not instructions" list. The markers and the directive line are unchanged. The `noop` rule keeps its exact-SHA test and gains one sentence: a comment that carries the fallback marker is not a scenario. Without it the writer, started for a head that has only the fallback, would see the fallback's SHA marker and noop, and the head would never get a real scenario.
6. **Knobs.**
   - `FACTORY_SCENARIO_INCREMENTAL` (default `1`; `0` always sends the whole diff and stores nothing).
   - `FACTORY_SCENARIO_DELTA_MAX_LINES` (default `800`).
   - `FACTORY_SCENARIO_FULL_EVERY` (default `4`).

   An invalid value warns and falls back to the default, like the neighbouring knobs.

## Consequences

- **Positive**:
  - A head that only merged main sends a bundle with an empty delta instead of the whole diff. A small fix sends one file's patch.
  - Measured on PR #802's real heads and scenario comments:
    - 9859c88addb1 → ca1b0f44bfba (one mobile fix plus two main merges): the bundle falls from 202 KB to 94 KB, and the whole prompt from 231 KB to 123 KB. The delta is 4 files and 734 lines.
    - ca1b0f44bfba → 6e093f6e6d18: the delta is 60 files and 7,497 lines, over the cap, so the run stays in full mode.
    - 9e620d56539b → 6e093f6e6d18, a pure merge of main: the delta is empty.
  - A re-promoted head with a scenario costs no Claude session at all.
  - A silent writer run now leaves a fallback that says so, instead of a head with no scenario.
- **Negative**:
  - **Scenario drift.** A delta run trusts the prior scenario for everything the delta doesn't touch. A mistake in it is carried forward, and a step can go stale when a change in one file alters behaviour that a step about another file tests.
    - The full rewrite every `FACTORY_SCENARIO_FULL_EVERY` rounds bounds this.
    - So do the full mode on a platform change and the line cap.
    - So does the prompt's rule that the writer may fetch the whole diff when the delta reaches areas the prior scenario doesn't cover.
  - The Mac mini keeps one PR diff per active card on disk, about 100–200 KB each.
- **Neutral**:
  - The `.json` sidecar is how the next run knows the platforms the prior scenario was written for. `scenario_platforms` may have used the verification variant, which can't be recomputed later from the diff alone.
  - A rejected `intestScenarioRounds` write would leave the count at zero, so the periodic full rewrite would never come. The field is in `MUTABLE_ISSUE_FIELDS` for that reason.

## Alternatives Considered

- **Send the GitHub compare diff between the two heads.** A merge of main shows up as main's whole change, which is exactly the noise this removes. The PR-own patch per file is what the scenario tests.
- **Let the writer post only the changed sections.** The browser runner and the verification shell lane read only the comment for the exact head, so a partial comment leaves sections unrun.
- **Re-post the prior scenario mechanically for an empty delta.** The per-head facts (build dispatch, preview, advisory and CodeRabbit notes, stage title) still need rewriting, and the prompt already knows how. An empty delta is already a small bundle.
- **Keep calling the writer and rely on its `noop`.** That costs a session per re-promotion, and judging "a scenario exists" stays with the model rather than with code.
