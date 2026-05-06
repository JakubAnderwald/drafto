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

4. **Create a PAT for the mirror workflow.**
   - GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
   - Resource owner: `JakubAnderwald` (your user). Repository access: only `JakubAnderwald/drafto`.
   - Permissions:
     - **Repository → Issues**: Read and write.
     - **Repository → Metadata**: Read-only (auto-set).
     - **Account → Projects**: Read-only.
   - Expiration: 90 days (set a calendar reminder to rotate; rotation is in this runbook).

5. **Add the PAT to repo secrets.**
   - Repo → Settings → Secrets and variables → Actions → New repository secret.
   - Name: `FACTORY_PROJECT_TOKEN`.
   - Value: the PAT from step 4.

6. **Smoke test the mirror.**
   - File any issue. Add it to the board. Drag the card to **Ready**.
   - Within ~30 s, the issue should gain `status:ready`. Confirm via Actions tab → "Factory Status Mirror" → most recent run.
   - If it doesn't, see "Mirror workflow failing" below.

7. **Install the factory launchd job.** (Wave 4 — does not apply at Phase A until the agent code lands.)

## Phase progression criteria

| Promote from → to | Required signals before promotion                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (initial) → A     | Setup steps 1–6 above complete. `factory-status-mirror.yml` mirrors a manual board move within 30 s.                                                                                                                                                                                                                                                                                                |
| A → B             | ≥5 successful `--plan` runs (Ready → Planning → Plan Review with a usable plan comment). Zero `factory-failure` issues. Operator has read at least 3 plans and judges they were accurate enough to act on. `--implement` no-op confirmed: dragging Plan Review → In Progress in Phase A logs a "phase=A; implementation skipped" comment and leaves the card in In Progress without further action. |
| B → C             | ≥5 successful end-to-end web-only runs (Ready → Plan Review → In Progress → In Review → In Test → Approved → Released → Done). Zero parity violations. SonarCloud quality gate green on all factory-authored PRs.                                                                                                                                                                                   |
| C → D             | ≥5 successful runs that include mobile or desktop changes. Operator manually fired beta dispatches (TestFlight, Play internal) per Phase C — confirms the dispatch payloads work before the factory automates them.                                                                                                                                                                                 |
| D → (steady)      | ≥10 successful Released cards in Phase D. Beta dispatch path validated for both iOS and Android. Mac TestFlight lane runs locally on the Mac mini per the existing release pattern.                                                                                                                                                                                                                 |

Promote by editing the launchd plist's `--phase` argument and reloading:

```bash
launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist
# edit plist, change --phase A → --phase B (or B → C, etc.)
launchctl load ~/Library/LaunchAgents/eu.drafto.factory.plist
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

## PAT rotation

The `FACTORY_PROJECT_TOKEN` PAT expires every 90 days (per setup step 4). When it expires, the mirror workflow fails — board moves stop translating to labels and the factory queue silently empties.

To rotate:

1. Generate a new fine-grained PAT with the same scopes as setup step 4.
2. Update the `FACTORY_PROJECT_TOKEN` secret value in repo settings.
3. Smoke-test by dragging a Backlog card to Ready and back; the workflow should run twice and the labels should toggle.
4. Set a new 90-day calendar reminder.

The launchd plist on the Mac mini does **not** use this PAT — `gh` on the Mac mini authenticates separately via `gh auth login`. Don't confuse the two.

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
