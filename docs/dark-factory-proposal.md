# Drafto Dark Factory — Unattended Development Pipeline

> **Status (2026-05-06)**: Phase A rollout in progress. ADR-0026 records the
> decision; operator docs live at `docs/features/dark-factory.md` and
> `docs/operations/factory-runbook.md`. This proposal stays as the canonical
> wave-by-wave breakdown until Phase B lands and the doc is archived.
>
> **What's landed**:
>
> - **Wave 1 — Foundations** (PR #386, merged 2026-05-06): all 16 labels
>   (`status:*`, `parity:*`, `factory-pause`, `migration-approved`,
>   `factory-failure`); the **Drafto Factory** Project v2 board with the
>   11-option Status field; `setup-factory-labels.sh` + `setup-factory-board.sh`
>   bootstrap scripts (the latter rewritten to use direct GraphQL throughout —
>   see PR #386 follow-up commit `21266d6`); `factory-feature.yml` issue
>   template; ADR-0026; operator manual + runbook.
> - **PR #388 trigger-name fix** (merged 2026-05-06): one-line correction of
>   the workflow's `on:` event name from `project_v2_item` to
>   `projects_v2_item`. Necessary but insufficient — see pivot below.
>
> **Path-A pivot (this update)**: the GitHub Actions mirror workflow
> (`.github/workflows/factory-status-mirror.yml`) has been **dropped** because
> `projects_v2_item` events are documented org-only — they do not fire for
> user-owned Project v2 boards (community discussion #40848, open since 2022,
> no fix planned). Drafto lives under a personal account, so no event ever
> reached the workflow. The architecture now has the Mac-mini agent read the
> Project v2 board directly via GraphQL on its 5-min tick. Labels are written
> by the agent as transition side-effects (for human filtering / observability)
> rather than as the agent's queue. Single source of truth: the board's Status
> field. Reaction time: ≤5 min instead of ≤30 s — acceptable for the
> "vibe-kanban" cadence and matches Drafto's existing Mac-mini polling
> pattern (`support-agent.sh`, `nightly-support.sh`, `nightly-audit.sh`).
>
> **What's pending**:
>
> - **Wave 2 — Core libraries** (next PR): `scripts/lib/factory-project.mjs`
>   (Project v2 GraphQL reader/writer — replaces the `factory-status-mirror.yml`
>   role), `scripts/lib/factory-state.mjs`, `scripts/lib/factory-bundle.mjs`,
>   `scripts/lib/state-cli.mjs` extensions for `factory:*` subcommands.
> - **Wave 3 — The agent** (after Wave 2): `scripts/factory-plan-prompt.md`,
>   `scripts/factory-prompt.md` (Phase A no-op stub), `scripts/factory-agent.sh`
>   with `--plan` working end-to-end and `--implement` returning a "phase=A;
>   implementation skipped" comment.
> - **Wave 4 — Mac-mini deployment** (operator-side, after Wave 3): install
>   `~/Library/LaunchAgents/eu.drafto.factory.plist`, run in `--phase A` for
>   ≥5 clean ticks before promoting.
>
> **Smoke test plan (post-Wave-4)**: drag a test card to **Ready**; within
> ≤5 min the agent posts a structured plan as an issue comment, advances the
> card to **Plan Review**, and applies `status:plan-review`. Operator reviews
> ≥5 plan comments before promoting to Phase B.

## Context

The goal is a "vibe-kanban-style" pipeline where moving a card on a board
triggers Claude-driven implementation, automatically deploys to a beta channel,
and waits for explicit human approval before firing production releases.
Backlog stays in GitHub Issues. The drafto Mac mini already runs three
unattended Claude loops (`support-agent` every 5 min, `nightly-support` 00:03,
`nightly-audit` 05:00) with proven patterns: PID locks, atomic state via
`state-cli.mjs`, phase-gated rollout, failure-issue trap. The factory extends
that same skeleton rather than introducing new infra. Cost discipline is
preserved — no new paid services; everything runs on the Mac mini, free
Vercel, free GitHub, free GitHub Actions for the Status→label mirror.

## Decisions locked

1. **UI**: GitHub Projects v2 board (free, native to issues, mobile-app friendly).
2. **Two human gates**: (a) Plan Review → In Progress is the plan-approval
   gate (no code is written until the human reviews the proposed plan and
   drags the card forward — or approves over email if allowlisted), and
   (b) In Test → Approved is the merge + ship gate. Both are reachable via
   the kanban for anyone, and via email for allowlisted reporters.
3. **Concurrency**: up to **2 parallel worktrees** for `--implement`
   (slot-based locking). `--plan`, `--watch`, `--release` are I/O-bound and
   share single locks.
4. **Rollout**: phased A → B → C → D (plan-only → web implementation →
   mobile/desktop work allowed → mobile beta auto-dispatch).

## Architecture overview

```
GitHub Projects v2 board
       |
       | (drag card -> Status field changes; no webhook needed)
       v
Mac-mini launchd  →  scripts/factory-agent.sh  (every 5 min)
       |  modes: --plan / --implement / --release / --watch
       |
       +-- scripts/lib/factory-project.mjs queries Project v2 via GraphQL
       |   for items matching the mode's target Status (Ready, In Progress,
       |   In Test, etc.) — replaces the role originally assigned to
       |   factory-status-mirror.yml, which was retired before Phase A
       |   landed because user-owned Project v2 boards do not emit
       |   `projects_v2_item` events (org-only per GitHub docs).
       +-- per-issue: build bundle, invoke `claude --dangerously-skip-permissions`
       |   with the appropriate prompt, parse a single-line directive, then
       |   advance Status + apply status:* labels via factory-project.mjs.
       +-- two worktree slots for --implement, PID-locked separately
       +-- state in logs/factory-state.json (atomic via state-cli.mjs)
       +-- phase gate (--phase A|B|C|D) enforced in bash and prompt
       +-- failure trap files factory-failure issue

Labels (`status:*`) are written by the agent as transition side-effects, for
human filtering on the Issues list and for the legacy `nightly-support.sh`
Phase-3 deprecation window — they're observability, not the agent's queue.
```

## State machine (Project v2 Status field)

| Status      | Who sets it                    | Meaning / trigger                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backlog     | human                          | Filed, not yet specced. Human-controlled; factory ignores.                                                                                                                                                                                                                                             |
| Ready       | human                          | Spec complete; factory may **plan** (not implement). Must have all required template sections. Human-controlled — moving a card here is the explicit signal that Claude is allowed to read it and propose an approach.                                                                                 |
| Planning    | factory                        | Claude is reading the issue and writing a plan. No worktree, no code; read-only research only.                                                                                                                                                                                                         |
| Plan Review | factory                        | Plan has been posted as an issue comment; factory has stopped. Waits for human (or allowlisted-reporter email) to approve before any code is written.<br/><br/>The drag from **Plan Review → In Progress** IS the plan-approval signal — same kanban-as-action-surface pattern as Approved.            |
| In Progress | human or factory (allowlisted) | Plan approved; factory has taken a worktree slot and Claude is implementing per the approved plan. Human drags card here from Plan Review, OR an allowlisted reporter sends a "go ahead" reply on the linked support thread (support-agent's accept-signal classifier advances on their behalf).       |
| In Review   | factory                        | PR opened, summary posted, CI running. Claude monitors CI and resolves all comments / failures (loops `/push`-style until green).                                                                                                                                                                      |
| In Test     | factory                        | PR's Vercel preview is deployed and reachable. PR remains open; awaits human approval.<br/><br/>**Allowlisted-reporter exception**: factory auto-advances to Approved (skips this gate) when the issue carries `reporter-allowlisted: true` in its support-agent footer and the migration gate passes. |
| Approved    | human or factory (allowlisted) | Drag card here to authorise prod release. Migration gate enforced.                                                                                                                                                                                                                                     |
| Released    | factory                        | Factory merges PR (Vercel auto-deploys prod) and dispatches iOS / Android / macOS beta workflows (TestFlight, Play internal, Mac TF — all pre-authorised per CLAUDE.md).                                                                                                                               |
| Done        | human or support-agent         | Human drags card here, OR an allowlisted reporter sends an "accept" reply on the linked support thread (support-agent classifies and advances the card on their behalf).                                                                                                                               |
| Blocked     | factory                        | Spec incomplete, retry budget exhausted, parity violation, migration gate, or unrecoverable CI failure.                                                                                                                                                                                                |

Notes:

- **Two human-gated transitions**: (1) Plan Review → In Progress is the
  plan-approval signal (Claude doesn't touch any code until this happens),
  and (2) In Test → Approved is the merge + ship signal. Both can be
  satisfied via email by allowlisted reporters; everyone else uses the board.
- The PR is **not merged** until the human drags the card to **Approved**. The
  Approved transition IS the merge authorisation. This preserves the "human
  merges" decision while letting the kanban column be the action surface.
- **In Test = Vercel preview only.** Mobile/desktop beta builds do not fire
  until Released. This avoids burning TestFlight / Play internal slots on
  every iteration.
- Card cannot enter `Approved` if the linked PR contains files under
  `supabase/migrations/**` and the `migration-approved` label is absent —
  bash-side check, mirrors `check-migration-safety.sh`.
- Mobile/desktop **production app-store** submissions stay outside this flow
  per CLAUDE.md's release-authorisation rule. Released ships beta channels only.

## Phases

| Phase | Behaviour                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | **Plan-only.** `--plan` mode runs (Ready → Planning → Plan Review). Even if you approve a plan and drag the card to In Progress, `--implement` is a no-op. Pure observation of the planning quality before any code is written. |
| B     | Web-only. Plan-and-review proceeds end-to-end: approved plan → Implement → In Review → In Test (Vercel preview). Approved auto-merges PR; mobile/desktop changes auto-blocked at the implementation post-check.                 |
| C     | Web + mobile/desktop changes allowed end-to-end. Approved still merges + Vercel prod only. No mobile/desktop dispatch yet — human kicks beta lanes manually.                                                                    |
| D     | Approved → factory merges PR AND dispatches iOS / Android / macOS beta workflows automatically. macOS prod app-store submission stays manual (CI broken per CLAUDE.md).                                                         |

Promote after ≥5 clean runs without human intervention at the current phase.

## Files to add/modify

### New files

| Path                                             | Role                                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/factory-agent.sh`                       | Bash entrypoint, modeled on `support-agent.sh`. Modes `--plan`, `--implement`, `--release`, `--watch`. Two-slot worktree locking on `--implement` only.                                                                     |
| `scripts/factory-plan-prompt.md`                 | System prompt for `--plan` mode — read-only research, output a structured plan (approach, files-to-touch, risks, parity checklist) as an issue comment, no code.                                                            |
| `scripts/factory-prompt.md`                      | System prompt for `--implement` mode — references the approved plan posted on the issue, parity mandate, phase contract, single-line directive.                                                                             |
| `scripts/lib/factory-bundle.mjs`                 | Builds per-issue context bundle (body, comments, affected platforms, prior PR if retry, screenshots).                                                                                                                       |
| `scripts/lib/factory-project.mjs`                | Project v2 GraphQL reader/writer (Path-A pivot — replaces `factory-status-mirror.yml`). `queryStatusItems(status)`, `setStatus(itemId, status)`, `getStatusFieldMeta(projectId)`.                                           |
| `scripts/lib/worktree-cli.mjs`                   | Headless `git worktree add/remove`. Branch naming `factory/issue-<n>`. Slot-aware.                                                                                                                                          |
| `scripts/lib/dispatch-release.mjs`               | `gh workflow run` wrapper for `beta-release.yml` / `production-release.yml`, polls run status.                                                                                                                              |
| `scripts/lib/factory-state.mjs`                  | Helpers over `state-cli.mjs`: `factory.slots[0\|1]`, `factory.issues[<n>] = {attempts, lastBeta, lastProd}`, `factory.paused`.                                                                                              |
| `scripts/setup-factory-board.sh`                 | One-time Project v2 board provisioning via direct GraphQL (idempotent). **Shipped 2026-05-06 in PR #386.**                                                                                                                  |
| `scripts/setup-factory-labels.sh`                | One-time `gh label create` upsert of the 16 factory labels. **Shipped 2026-05-06 in PR #386.**                                                                                                                              |
| `.github/ISSUE_TEMPLATE/factory-feature.yml`     | Spec contract form (acceptance, platforms, schema?, UI?, out-of-scope). **Shipped 2026-05-06 in PR #386.**                                                                                                                  |
| `docs/adr/0026-dark-factory-pipeline.md`         | ADR — decision, alternatives (vibe-kanban, custom UI), consequences. **Shipped 2026-05-06 in PR #386.**                                                                                                                     |
| `docs/features/dark-factory.md`                  | Operator manual — board URL, label semantics, kill switch, troubleshooting. **Shipped 2026-05-06 in PR #386.**                                                                                                              |
| `docs/operations/factory-runbook.md`             | Phase progression criteria, rollback drills, "what to do when factory misbehaves". **Shipped 2026-05-06 in PR #386.**                                                                                                       |
| `~/Library/LaunchAgents/eu.drafto.factory.plist` | launchd entry, every 5 min, runs `factory-agent.sh --plan --implement --watch --phase <current>` (modes run sequentially under the same parent, each with its own lock). NOT version-controlled (matches existing pattern). |

### Modified files

| Path                                | Change                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lib/state-cli.mjs`         | Add `factory:*` subcommands (slot acquire/release, issue cursor mutate, paused flag).                                                                                                                                                                                                                                                                                                  |
| `CLAUDE.md`                         | New "Dark Factory" section: labels, kill switch, parity-mandate enforcement point, link to runbook. **Shipped 2026-05-06 in PR #386.**                                                                                                                                                                                                                                                 |
| Repo labels (via `gh label create`) | `status:ready`, `status:planning`, `status:plan-review`, `status:in-progress`, `status:in-review`, `status:in-test`, `status:approved`, `status:released`, `status:done`, `status:blocked`, `factory-pause`, `migration-approved`, `factory-failure`, `parity:web-only`, `parity:mobile-only`, `parity:desktop-only`. **Shipped 2026-05-06 in PR #386 via `setup-factory-labels.sh`.** |

## Factory loop — how a single card flows

### Stage 1 — Planning (read-only)

1. **Human** drags issue to **Ready** column on Projects board (Status field flips to "Ready").
2. Mac mini's launchd fires `factory-agent.sh --plan` (≤5 min later).
3. Bash queries Project v2 via `factory-project.mjs` for items with Status = "Ready" linked to issues in `JakubAnderwald/drafto`.
4. Validates spec contract — required template sections present? If not,
   `factory-project.mjs setStatus(itemId, "Blocked")`, label `status:blocked`,
   comment `spec incomplete: missing X`, exit.
5. Sets Status = "Planning" + label `status:planning`. Builds bundle via `factory-bundle.mjs` (issue + comments + platform checkboxes; no PR/worktree context — Stage 1 is read-only).
6. Invokes `claude --dangerously-skip-permissions` with `factory-plan-prompt.md`. Claude has filesystem read access to the repo at `origin/main` HEAD (no worktree, no edits) for grounding the plan in actual code.
7. Claude posts a structured plan as an issue comment: approach, files-to-touch, risks, parity checklist, estimated affected platforms. Outputs single directive line: `issue=<n> action=<planned|blocked> plan-comment=<url>`.
8. Sets Status = "Plan Review" + label `status:plan-review`. **Factory stops on this card** until a human (or allowlisted-reporter email) approves.

### Stage 2 — Implementation (gated by plan approval)

1. **Human** reviews the plan comment and drags card to **In Progress** to
   approve. (Allowlisted reporters can approve via email — see Household
   autopilot section.) The Status field is now "In Progress" — no mirror
   workflow involved; the agent reads it directly on its next tick.
2. Mac mini's next `factory-agent.sh --implement` cycle queries Project v2
   via `factory-project.mjs` for Status = "In Progress" items. Acquires
   slot 0 or 1 (PID lock per slot in `logs/factory.slot{0,1}.pid`). Applies
   `status:in-progress` label as a transition side-effect.
3. `worktree-cli.mjs` creates `worktrees/factory-issue-<n>` from `origin/main`,
   copies gitignored env files per CLAUDE.md (`apps/mobile/.env*`,
   `apps/desktop/.env*`, `apps/mobile/android/local.properties`), runs
   `pnpm install`.
4. `factory-bundle.mjs` rebuilds the bundle, this time including the
   approved plan comment as the primary instruction source.
5. Invokes `claude --dangerously-skip-permissions` with `factory-prompt.md` +
   bundle. Claude implements per the approved plan, runs
   lint/typecheck/tests in the worktree, commits, pushes, opens PR via
   `gh pr create`. Outputs single directive line:
   `issue=<n> action=<implemented|noop|blocked> pr=<url|->`.
6. Bash post-check: parity diff scan AND plan-vs-diff drift check. If "Affected
   platforms" includes mobile but no `apps/mobile/**` files in diff →
   `status:blocked`, comment, stop. If the diff substantially exceeds
   files-to-touch in the approved plan → comment a drift warning but proceed
   (drift is a quality signal, not a hard block).
7. Set `status:in-review`.
8. **`--watch` mode** picks up `status:in-review` issues every cycle and runs a
   `/push`-style loop in the worktree: poll CI, fetch new PR review comments,
   invoke Claude to fix any failures or unresolved comments, re-push. Loop ends
   when CI is green AND no unresolved review comments remain. Retry budget
   bounded by `factory.issues[<n>].attempts`.
9. Once CI is green and Vercel preview is reachable (`gh pr view --json`
   surfaces the preview URL via the Vercel bot comment), `--watch` flips card
   to **In Test** and posts the preview URL on the issue. **PR stays open.**

### Stage 3 — Approval & release

1. **Approval gate** — branches by reporter:
   - **Allowlisted reporter** (`reporter-allowlisted: true` in the support-agent
     footer): `--watch` immediately advances card to **Approved** (provided
     migration gate passes). The reporter's identity-on-file is the implicit
     sign-off; no human drag required. Migration changes still hold for an
     explicit `migration-approved` label.
   - **Anyone else**: card waits in In Test until a human drags it to Approved.
2. `factory-agent.sh --release` runs migration gate (refuses if `supabase/migrations/**`
   files present without `migration-approved` label). On pass:
   - Squash-merges the PR via `gh api` (per CLAUDE.md worktree gotcha — uses the
     API form, not `gh pr merge --delete-branch`).
   - Vercel auto-deploys main → prod.
   - Dispatches `beta-release.yml` (iOS, Android) and runs Mac TF beta lane
     locally on the Mac mini via `dispatch-release.mjs` (Phase D only; in
     Phase C this step is a no-op and the human kicks lanes manually).
   - Comments build numbers + TestFlight / Play internal links on the issue.
   - Card → **Released**.
3. **Done** transition — branches by reporter:
   - **Allowlisted reporter**: can mark Done by replying to any support-agent
     email on the thread with an "accept" signal (e.g. "looks good, ship",
     "done", "thanks", or `[ACCEPT]`). The support-agent classifier (extended
     via the existing `support-agent-prompt.md`) recognises the intent and
     runs `state-cli.mjs factory:done <issue>`, which sets `status:done` and
     closes the issue via `gh`.
   - **Anyone else**: human drags card to Done after all store reviews
     accepted. The existing `comment-released-issues.mjs` hook posts the
     release announcement either way.

## Concurrency model (2 worktree slots)

- `logs/factory.slot0.pid` and `logs/factory.slot1.pid` — separate flock files,
  used by `--implement` only. Plan, watch, and release modes are I/O-bound
  (no worktrees) and run under their own single locks.
- `factory-agent.sh --implement` tries slot 0 first, then slot 1. If both held, exit 0.
- Conflict avoidance: before claiming an issue, check that no other in-flight PR
  touches files in the same top-level package (`apps/web`, `apps/mobile`,
  `apps/desktop`, `packages/shared`, `supabase`). If overlap → defer, try next issue.
- `--plan`, `--release`, and `--watch` modes use separate single locks; never
  contend with implement slots.

## Spec contract for a "Ready" issue

Enforced by `factory-feature.yml` template + bash validation:

1. **What** — one paragraph user-facing description.
2. **Acceptance criteria** — bulleted, testable.
3. **Affected platforms** — checkboxes web/iOS/Android/macOS (drives parity check).
4. **Schema changes?** — yes/no. If yes, factory adds `needs-migration-review`.
5. **UI?** — if yes, screenshot or Figma URL required.
6. **Out of scope** — explicit non-goals.

`parity:web-only` / `parity:mobile-only` / `parity:desktop-only` labels override
the cross-platform parity check for legitimate single-platform work.

## Household autopilot (allowlisted reporters)

For issues filed by `$SUPPORT_ALLOWLIST` reporters (Jakub and his wife), the
factory runs end-to-end with **zero GitHub UI interaction required from the
reporter**. The three transitions that need human input — Plan approval, Ship
approval, and Done — are all reachable via email.

Trigger: every issue filed by support-agent carries a footer block
(`<!-- drafto-progress -->` HTML comment) with `zoho-thread-id`,
`reporter-email`, and `reporter-allowlisted: true|false` flags. The factory
reads the flag and changes behaviour accordingly.

Lifecycle for an allowlisted bug report:

| Stage             | Triggered by                                                                                        | Customer-visible action                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Intake            | Email to `support@drafto.eu`                                                                        | "Got your report, filed as #N" auto-reply (existing Phase E behaviour). support-agent applies `status:ready`. |
| Plan posted       | factory `--plan` runs within 5 min; Claude reads the issue and posts a structured plan as a comment | Plan forwarded as Zoho reply: "Here's how I'd approach this: …". Card → Plan Review.                          |
| **Plan approval** | Reporter replies with positive intent ("go ahead", "looks good", `[GO]`)                            | (Optional) "Starting work" comment forwarded back. Card → In Progress; factory `--implement` picks up.        |
| Test deploy       | Vercel preview ready                                                                                | Preview URL forwarded as Zoho reply.                                                                          |
| **Auto-approve**  | factory `--watch` checks `reporter-allowlisted: true` + migration gate; advances to Approved        | (Optional) "Shipping…" comment forwarded as Zoho reply.                                                       |
| Release           | factory `--release` merges, dispatches mobile/desktop beta lanes, card → Released                   | "Your fix is in TestFlight build X / Play internal track Y" forwarded as Zoho reply.                          |
| Live notice       | After store-review acceptance, fastlane post-hook fires `comment-released-issues.mjs`               | "Your fix is now live in version X.Y.Z" forwarded as Zoho reply.                                              |
| **Email-Done**    | Reporter replies to any progress email with an accept signal (e.g. "thanks", "ship it", `[ACCEPT]`) | Card → Done, issue closed; existing `--state-sync` sends the closure-confirmation email.                      |

Implementation:

- **Plan-only (no auto-approve)**: even for allowlisted reporters, the factory
  always stops at Plan Review. Plan approval is the one autopilot stage that
  always requires the reporter's positive signal — it's the early-stage
  misinterpretation catcher and must not be skipped.
- **Auto-approve at In Test**: `factory-agent.sh --watch` parses the issue body
  footer with `grep -oP 'reporter-allowlisted:\s*\K\w+'`. On `true` and the
  migration gate passes, sets `status:approved` directly instead of stopping at
  In Test.
- **Accept-signal classifier**: `scripts/support-agent-prompt.md` gains a new
  output value, `action=accept-signal issue=<n>`. The classifier recognises
  short positive replies on threads linked to a GitHub issue. The bash wrapper
  in `support-agent.sh` reads the issue's current `status:*` label and
  dispatches via `state-cli.mjs factory:advance <n>`, which translates the
  signal differently per state:
  - `status:plan-review` → set `status:in-progress` (plan approved, factory will pick up next `--implement` cycle).
  - `status:released` → set `status:done` and `gh issue close <n> --reason completed`.
  - any other state → ignore (post the reply as a normal comment).
- **Safety checks**: accept-signal only triggers state transitions when (a) the
  reporter email is allowlisted, (b) the issue is in one of the two
  transitionable states above, and (c) the reply email's `From` matches
  `reporter-email` from the footer (no impersonation via cc/bcc).
- **Rejection / iteration path**: if the reporter replies with rejection or a
  new direction ("plan looks wrong, do X instead", "preview is broken, still
  fails on Y"), support-agent posts the reply as a comment as today; factory
  picks up the new comment on its next cycle and either re-plans (in Plan
  Review state) or iterates the PR (in In Review/In Test states).
- **Phase gate**: household autopilot is enabled at Phase B+ (i.e. as soon as
  the factory does real work). At Phase A `--plan` runs and emails the plan,
  but plan-approval drag does nothing because `--implement` is a no-op.

## Cross-platform parity enforcement (CLAUDE.md mandate)

Two layers:

1. **Prompt instruction**: Claude self-reports a parity checklist in the PR
   description before pushing.
2. **Bash post-check** in `factory-agent.sh`: `gh pr diff --name-only` vs
   "Affected platforms" checkboxes. Any claimed-but-missing platform → `status:blocked`.

## Kill switches

- Per-card: drag to **Blocked** column → `status:blocked` label → factory ignores it.
- Global: `state-cli.mjs factory:pause` sets `factory.paused=true` in state file. Agent reads on every cycle and exits early when set. `factory:resume` to unpause.
- Emergency stop: remove the launchd plist (`launchctl unload …`) or `kill` the active claude PID.

## Implementation waves

### Wave 1 — Foundations (all parallel, no dependencies) — **shipped 2026-05-06 (PRs #386, #388)**

- ✅ Create labels via `gh label create` (one-shot script — `setup-factory-labels.sh`).
- ✅ Write `factory-feature.yml` issue template.
- ✅ Write `factory-status-mirror.yml` GitHub Action — **retired before Phase A landed** (Path-A pivot — see status note at top). Removed in the same PR as this status update.
- ✅ Write ADR-0026, `dark-factory.md`, `factory-runbook.md`.
- ✅ `setup-factory-board.sh` provisions the Project v2 board (uses direct GraphQL throughout — runs in environments where the `gh project` CLI's extra `read:org` scope isn't available).
- ✅ Update `CLAUDE.md` with the Dark Factory section.

### Wave 2 — Core libraries (parallel) — pending

- `scripts/lib/factory-project.mjs` (Project v2 GraphQL reader/writer — Path-A; new since the original proposal).
- `scripts/lib/worktree-cli.mjs` (Phase B+; not needed for Phase A).
- `scripts/lib/factory-bundle.mjs`
- `scripts/lib/dispatch-release.mjs` (Phase D; not needed for Phase A).
- `scripts/lib/factory-state.mjs` (extends `state-cli.mjs`)

### Wave 3 — The agent (depends on Wave 2)

- `scripts/factory-prompt.md` (write before agent — bash heredocs reference it).
- `scripts/factory-agent.sh` with all three modes.
- Unit tests: dry-run against a fake issue in dev environment.

### Wave 4 — Schedule & promote

- Install launchd plist on Mac mini (manual; matches existing pattern).
- Run in `--phase A` for ≥1 week / ≥5 successful dry-runs.
- Promote to B (web only), then C (mobile beta), then D (prod) gated by stable runs.

## Verification

End-to-end test before promoting past Phase A:

1. File a trivial test issue (`feat: add timestamp to footer`), drag to **Ready**.
2. Watch Mac mini logs (`tail -f logs/factory-*.log`) for the next 5-min poll.
3. Confirm `--plan` runs: card moves Ready → Planning → Plan Review, plan
   comment is posted, factory stops.
4. Drag card to **In Progress**. In Phase A, confirm `--implement` is a no-op
   (factory comments "phase=A; implementation skipped"). Drag card to Blocked
   → confirm factory leaves it alone.
5. Once promoted to Phase B: file a real web-only issue, drag to Ready.
   Confirm `--plan` posts a plan; review and drag to In Progress. Confirm: PR
   opens (status:in-review), CI runs to green via `--watch` loop (any failures
   auto-resolved by Claude), Vercel preview comment lands, card auto-advances
   to **In Test**, preview URL is posted on the issue.
6. Drag card to Approved → confirm factory squash-merges via `gh api`, Vercel
   prod deploys main, card → Released. Verify no mobile/desktop dispatch fired
   (Phase B scope).
7. For Phase C: same drill with a mobile issue. PR includes mobile changes; In
   Test still ends at Vercel preview only (mobile beta is human-fired manually).
8. For Phase D: same drill, but Approved now also dispatches iOS+Android beta
   workflows and the local Mac TF lane. Confirm TestFlight + Play internal
   builds appear; card → Released; you mark Done after store-review acceptance.
9. **Household autopilot drill** (Phase B+): email a real bug from an
   allowlisted address. Confirm: issue filed with `reporter-allowlisted: true`
   footer, factory `--plan` runs and forwards the plan as a Zoho reply.
   Reply "go ahead" → confirm card moves to In Progress and factory begins
   implementation (no GitHub UI used). Confirm preview URL email arrives,
   card auto-advances to Approved without manual drag, factory merges and
   (Phase D) dispatches beta. Reply "ship it" to the final email → confirm
   card lands in Done and issue is closed.
10. **Migration safety drill**: file an allowlisted issue that touches
    `supabase/migrations/**`. Confirm auto-approve is held back; card stays in
    In Test until the `migration-approved` label is applied manually.

Manual checks per phase promotion:

- `pnpm lint && pnpm typecheck && pnpm test` (run on the factory's PR before merge).
- `pnpm migration:check` if any migration files touched.
- SonarCloud quality gate green on factory PRs (existing pre-push checklist).

## Documentation deliverables

- ADR-0026 records the decision.
- `docs/features/dark-factory.md` is the operator manual (board URL after
  setup, label glossary, troubleshooting).
- `docs/operations/factory-runbook.md` covers phase promotion criteria, kill
  switch, rollback drill, on-call response when `factory-failure` issue appears.
- CLAUDE.md gets a one-paragraph Dark Factory section pointing to the above.

## Coexistence with existing support / nightly scripts

The factory does not replace the support pipeline; it integrates with it.

| Existing job                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `support-agent.sh` (every 5 min)                            | Real-time email→issue role unchanged. Two new behaviours:<br/>1. **Auto-Ready for allowlisted**: when filing from an allowlisted reporter (per `$SUPPORT_ALLOWLIST` in `logs/support-state.json` — Jakub and his wife), auto-applies `status:ready` and adds the issue to the Projects v2 board. Non-allowlisted reports land in Backlog as today.<br/>2. **Accept-signal classifier**: when an allowlisted reporter replies on a thread linked to a factory issue with positive intent ("go ahead", "ship it", "thanks"), support-agent runs `state-cli.mjs factory:advance <issue>`. The script reads the issue's current `status:*` label and dispatches: Plan Review → In Progress (plan approved), Released → Done (final acceptance). Other states ignore the signal and post the reply as a normal comment. |
| `nightly-support.sh` Phase 2 (Dependabot)                   | Unchanged. Dependabot PRs aren't feature work; kanban abstraction doesn't fit. Existing conditional auto-merge stays.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `nightly-support.sh` Phase 3 (support-issue implementation) | **Deprecated in stages.** Factory phase A/B: Phase 3 keeps running; factory only touches `status:ready` issues set by a human. Factory phase C cutover: Phase 3 disabled — factory handles all support-issue implementation; allowlisted reporters auto-promoted to Ready by support-agent. Factory phase D: Phase 3 code removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `nightly-audit.sh` (05:00)                                  | Adds a check: factory launchd job alive AND `factory.paused != true` in state file. Otherwise files a `nightly-audit` issue as today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `comment-released-issues.mjs` (post-fastlane hook)          | Unchanged. Already posts release announcements on linked support issues — works for factory-released issues without modification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Net effect for the household reporters: end-to-end via email. Email a bug to
support@drafto.eu → receive a plan email → reply "go ahead" → receive progress
emails (preview ready → TestFlight build X → live in version Y) → reply
"thanks" to the final email. The reporter touches email twice (plan approval +
done acknowledgement) and never opens GitHub. The kanban exists for visibility
and for non-allowlisted reports.

## Out of scope (explicit non-goals for v1)

- Custom kanban UI in `apps/web` (Projects v2 covers it).
- vibe-kanban integration (rejected — splits state across two systems).
- Cross-repo orchestration (drafto is single-repo today).
- **Mobile / desktop production app-store submissions** — Released ships beta
  channels only (TestFlight, Play internal, Mac TF). Production store releases
  remain a separate manual step per CLAUDE.md's release-authorisation rule.
- Desktop production release CI dispatch (broken per CLAUDE.md; even at Phase D,
  Mac TF beta runs as a local lane on the Mac mini, not via GitHub Actions).
- Auto-merge before Approved — for non-allowlisted issues the merge still
  happens only at the explicit human Approved drag. (Allowlisted reports
  reach Approved automatically; the migration gate remains the hard stop in
  that path.)
- Email-driven Done for non-allowlisted reporters — only allowlisted senders
  can advance state via email, to avoid letting random support correspondents
  fast-track production.
