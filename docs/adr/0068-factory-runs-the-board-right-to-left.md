# 0068 — Factory runs the board right to left

- **Status**: Accepted
- **Date**: 2026-11-08
- **Authors**: Jakub Anderwald, Claude

## Context

Every 5 minutes, `scripts/factory-agent-loop.sh` runs the factory's modes one after another under one mutex ([ADR-0026](./0026-dark-factory-pipeline.md)). Until now it ran them left to right across the board: `--plan` (Ready), `--implement` (In Progress), `--watch` (In Review, Testing, In Test), `--release` (Approved), then `--browser`.

That order starts new work before it finishes work already in flight:

- `--plan` and `--implement` make the tick's longest Claude calls. A merge the operator authorised by dragging a card to Approved waits behind all of them.
- When one of those calls hits the Claude session limit, the factory pauses itself ([factory-runbook.md → "Automatic pause on a Claude session limit"](../operations/factory-runbook.md#automatic-pause-on-a-claude-session-limit-self-healing)). Every later mode in the tick then exits at its pause gate, so `--release` is skipped too.
- `--implement` looks for a free worktree slot before `--watch` has moved anything on in that tick.

The operator wants the factory to finish work in flight before it takes on more.

## Decision

The loop runs the modes right to left across the board:

1. `--release`: Approved → Released
2. `--watch`: In Review → Testing → In Test
3. `--browser`: the Chrome runs for the candidates `--watch` just listed (ADR-0051, ADR-0053)
4. `--implement`: In Progress → In Review
5. `--plan`: Ready → Plan Review

`--browser` stays after `--release`, so a Chrome session never delays a merge, and after `--watch`, which writes its candidate list. It now runs before `--implement` and `--plan`, because verifying a card moves it towards In Test, which finishes work.

Nothing changes inside a mode. Each mode still handles its own column(s) the way it did before.

A test (`scripts/__tests__/factory-agent-browser.test.mjs`) pins this order.

## Consequences

- **Positive**: an Approved card merges at the start of the next tick, before any Claude call can delay it or pause the factory.
- **Positive**: `--watch` handles In Test feedback before `--implement` runs, so a change request rolled back to In Progress gets revised in the same tick instead of the next one.
- **Negative**: a PR that `--implement` opens is first watched on the next tick, about 5 minutes later. CI takes longer than that, so this costs little.
- **Negative**: a card waiting in Ready or In Progress can wait behind a browser session of up to `FACTORY_BROWSER_TIMEOUT_SEC` (15 min) in the same tick. That is the point: new work waits for work in flight.
- **Neutral**: the length of a tick doesn't change, only the order of its steps.

## Alternatives Considered

**Keep left to right.** Rejected: merges wait behind new planning and implementation, and a session limit hit while planning holds that tick's merges.

**Keep `--browser` last.** That still matches the rule that a Chrome session must never delay a merge, but planning and implementation would run ahead of verifying cards already in Testing. Rejected because it breaks the "finish before starting" rule.

**Add a WIP limit per column.** It would stop new work outright while too much is in flight. Rejected for now: the two worktree slots already cap how many cards `--implement` takes on, and changing the order fixes the delay without a new limit.
