# Factory runbook

Operational guide for the dark factory pipeline. For the user-facing description of what the factory does, see [`docs/features/dark-factory.md`](../features/dark-factory.md). For the architectural decision, see [ADR-0026](../adr/0026-dark-factory-pipeline.md).

## Initial setup (one-time)

Run these in order, on a workstation with `gh` authenticated as the project owner.

1. **Bootstrap labels.**

   ```bash
   scripts/setup-factory-labels.sh
   ```

   Idempotent. Re-running upserts colour + description on existing labels.

2. **Bootstrap the Project v2 board.**

   ```bash
   gh auth refresh -s project,read:project   # if you haven't yet
   scripts/setup-factory-board.sh
   ```

   Prints the board URL on success — paste it into `docs/features/dark-factory.md` ("The board" section).

3. **Link the repo to the project.**

   ```bash
   gh project link <number> --owner JakubAnderwald --repo JakubAnderwald/drafto
   ```

   Without this, issues filed in the repo don't auto-add to the board.

4. **Grant `gh` the `project` scope on the Mac mini.**

   The agent reads and writes the Project v2 board directly via the GitHub GraphQL API — there is no Action mirror. Refresh the existing token on the Mac mini to add Projects v2 read+write:

   ```bash
   gh auth refresh -s project
   ```

   Verify with `gh auth status` — the listed scopes should include `project`. Without it the agent's first board read fails on every tick with a `factory-project find-project failed` warning.

5. **Install the factory launchd job.**

   On the Mac mini, drop a plist at `~/Library/LaunchAgents/eu.drafto.factory.plist` modelled on `eu.drafto.support-agent.plist` with:
   - `Label = eu.drafto.factory`
   - `ProgramArguments = [/bin/bash, /Users/jakub/code/drafto/scripts/factory-agent-loop.sh]`
   - `StartInterval = 300` (5 min)
   - `EnvironmentVariables.FACTORY_PHASE = A`
   - Stdout/stderr paths under `logs/launchd-factory-*.log`

   Then load and smoke-test:

   ```bash
   launchctl load -w ~/Library/LaunchAgents/eu.drafto.factory.plist
   launchctl kickstart -k "gui/$(id -u)/eu.drafto.factory"
   tail -f /Users/jakub/code/drafto/logs/launchd-factory-stdout.log
   ```

   The first tick should log `=== factory-agent --plan run started (phase=A …) ===` followed by `=== factory-agent --plan completed in <N>s ===`. Subsequent ticks fire every 5 min.

## Phase progression criteria

| Promote from → to | Required signals before promotion                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (initial) → A     | Setup steps 1–5 above complete. `launchctl list \| grep eu.drafto.factory` shows the job registered, and a manual `launchctl kickstart` logs a clean `--plan` tick (board fetched, no `factory-failure` issue filed).                                                                                                                                                                               |
| A → B             | ≥5 successful `--plan` runs (Ready → Planning → Plan Review with a usable plan comment). Zero `factory-failure` issues. Operator has read at least 3 plans and judges they were accurate enough to act on. `--implement` no-op confirmed: dragging Plan Review → In Progress in Phase A logs a "phase=A; implementation skipped" comment and leaves the card in In Progress without further action. |
| B → C             | ≥5 successful end-to-end web-only runs (Ready → Plan Review → In Progress → In Review → In Test → Approved → Released → Done). Zero parity violations. SonarCloud quality gate green on all factory-authored PRs.                                                                                                                                                                                   |
| C → D             | ≥5 successful runs that include mobile or desktop changes. Operator manually fired beta dispatches (TestFlight, Play internal) per Phase C — confirms the dispatch payloads work before the factory automates them.                                                                                                                                                                                 |
| D → (steady)      | ≥10 successful Released cards in Phase D. Beta dispatch path validated for both iOS and Android. Mac TestFlight lane runs locally on the Mac mini per the existing release pattern.                                                                                                                                                                                                                 |

Promote by editing the `FACTORY_PHASE` env var in the launchd plist and reloading:

```bash
launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist
# edit plist: EnvironmentVariables → FACTORY_PHASE: A → B (or B → C, etc.)
launchctl load -w ~/Library/LaunchAgents/eu.drafto.factory.plist
```

There is no "auto-promote". The phase change is always a deliberate operator action so a regression at one phase can't silently unlock the next.

## Kill switches

| Severity                     | Action                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One bad card                 | Drag to **Blocked**, or apply `factory-pause` to the issue. Factory skips it next tick.                                                                                                                                                |
| Stop all factory work        | `node scripts/lib/state-cli.mjs factory:pause` (Wave 2+). Resume with `factory:resume`.                                                                                                                                                |
| Stop the launchd job         | `launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist`. Reload to resume.                                                                                                                                                   |
| Active Claude session hangs  | Find the PID in `logs/factory.slot{0,1}.pid` (or `logs/factory.plan.pid`), `kill -TERM <pid>`. The wall-time wrapper (`run-claude.mjs`) caps each invocation at `CLAUDE_CALL_TIMEOUT_SEC` (default 180 s) so this is rare in practice. |
| Stuck PR with a wrong commit | `gh pr close <n> --delete-branch`. Drag the card back to Ready. Factory will re-plan on the next tick.                                                                                                                                 |

## Rollback drills

The factory's blast radius is bounded by:

1. **Pre-merge.** Worst case, a PR is opened with bad code. Closing the PR (and removing its `factory/issue-<n>` branch) reverts to zero side effects.
2. **Post-merge but pre-release.** Vercel auto-deploys main → prod on merge. If the factory merged something bad, follow the standard web rollback: `vercel rollback <previous-deployment-id>` from the Vercel dashboard. The web app is back in <60 s.
3. **Post-merge and post-beta-dispatch (Phase D only).** TestFlight / Play internal builds are pre-authorised and reversible — the next build supersedes the bad one. No store-public users are affected (production app-store submissions stay manual; see CLAUDE.md "Release Authorization").
4. **Schema migration.** The migration gate refuses to merge a PR with `supabase/migrations/**` files unless `migration-approved` is on the PR. If a bad migration _did_ land, follow [`docs/operations/migrations.md`](./migrations.md) → "Rolling back a migration".

Practice drill (do once per month while the factory is active):

- File a trivial test issue ("test: bump footer copyright year"), drag through to Released.
- Verify Vercel rollback works for that exact commit before declaring the drill green.

## On-call response — `factory-failure` issue appears

The factory's `cleanup()` trap files a `factory-failure`-labelled GitHub issue when a run errors out. `nightly-audit.sh` will surface these in its 05:00 sweep. When you see one:

1. **Read the issue body.** Sanitised log tail is included (timestamps only — no bundle PII, same regex pattern as `support-agent.sh`).
2. **Check `logs/factory-*.log` on the Mac mini** for the full context.
3. **Common causes** (in approximate order of frequency):
   - Network blip during `gh` call (transient — usually resolves on the next tick).
   - Worktree slot leaked (a previous run died without releasing its lock). Inspect `logs/factory.slot{0,1}.pid`; if the PID is dead, `rm` the lock.
   - Disk full under `worktrees/` — clean up via `git worktree prune`.
   - Claude wall-time cap hit on every retry (the prompt or context bundle is too large). Inspect the bundle in the log; truncate prior PR threads if needed.
4. **Close the failure issue** once resolved. The trap doesn't auto-close; that's intentional so the issue is visible until acknowledged.

If the same failure mode files >3 issues in 24h, pause the factory globally (`factory:pause`) and open a regular bug to fix the root cause.

## Coexistence with `nightly-support.sh` Phase 3

Phase 3 (existing midnight implementation pass) and the factory's `--implement` mode operate on overlapping issue sets. The deprecation schedule is:

| Factory phase | Phase 3 status                                                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A             | Phase 3 keeps running. Factory only `--plan`s; no overlap.                                                                                                                                                                                                                   |
| B             | Phase 3 keeps running. Factory `--implement`s only `status:ready` cards set by humans; Phase 3 still picks up `support`-labelled issues without `status:*`. Operator monitors logs to ensure they don't both pick up the same issue (label set is disjoint by construction). |
| C             | Phase 3 disabled at cutover. Factory takes over support-issue implementation.                                                                                                                                                                                                |
| D             | Phase 3 code removed.                                                                                                                                                                                                                                                        |

If both the factory and Phase 3 ever try to implement the same issue (a misconfiguration), the factory takes priority — its worktree-slot lock will block Phase 3's attempt. Both will log; Phase 3's log will say "issue #N already has a factory worktree".

## Related

- [`docs/features/dark-factory.md`](../features/dark-factory.md) — operator manual.
- [ADR-0026](../adr/0026-dark-factory-pipeline.md) — decision record.
- [`docs/operations/migrations.md`](./migrations.md) — migration safety + rollback workflow.
- [`docs/operations/builds-and-releases.md`](./builds-and-releases.md) — release commands, beta lanes.
