# Dark factory

**Status:** rolling out (Phase B engine + `--release` auto-merge built; runtime phase set on the plist) **Updated:** 2026-06-16

## What it is

A "vibe-kanban-style" pipeline where moving a card on a GitHub Projects v2 board triggers Claude-driven implementation, deploys the result to a beta channel, and waits for explicit human approval before firing production releases. Built on the existing Mac mini, free GitHub, free Vercel — no new paid services. See [ADR-0026](../adr/0026-dark-factory-pipeline.md) for the decision; the original proposal is [`docs/dark-factory-proposal.md`](../dark-factory-proposal.md).

## Current state

The runtime phase is set by `FACTORY_PHASE` on the launchd plist (see the runbook). The phases:

- **Phase A (Plan-only).** `--plan` watches `status:ready` issues, posts a structured plan comment, and stops at `status:plan-review`. `--implement` posts a one-time "implementation skipped" stub; `--watch` / `--release` are no-ops.
- **Phase B (Web-only, staged).** Approving a plan (drag Plan Review → In Progress) runs the real engine: `--implement` takes a worktree slot, implements the approved plan in `worktrees/factory-issue-<n>`, opens a PR, and runs the parity post-check (mobile/desktop changes are auto-blocked — Phase B is web-only). `--watch` then drives the PR: it runs a `/push`-style fix loop on failing CI / unresolved review comments and, once CI is green and the Vercel preview is reachable, advances the card to **In Test** and posts the preview URL. **In Test iteration:** while a card sits in In Test, commenting on the issue with a change request rolls it back to **In Progress**; the factory revises on the **same** PR branch (reusing the slot, worktree, and preview URL) and it flows back to In Test. Repeat until you're happy. A pure "thanks/looks good" comment is treated as noise (no rework); approval stays explicit — drag to **Approved** (or, household, reply "ship it"). **`--release` then auto-merges on Approved:** the Approved drag is the merge authorisation — the factory squash-merges the green PR via the GitHub API, advances the card to **Released**, and Vercel deploys main → prod. It refuses to merge a PR touching `supabase/migrations/**` until `migration-approved` is on the PR, and won't merge unless CI is green and conflict-free. Hard holds (missing migration approval, conflicts, a failed merge) leave the card in Approved **and post a one-time comment**; transient waits (CI still running, mergeability still computing) leave it in Approved silently and retry next tick. Just before merging it resolves any outstanding review threads (CodeRabbit / reviewers) so the merge engages `required_conversation_resolution` explicitly rather than bypassing it. Beta-channel dispatch (iOS/Android/macOS) stays a Phase D concern. Promote per phase only after ≥5 clean runs without human intervention.

## The board

- **Owner**: `JakubAnderwald`
- **Title**: `Drafto Factory`
- **URL**: <https://github.com/users/JakubAnderwald/projects/1>

To re-bootstrap (e.g. after a deletion), run `scripts/setup-factory-board.sh`. It is idempotent and prints the URL on success.

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

The factory agent reads the Status field directly via the GitHub GraphQL API on each 5-min tick. It also writes a matching `status:*` label as a transition side-effect (for filtering on the Issues list); the labels are observability, not the agent's queue.

## Label glossary

The full set is created idempotently by `scripts/setup-factory-labels.sh`. Reference:

| Label                 | Set by               | Meaning                                                              |
| --------------------- | -------------------- | -------------------------------------------------------------------- |
| `status:ready`        | human (via board)    | Spec accepted; factory may plan.                                     |
| `status:planning`     | factory              | Plan in progress.                                                    |
| `status:plan-review`  | factory              | Awaiting plan approval.                                              |
| `status:in-progress`  | human / factory      | Implementation in progress.                                          |
| `status:in-review`    | factory              | PR open, CI / review comments active.                                |
| `status:in-test`      | factory              | Vercel preview ready, awaiting ship approval.                        |
| `status:approved`     | human / factory      | Approved for release; merge + dispatch authorised.                   |
| `status:released`     | factory              | Merged + beta dispatched.                                            |
| `status:done`         | human / support      | Final acceptance.                                                    |
| `status:blocked`      | factory              | Hard stop — see comment on issue.                                    |
| `factory-pause`       | operator             | Global kill switch on this issue (factory ignores).                  |
| `migration-approved`  | operator             | Authorises factory to merge a PR with `supabase/migrations` SQL.     |
| `factory-failure`     | factory failure trap | Filed by `cleanup()` when a factory run errors out.                  |
| `parity:web-only`     | operator             | Skip cross-platform parity check (legitimate web-only work).         |
| `parity:mobile-only`  | operator             | Skip cross-platform parity check (legitimate mobile-only work).      |
| `parity:desktop-only` | operator             | Skip cross-platform parity check (legitimate desktop-only work).     |
| `parity:infra-only`   | operator             | Skip parity check; change touches no app platform (scripts/docs/CI). |

## How to file an issue for the factory

Use the **Factory feature spec** template (`.github/ISSUE_TEMPLATE/factory-feature.yml`). It enforces the spec contract:

1. **What** — one paragraph user-facing description.
2. **Acceptance criteria** — bulleted, testable.
3. **Affected platforms** — checkboxes (web / iOS+Android / macOS), or **None** for a factory-internal / docs / CI change that touches no app platform.
4. **Schema changes?** — yes/no. If yes, the factory adds `needs-migration-review`.
5. **UI?** — screenshot / Figma URL if applicable.
6. **Out of scope** — explicit non-goals.

After filing, drag the card to **Ready** on the board. The factory picks it up on its next 5-min tick — it queries the board's Status field directly, then applies the `status:ready` label as a side-effect for filtering on the Issues list.

## Kill switches

- **Per-card**: drag the card to **Blocked**, or apply `factory-pause` to the issue. The factory ignores the card on the next tick.
- **Global**: run `node scripts/lib/state-cli.mjs factory:pause` on the Mac mini. The agent reads the flag every cycle and exits early when set. `factory:resume` to unpause. (Available once Wave 2 lands; until then, unload the launchd plist.)
- **Emergency stop**: `launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist` on the Mac mini, or `kill` the active claude PID under `logs/factory.*.pid`.

## Troubleshooting

### "I dragged a card but the factory didn't pick it up"

1. The factory polls every 5 minutes; wait one tick. Confirm the launchd job is alive on the Mac mini: `launchctl list | grep eu.drafto.factory`. PID column `-` with exit `0` is normal between ticks; a non-zero exit means the last tick failed — check `logs/launchd-factory-stderr.log`.
2. Check the agent saw the card on its latest tick: `logs/launchd-factory-stdout.log` (or `logs/factory-plan-*.log`) should mention the board fetch. A `factory-project find-project failed` warning means the `gh` token on the Mac mini is missing the `project` scope — run `gh auth refresh -s project`.
3. If the tick ran and the card was in scope but ignored: check the issue for a `factory-pause` label, or `logs/factory-state.json` for a global `paused: true` flag, or the issue's retry budget under `issues[<n>].attempts`.
4. A card that _was_ picked up can still look idle during its first implement while dependencies install. The factory now seeds `node_modules` from the main checkout by clonefile and runs a fast offline reconcile (seconds — logged as `seeding node_modules (clonefile) + reconciling deps`); a multi-hour `pnpm install` was the old behavior (#451) and is no longer expected.

### "A card is stuck in Planning"

`Planning` is a transient, factory-owned status — a card should only sit there for the seconds a planner runs. If one is parked there across ticks, an earlier `--plan` tick died between moving the card to Planning and its follow-up transition (e.g. a launchd SIGTERM during the board write, which stranded #418, or a claude timeout). You don't need to do anything: the **rescue sweep** at the top of every `--plan` tick re-floats orphaned Planning cards automatically — if the plan comment was already posted it goes back to **Plan Review**, otherwise it returns to **Ready** to be re-planned (bounded by the `attempts` budget, so a card that keeps dying ends up **Blocked**). To recover immediately instead of waiting for the next tick, drag the card to **Plan Review** (plan comment present) or **Ready** (no plan comment) by hand.

### "The plan comment looks wrong / Claude misread the issue"

This is exactly what the Plan Review gate catches. Don't drag to In Progress. Two paths:

- **Tweak (preferred).** Comment on the issue with your correction — keep the rest of the plan intact. On the next 5-min tick the factory re-invokes the planner with your comment in the bundle and **edits the existing plan comment in place** (GitHub shows the "edited" badge; the comment ID stays stable). Allowlisted reporters can do the same by replying to the planning email — `support-agent.sh`'s `--auto-classify` step 4.5 forwards the reply as a GitHub comment with `OWNER` association, which the factory detects identically.
- **Full restart.** If you want the factory to discard the plan and start fresh, delete the bot's `<!-- drafto-factory-plan -->` comment, then drag the card back to **Ready**. The next tick will plan from scratch.

How the in-place replan stays idempotent: after a successful replan, the edited plan body carries one `<!-- drafto-factory-replan-ack:<comment-id> -->` marker per trigger comment. The next tick only re-fires if there's a newer OWNER comment whose ID isn't in the ack set — a thank-you reply that produces `action=noop` still gets ack-stamped, so it doesn't loop.

### "PR opened but CI keeps failing"

The factory's `--watch` mode loops `/push`-style: it reads CI failures and review comments, re-invokes Claude to fix, re-pushes. Bounded by `factory.issues[<n>].attempts` in `logs/factory-state.json`. When the budget is exhausted the card moves to **Blocked** with a comment listing the unresolved items. Human must take over from there.

### "Vercel preview never appeared in In Test"

The factory advances In Review → In Test only when (a) CI is green AND (b) the Vercel bot has commented with a preview URL on the PR. If CI is green but Vercel hasn't run, check the Vercel project's GitHub integration is wired up; sometimes the bot misses a push and a force-push to bump the PR head re-triggers it.

### "I tested the preview and want changes"

Comment the change on the **issue** while the card is in **In Test** (e.g. "the close button overlaps the title — move it left"). On the next `--watch` tick the factory rolls the card back to **In Progress** and posts "🏭 revising…"; the next `--implement` tick applies your feedback on the **same** PR branch (the approved plan still bounds scope — a request outside it is Blocked for a re-plan), and the card flows back through In Review → In Test with the preview redeployed. Iterate as many rounds as you like. To stop and ship instead, drag the card to **Approved** (a "looks good"/"thanks" comment is treated as noise, not a ship signal — approval is always the explicit drag). The factory only acts on comments posted _after_ the preview it last showed you, so older discussion doesn't re-trigger work.

### "Allowlisted reporter's email reply didn't move the card"

`support-agent.sh`'s accept-signal classifier requires:

- The reporter's address matches `reporter-email` from the issue body footer (no impersonation via cc/bcc).
- The card is in one of the two transitionable states (`status:plan-review` → `status:in-progress`, or `status:released` → `status:done`).
- The reply text reads as accept-intent ("go ahead", "ship it", "thanks", `[ACCEPT]`, `[GO]`).

Check `logs/support/support-agent-*.log` for the per-thread classification line. If the classifier flagged the reply as non-accept-intent (e.g. it mentioned a new direction), the agent treated the reply as a fresh comment and the card stays where it is — drag it manually if needed.

### "A card moved to Blocked saying 'low disk'"

Before starting an implementation the factory checks free space on the build volume and, if it's below `FACTORY_MIN_FREE_DISK_GB` (default 3 GB), parks the card in **Blocked** with a `<!-- drafto-factory-disk-low -->` comment instead of failing mid-build. Reclaim space on the Mac mini (`git worktree prune`; clear Xcode `DerivedData`, old simulators, and `~/.gradle/caches`; strip `node_modules` from stale `.claude/worktrees/*` and `worktrees/*`), then drag the card back to **In Progress**. See [`docs/operations/factory-runbook.md`](../operations/factory-runbook.md) → "Worktree installs & disk" for the full reclamation + pnpm-store runbook.

## Related

- [ADR-0026](../adr/0026-dark-factory-pipeline.md) — decision record.
- [`docs/operations/factory-runbook.md`](../operations/factory-runbook.md) — phase promotion criteria, rollback drills, on-call response.
- [`docs/dark-factory-proposal.md`](../dark-factory-proposal.md) — original proposal (lifecycle table, household autopilot details, implementation waves).
- [`scripts/setup-factory-labels.sh`](../../scripts/setup-factory-labels.sh) — label bootstrap.
- [`scripts/setup-factory-board.sh`](../../scripts/setup-factory-board.sh) — Project v2 board bootstrap.
- [`.github/ISSUE_TEMPLATE/factory-feature.yml`](../../.github/ISSUE_TEMPLATE/factory-feature.yml) — spec contract template.
