# 0026 — Dark Factory Unattended Development Pipeline

- **Status**: Accepted
- **Date**: 2026-05-06
- **Authors**: Jakub Anderwald

## Context

After [ADR-0024](./0024-realtime-support-agent.md) (real-time support agent) and [ADR-0025](./0025-support-allowlist-from-zoho-sender.md) (sender-gated auto-implementation), Drafto already routes allowlisted bug reports through `support-agent.sh` (Phase 1 — file + acknowledge) and `nightly-support.sh` Phase 3 (Phase 2 — implement at midnight). What's missing is a way to:

1. Decouple feature work from the midnight cadence — the household reporters end up waiting ~12h for any automated work to start.
2. Surface the pipeline to a human reviewer between "Claude has read the spec" and "Claude is writing code", so misinterpretations are caught early instead of producing a wrong PR.
3. Keep features moving on a board that the operator can monitor on mobile without opening a terminal.
4. Preserve the existing "human merges" rule and migration safety guards while letting allowlisted reporters approve work via email reply.

The goal: a "vibe-kanban-style" pipeline where dragging a card on a GitHub Projects v2 board triggers Claude-driven implementation, deploys to a beta channel, and waits for explicit human approval before firing production releases. Also: keep cost discipline ([CLAUDE.md → "Infrastructure cost discipline"](../../CLAUDE.md)) — no new paid services. Run on the existing Mac mini, free Vercel, free GitHub, free GitHub Actions.

## Decision

Build a **dark factory** as a fourth Mac-mini agent that extends the same skeleton as `support-agent.sh` (PID locks, atomic state via `state-cli.mjs`, phase-gated rollout, `factory-failure` issue trap). State lives in three already-free layers:

1. **GitHub Projects v2 board** — UI surface. Free, native to issues, mobile-friendly. The Status field's value is the source of truth for where each card sits in the lifecycle.
2. **Repository labels** (`status:*`, `factory-pause`, `migration-approved`, `factory-failure`, `parity:*`) — what the agent reads. A GitHub Action (`factory-status-mirror.yml`) mirrors Status changes onto labels within seconds of a drag, so the agent (which polls labels) sees Project field changes without itself needing a Project v2 PAT.
3. **`logs/factory-state.json`** (gitignored, mode 0600) — atomic via the same `state-cli.mjs` pattern as the support agent. Tracks worktree-slot ownership, per-issue retry budgets, and the global pause flag.

### Two human gates

The state machine has two transitions where a human must intervene:

- **Plan Review → In Progress** — plan-approval gate. The factory's `--plan` mode is read-only: it reads the issue, posts a structured plan as an issue comment, then stops. No code is written until the human (or an allowlisted reporter via email) drags the card forward.
- **In Test → Approved** — merge + ship gate. PR stays open with a Vercel preview URL; merging the PR requires the human (or allowlisted reporter) to authorise.

Both gates are reachable via the kanban for anyone, and via email reply for allowlisted reporters (Jakub + his wife) — see "Household autopilot" in [`docs/features/dark-factory.md`](../features/dark-factory.md).

### Concurrency

Up to **2 parallel worktrees** for `--implement`, slot-locked separately. `--plan`, `--watch`, and `--release` are I/O-bound and share single locks. Plan mode does not take a worktree slot — it does read-only research at `origin/main` HEAD only.

### Phased rollout

The factory rolls out in four phases, each gated on ≥5 clean runs at the previous phase:

| Phase | Behaviour                                                                                    |
| ----- | -------------------------------------------------------------------------------------------- |
| A     | Plan-only. `--implement` is a no-op; pure observation of plan quality.                       |
| B     | Web implementation enabled. Mobile/desktop changes auto-blocked at the post-check.           |
| C     | Mobile + desktop implementation enabled. Approved still merges + Vercel prod only.           |
| D     | Approved also dispatches iOS / Android beta + local Mac TestFlight. macOS prod stays manual. |

### Coexistence with existing pipelines

The factory does not replace `support-agent.sh` or `nightly-support.sh`. It integrates with them:

- `support-agent.sh` gains an "auto-Ready for allowlisted reporters" behaviour and an "accept-signal classifier" that maps email replies (`go ahead`, `ship it`, `thanks`) onto card transitions via `state-cli.mjs factory:advance`.
- `nightly-support.sh` Phase 3 (the existing midnight implementation pass) is deprecated **in stages** — it stays running while Phase A/B prove out the factory, gets disabled at Phase C cutover, and is removed at Phase D.

## Consequences

**Positive**

- Allowlisted reporters reach a Vercel preview without opening GitHub. Email a bug → receive plan email → reply "go ahead" → preview URL email → factory ships beta on approval. The reporter touches email twice (plan approval + done acknowledgement).
- Plan-vs-diff drift is checkable: the plan comment is a public, version-stable artifact the operator can compare against the resulting PR diff, instead of debugging Claude's reasoning post-hoc.
- The two human gates concentrate review attention where it matters (intent, ship-readiness) without forcing line-by-line code review on every PR.
- Worktree slots cap the blast radius of a misbehaving plan — at most two concurrent in-flight implementations at any time.
- Same failure-trap pattern as support-agent — outages file `factory-failure`-labelled issues so they're visible in the existing nightly-audit sweep.

**Negative**

- The factory burns a Claude session per `--plan` and per `--implement` cycle; budget is bounded by the per-issue retry counter in `factory-state.json`, but a runaway plan-review loop on a poorly-specced issue still costs more than a static template would.
- The Project v2 board is a third state surface (after labels and `factory-state.json`). The mirror workflow is the only thing that keeps Status and labels in sync — if it ever stops firing, the factory will appear to "ignore" board moves.
- A second launchd job (after `support-agent`, `nightly-support`, `nightly-audit`) is now load-bearing. Mac-mini downtime delays factory progress; the host is a single point of failure.
- The `--watch` mode polls open PRs to advance In Review → In Test, which means a CI flake that takes >24h to surface can silently leave a card hanging until the operator notices. The `nightly-audit` extension catches this with a "stuck in In Review" check.

**Neutral**

- The factory shares `claude --dangerously-skip-permissions` and the run-claude.mjs wall-time wrapper with the support agent. Failures look the same in logs and route the same admin email.
- All new state is in already-gitignored paths (`logs/factory-state.json`, `worktrees/`); the repo proper stays clean.
- The plan-vs-diff drift check is a quality signal, not a hard gate. A diff that exceeds the plan posts a warning comment and proceeds — the human reviewer at the In Test gate is the final word.

## Alternatives Considered

- **Custom kanban UI in `apps/web`.** Rejected. Projects v2 covers it for free, with mobile apps and email subscriptions out of the box. Building our own would be a multi-week project for negligible UX gain.
- **vibe-kanban integration.** Rejected. vibe-kanban runs its own state machine and worktree manager; integrating with it would split state across two systems and lose the "GitHub issues are source of truth" property. The factory's "drag-equals-action" pattern delivers the same UX without that split.
- **Single human gate (only at In Test → Approved).** Rejected. The plan-review gate is the early-stage misinterpretation catcher — without it, a wrong plan produces a wrong PR that the human must then reject in the In Test column, having already burned a worktree slot and a Claude implementation session. Doubling the gates costs negligible operator time (it's the same drag) and saves substantially more on rework.
- **One worktree slot.** Rejected as too restrictive — small fixes would queue behind larger ones for hours. Three+ slots would push the Mac mini's CPU budget under concurrent E2E test runs. Two is the empirical sweet spot from the `support-agent.sh` + `nightly-support.sh` overlap pattern.
- **Cross-repo orchestration.** Rejected — Drafto is a single-repo monorepo today, and the factory's worktree model assumes one repo root. If Drafto ever splits, this ADR will need a successor.
- **Auto-merge before Approved.** Rejected for non-allowlisted reporters. The merge-on-Approved-drag is the human's last word before code lands on `main`. Allowlisted reporters' issues _do_ auto-advance to Approved (their identity-on-file is the implicit sign-off), but the migration gate remains a hard stop in that path too.

## Related

- `docs/features/dark-factory.md` — operator manual (board URL, label glossary, troubleshooting).
- `docs/operations/factory-runbook.md` — phase progression criteria, kill switches, rollback drills.
- `docs/dark-factory-proposal.md` — the proposal document this ADR finalises (kept for the lifecycle table and implementation-wave breakdown).
- `scripts/setup-factory-labels.sh`, `scripts/setup-factory-board.sh` — one-shot bootstrap.
- `.github/workflows/factory-status-mirror.yml` — Status-field → label bridge.
- `.github/ISSUE_TEMPLATE/factory-feature.yml` — spec contract enforcement.
- [ADR-0024](./0024-realtime-support-agent.md) and [ADR-0025](./0025-support-allowlist-from-zoho-sender.md) — the support pipeline this ADR extends, not replaces.
