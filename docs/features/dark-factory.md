# Dark factory

**Status:** rolling out (Phase A) **Updated:** 2026-05-06

## What it is

A "vibe-kanban-style" pipeline where moving a card on a GitHub Projects v2 board triggers Claude-driven implementation, deploys the result to a beta channel, and waits for explicit human approval before firing production releases. Built on the existing Mac mini, free GitHub, free Vercel — no new paid services. See [ADR-0026](../adr/0026-dark-factory-pipeline.md) for the decision; the original proposal is [`docs/dark-factory-proposal.md`](../dark-factory-proposal.md).

## Current state

**Phase A (Plan-only).** The factory's `--plan` mode is wired up: it watches `status:ready` issues, posts a structured plan as an issue comment, and stops at `status:plan-review`. The `--implement` mode is a no-op at this phase. Promote past A only after ≥5 clean runs without human intervention.

## The board

- **Owner**: `JakubAnderwald`
- **Title**: `Drafto Factory`
- **URL**: bootstrap with `scripts/setup-factory-board.sh`, then record the URL here. The script prints it on success.

The board has one custom Status field with eleven values:

| Status      | Who sets it           | Meaning                                                               |
| ----------- | --------------------- | --------------------------------------------------------------------- |
| Backlog     | human                 | Filed, not yet specced. Factory ignores.                              |
| Ready       | human                 | Spec complete; factory may **plan** (read-only).                      |
| Planning    | factory               | Claude is reading the issue and writing a plan.                       |
| Plan Review | factory               | Plan posted as a comment; awaiting human approval.                    |
| In Progress | human / allowlisted   | Plan approved; factory implements per the approved plan.              |
| In Review   | factory               | PR open; factory monitors CI and review comments.                     |
| In Test     | factory               | Vercel preview ready; awaiting human approval.                        |
| Approved    | human / allowlisted   | Authorise prod release. Migration gate enforced.                      |
| Released    | factory               | PR merged; beta channels dispatched (Phase D).                        |
| Done        | human / support-agent | Final acceptance; issue closed.                                       |
| Blocked     | factory               | Spec incomplete, retry budget exhausted, parity violation, hard gate. |

Each Status maps 1:1 to a `status:*` label via `.github/workflows/factory-status-mirror.yml`. The factory agent reads labels, not Project v2 fields.

## Label glossary

The full set is created idempotently by `scripts/setup-factory-labels.sh`. Reference:

| Label                 | Set by               | Meaning                                                          |
| --------------------- | -------------------- | ---------------------------------------------------------------- |
| `status:ready`        | mirror workflow      | Spec accepted; factory may plan.                                 |
| `status:planning`     | factory              | Plan in progress.                                                |
| `status:plan-review`  | factory              | Awaiting plan approval.                                          |
| `status:in-progress`  | mirror / factory     | Implementation in progress.                                      |
| `status:in-review`    | factory              | PR open, CI / review comments active.                            |
| `status:in-test`      | factory              | Vercel preview ready, awaiting ship approval.                    |
| `status:approved`     | mirror / factory     | Approved for release; merge + dispatch authorised.               |
| `status:released`     | factory              | Merged + beta dispatched.                                        |
| `status:done`         | mirror / support     | Final acceptance.                                                |
| `status:blocked`      | factory              | Hard stop — see comment on issue.                                |
| `factory-pause`       | operator             | Global kill switch on this issue (factory ignores).              |
| `migration-approved`  | operator             | Authorises factory to merge a PR with `supabase/migrations` SQL. |
| `factory-failure`     | factory failure trap | Filed by `cleanup()` when a factory run errors out.              |
| `parity:web-only`     | operator             | Skip cross-platform parity check (legitimate web-only work).     |
| `parity:mobile-only`  | operator             | Skip cross-platform parity check (legitimate mobile-only work).  |
| `parity:desktop-only` | operator             | Skip cross-platform parity check (legitimate desktop-only work). |

## How to file an issue for the factory

Use the **Factory feature spec** template (`.github/ISSUE_TEMPLATE/factory-feature.yml`). It enforces the spec contract:

1. **What** — one paragraph user-facing description.
2. **Acceptance criteria** — bulleted, testable.
3. **Affected platforms** — checkboxes (web / iOS+Android / macOS).
4. **Schema changes?** — yes/no. If yes, the factory adds `needs-migration-review`.
5. **UI?** — screenshot / Figma URL if applicable.
6. **Out of scope** — explicit non-goals.

After filing, drag the card to **Ready** on the board. The mirror workflow applies `status:ready` within seconds; the factory picks it up on its next 5-min tick.

## Kill switches

- **Per-card**: drag the card to **Blocked**, or apply `factory-pause` to the issue. The factory ignores the card on the next tick.
- **Global**: run `node scripts/lib/state-cli.mjs factory:pause` on the Mac mini. The agent reads the flag every cycle and exits early when set. `factory:resume` to unpause. (Available once Wave 2 lands; until then, unload the launchd plist.)
- **Emergency stop**: `launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist` on the Mac mini, or `kill` the active claude PID under `logs/factory.*.pid`.

## Troubleshooting

### "I dragged a card but the factory didn't pick it up"

1. Check the workflow ran: GitHub → Actions → "Factory Status Mirror". Look for a successful run within the last minute.
2. If the workflow ran but the issue's labels didn't change: check the run's "Apply label" step output. Common causes: PAT expired (`FACTORY_PROJECT_TOKEN` secret), or the Status value isn't in the workflow's case statement (typo on a Status rename — update both `setup-factory-board.sh` and the workflow case).
3. If the label IS correct but the factory doesn't act: check `logs/factory-*.log` on the Mac mini. The agent might be paused (`factory-pause` global flag), out of retry budget for that issue, or holding both worktree slots on other issues.

### "The plan comment looks wrong / Claude misread the issue"

This is exactly what the Plan Review gate catches. Don't drag to In Progress. Instead, comment on the issue with the correction (or have the allowlisted reporter reply with rejection in email — the factory will re-plan on its next cycle). If you want the factory to forget and start over, drag the card back to **Ready** and the next tick will replan.

### "PR opened but CI keeps failing"

The factory's `--watch` mode loops `/push`-style: it reads CI failures and review comments, re-invokes Claude to fix, re-pushes. Bounded by `factory.issues[<n>].attempts` in `logs/factory-state.json`. When the budget is exhausted the card moves to **Blocked** with a comment listing the unresolved items. Human must take over from there.

### "Vercel preview never appeared in In Test"

The factory advances In Review → In Test only when (a) CI is green AND (b) the Vercel bot has commented with a preview URL on the PR. If CI is green but Vercel hasn't run, check the Vercel project's GitHub integration is wired up; sometimes the bot misses a push and a force-push to bump the PR head re-triggers it.

### "Allowlisted reporter's email reply didn't move the card"

`support-agent.sh`'s accept-signal classifier requires:

- The reporter's address matches `reporter-email` from the issue body footer (no impersonation via cc/bcc).
- The card is in one of the two transitionable states (`status:plan-review` → `status:in-progress`, or `status:released` → `status:done`).
- The reply text reads as accept-intent ("go ahead", "ship it", "thanks", `[ACCEPT]`, `[GO]`).

Check `logs/support/support-agent-*.log` for the per-thread classification line. If the classifier flagged the reply as non-accept-intent (e.g. it mentioned a new direction), the agent treated the reply as a fresh comment and the card stays where it is — drag it manually if needed.

## Related

- [ADR-0026](../adr/0026-dark-factory-pipeline.md) — decision record.
- [`docs/operations/factory-runbook.md`](../operations/factory-runbook.md) — phase promotion criteria, rollback drills, on-call response.
- [`docs/dark-factory-proposal.md`](../dark-factory-proposal.md) — original proposal (lifecycle table, household autopilot details, implementation waves).
- [`scripts/setup-factory-labels.sh`](../../scripts/setup-factory-labels.sh) — label bootstrap.
- [`scripts/setup-factory-board.sh`](../../scripts/setup-factory-board.sh) — Project v2 board bootstrap.
- [`.github/workflows/factory-status-mirror.yml`](../../.github/workflows/factory-status-mirror.yml) — Status field → label mirror.
- [`.github/ISSUE_TEMPLATE/factory-feature.yml`](../../.github/ISSUE_TEMPLATE/factory-feature.yml) — spec contract template.
