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

5. **Create the dedicated factory checkout (Deployment).**

   The factory runs from its **own git worktree pinned to `main`**, never from your
   everyday dev checkout. This guarantees it only ever executes reviewed,
   CI-gated code, and keeps its tick-start `git reset --hard` from ever touching
   uncommitted work in your dev tree. (History: the factory once ran straight
   from a feature branch in the dev checkout and shipped an unmerged `--release`
   crash to production — the dedicated tree exists to make that impossible.)

   Create it once as a **detached** worktree at `origin/main` (detached so it
   doesn't collide with `main` being checked out in the primary repo):

   ```bash
   cd /Users/jakub/code/drafto
   git fetch origin main
   git worktree add --detach /Users/jakub/code/drafto-factory origin/main
   cd /Users/jakub/code/drafto-factory
   pnpm install                       # worktrees don't share node_modules
   bash scripts/worktree-bootstrap.sh # gitignored env/config files
   ```

   Each tick, `factory-agent-loop.sh` runs `git fetch origin main` +
   `git reset --hard origin/main` before the agent modes (guarded by
   `FACTORY_AUTOPULL=1`, the default), so a merged PR — or a revert — goes live
   on the next 5-min cycle with no manual pull. If the wrapper itself changed in
   that sync, it re-execs the fresh copy once. Set `FACTORY_AUTOPULL=0` only for
   ad-hoc manual runs against a dirty tree.

6. **Install the factory launchd job.**

   On the Mac mini, drop a plist at `~/Library/LaunchAgents/eu.drafto.factory.plist` modelled on `eu.drafto.support-agent.plist` with:
   - `Label = eu.drafto.factory`
   - `ProgramArguments = [/bin/bash, /Users/jakub/code/drafto-factory/scripts/factory-agent-loop.sh]` (the **dedicated** checkout from step 5, not the dev tree)
   - `StartInterval = 300` (5 min)
   - `EnvironmentVariables.FACTORY_PHASE = A`
   - Stdout/stderr paths under `logs/launchd-factory-*.log`

   Then load and smoke-test:

   ```bash
   launchctl load -w ~/Library/LaunchAgents/eu.drafto.factory.plist
   launchctl kickstart -k "gui/$(id -u)/eu.drafto.factory"
   tail -f /Users/jakub/code/drafto/logs/launchd-factory-stdout.log
   ```

   The first tick should log `self-update: synced to origin/main @ <sha>` then
   `=== factory-agent --plan run started (phase=A …) ===` followed by
   `=== factory-agent --plan completed in <N>s ===`. Subsequent ticks fire every 5 min.

## Phase progression criteria

| Promote from → to | Required signals before promotion                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (initial) → A     | Setup steps 1–6 above complete. `launchctl list \| grep eu.drafto.factory` shows the job registered, and a manual `launchctl kickstart` logs a clean `--plan` tick (board fetched, no `factory-failure` issue filed).                                                                                                                                                                               |
| A → B             | ≥5 successful `--plan` runs (Ready → Planning → Plan Review with a usable plan comment). Zero `factory-failure` issues. Operator has read at least 3 plans and judges they were accurate enough to act on. `--implement` no-op confirmed: dragging Plan Review → In Progress in Phase A logs a "phase=A; implementation skipped" comment and leaves the card in In Progress without further action. |
| B → C             | ≥5 successful end-to-end web-only runs (Ready → Plan Review → In Progress → In Review → In Test → **auto-merged + Released** after the operator drags to Approved), each with green CI, a reachable Vercel preview, and zero parity violations. SonarCloud quality gate green on all factory-authored PRs.                                                                                          |
| C → D             | ≥5 successful runs that include mobile or desktop changes. Operator manually fired beta dispatches (TestFlight, Play internal) per Phase C — confirms the dispatch payloads work before the factory automates them.                                                                                                                                                                                 |
| D → (steady)      | ≥10 successful Released cards in Phase D. Beta dispatch path validated for both iOS and Android. Mac TestFlight lane runs locally on the Mac mini per the existing release pattern.                                                                                                                                                                                                                 |

Promote by editing the `FACTORY_PHASE` env var in the launchd plist and reloading:

```bash
launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist
# edit plist: EnvironmentVariables → FACTORY_PHASE: A → B (or B → C, etc.)
launchctl load -w ~/Library/LaunchAgents/eu.drafto.factory.plist
```

There is no "auto-promote". The phase change is always a deliberate operator action so a regression at one phase can't silently unlock the next.

**`--release` runs at Phase B+.** The A→B→C→D phases control implementation _scope_ (web → web+mobile/desktop → beta dispatch); `--release` is the merge step layered on top. Each tick it scans the **Approved** column and, for a card a human dragged there, squash-merges the green PR via the GitHub API (`gh api --method PUT …/merge -f merge_method=squash`) and advances it to **Released** (Vercel auto-deploys main → prod for web). It is bounded by three hard rules:

1. It only ever acts on a card a human (or an allowlisted reporter) moved to **Approved** — the Approved drag _is_ the merge-authorisation gate (ADR-0026); the factory never moves a card to Approved itself.
2. It refuses to merge a PR touching `supabase/migrations/**` until `migration-approved` is on the PR — it leaves the card in Approved and comments once (`<!-- drafto-factory-migration-gate -->`).
3. It won't merge unless CI is green and the branch is conflict-free; otherwise it leaves the card in Approved for you (a transient merge error is retried next tick, comment `<!-- drafto-factory-merge-failed -->`).

Right before merging it **resolves any outstanding review threads** (CodeRabbit / reviewers) via GraphQL — the owner-token merge would otherwise bypass `required_conversation_resolution` silently, so this turns it into an explicit, audited action at the Approved gate (the `--watch` fix loop has already addressed CI-failing feedback; remaining threads are accepted when you drag to Approved). The count cleared is noted on the `<!-- drafto-factory-released -->` comment.

It is idempotent (an already-merged PR just finishes the Released transition + slot/worktree teardown) and honours `factory-pause`. `factory:pause` stops `--release` along with every other mode.

**Phase-D beta dispatch.** At **Phase D only**, after a Released merge that touched a native platform, `--release` auto-dispatches beta builds via `scripts/lib/dispatch-release.mjs`: it derives the changed platforms from the diff (`apps/mobile/`→mobile, `apps/desktop/`→desktop, `packages/shared/`→both; `apps/web/` deploys via Vercel, no dispatch) and spawns the **local Fastlane lanes** on the Mac mini — `pnpm release:beta:all` (iOS TestFlight + Android internal) and/or `cd apps/desktop && pnpm release:beta` (macOS TestFlight). It uses the local lanes, **not** `gh workflow run`, because the CI release workflows are non-functional (see [builds-and-releases.md](./builds-and-releases.md)). Lanes are spawned detached (fire-and-forget; the Fastlane post-hook `comment-released-issues.mjs` posts the "now live" notice). Production store lanes are never invoked (`assertBetaOnly` denylist). The step is dormant at Phase B/C and marker-guarded (`<!-- drafto-factory-beta-dispatched -->`) so a re-tick can't re-trigger a build.

> **Phase-D prerequisites (operator):** the Mac-mini factory launchd env must carry the Fastlane secrets the lanes need (`MATCH_PASSWORD`, ASC API key, Android keystore + `google-play-service-account.json`), and the `$REPO_ROOT` main checkout must be clean enough to fast-forward (the engine best-effort `git merge --ff-only origin/main` before building so the lanes build the merged code). Validate both at the **C → D manual dispatch step** before promoting. Concurrency caveat: two simultaneous native releases would run overlapping lanes (version/tag contention) — rare at the factory's 1–2-slot cadence, but kick lanes by hand if it occurs.

## Kill switches

| Severity                     | Action                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One bad card                 | Drag to **Blocked**, or apply `factory-pause` to the issue. Factory skips it next tick.                                                                                                                                                                                                                                                                                           |
| Stop all factory work        | `node scripts/lib/state-cli.mjs factory:pause` (Wave 2+). Resume with `factory:resume`.                                                                                                                                                                                                                                                                                           |
| Stop the launchd job         | `launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist`. Reload to resume.                                                                                                                                                                                                                                                                                              |
| Active Claude session hangs  | `node scripts/lib/state-cli.mjs factory:slot-status` shows the PID + issue for each implement/watch slot; `kill -TERM <pid>`. The wall-time wrapper (`run-claude.mjs`) caps each invocation (180 s for `--plan`, `FACTORY_IMPLEMENT_TIMEOUT_SEC`/`FACTORY_WATCH_TIMEOUT_SEC` for the engines — default 1800/900 s) so a true hang is rare.                                        |
| Worktree install hangs       | Each `pnpm install` is wrapped by `run-with-timeout.mjs` and capped at `FACTORY_INSTALL_TIMEOUT_SEC` (default 600 s); on cap, `--implement` releases the slot + worktree and bumps the card's attempt budget, while `--watch` logs a warning and proceeds. A cold install should take seconds (clonefile seed + offline reconcile), not minutes — see "Worktree installs & disk". |
| Stuck PR with a wrong commit | `gh pr close <n> --delete-branch`. Drag the card back to Ready. Factory will re-plan on the next tick.                                                                                                                                                                                                                                                                            |
| Plan needs a single tweak    | Comment on the issue with the correction; on the next tick the factory edits the existing plan comment in place (preserves the rest, stamps `<!-- drafto-factory-replan-ack:<id> -->` so the same comment doesn't loop). Drag back to Ready only if you want a full restart. See `docs/features/dark-factory.md` → "The plan comment looks wrong".                                |

## Rollback drills

The factory's blast radius is bounded by:

1. **Pre-merge.** Worst case, a PR is opened with bad code. Closing the PR (and removing its `factory/issue-<n>` branch) reverts to zero side effects. For a salvageable PR sitting in In Test, prefer the **In Test iteration loop** — comment the change you want and the factory revises the same PR in place — over closing and re-filing.
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
   - Worktree slot leaked (a previous run died without releasing it). `node scripts/lib/state-cli.mjs factory:slot-status` shows each slot's PID + issue; if the PID is dead, `node scripts/lib/state-cli.mjs factory:slot-release <slot>` then `node scripts/lib/worktree-cli.mjs remove --issue <n> --force`. (`--watch`'s cleanup sweep also auto-releases slots whose issue has left the active In Progress/In Review/In Test states — e.g. merged, Blocked, or closed.)
   - Disk full under `worktrees/` — the factory now refuses to start an implement when free space is below `FACTORY_MIN_FREE_DISK_GB` (it parks the card in Blocked with a `disk-low` comment), so a mid-build ENOSPC should be rare. Reclaim space via `git worktree prune` (and `node scripts/lib/worktree-cli.mjs list` to see the factory's worktrees); see "Worktree installs & disk" for the full reclamation runbook.
   - Claude wall-time cap hit on every retry (the prompt or context bundle is too large). Inspect the bundle in the log; truncate prior PR threads if needed.
4. **Close the failure issue** once resolved. The trap doesn't auto-close; that's intentional so the issue is visible until acknowledged.

If the same failure mode files >3 issues in 24h, pause the factory globally (`factory:pause`) and open a regular bug to fix the root cause.

## Coexistence with `nightly-support.sh` Phase 3

Phase 3 (existing midnight implementation pass) and the factory's `--implement` mode could operate on overlapping issue sets. **Revised 2026-06-21: Phase 3 is no longer deprecated** — it stays running unchanged across all factory phases, and the factory is kept off its queue by a factory-side guard. The coexistence model is:

| Factory phase | Phase 3 status                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A             | Phase 3 keeps running. Factory only `--plan`s; no overlap.                                                                                                                                     |
| B             | Phase 3 keeps running. Factory `--implement`s only `status:ready` cards set by humans; Phase 3 still picks up `support`-labelled issues without `status:*`.                                    |
| C             | Phase 3 keeps running, **unchanged (no cutover)**. The factory may now implement mobile/desktop, but its `--implement` queue skips `support`-labelled issues, so the two tracks stay disjoint. |
| D             | Phase 3 keeps running, **unchanged (not removed)**.                                                                                                                                            |

Collision avoidance is **factory-side**: the `--implement` queue excludes `support`-labelled issues, so the factory never claims an issue Phase 3 owns and the nightly script needs no edits. To hand a support issue to the factory deliberately, a human removes the `support` label — the factory then sees it as an ordinary board card. (Belt-and-braces: if both ever target the same issue, the factory's worktree-slot lock blocks Phase 3's attempt and Phase 3 logs "issue #N already has a factory worktree".)

## Worktree installs & disk

The factory implements each card in a throwaway git worktree that needs its own `node_modules`. The pnpm store lives on an external volume (`/Volumes/Zewnętrzny/pnpm-store`), so a cold `pnpm install` can't hardlink and cross-device-copies ~2000 packages — on #451 this ran **3.5+ hours** and silently held the implement lock, starving every other card. Two mitigations are built in:

- **Clonefile seed.** Before installing, `seed_worktree_node_modules` clones the main checkout's `node_modules` (repo root + `apps/*` + `packages/*`) into the worktree with APFS `cp -c` (O(1), copy-on-write, ~0 bytes). The subsequent install is a fast **offline reconcile** (`pnpm install --frozen-lockfile --offline`), falling back to frozen-online then unfrozen-online for genuine lockfile drift. A cold install now takes seconds.
- **Bounded install + disk guard.** Every install is wrapped by `run-with-timeout.mjs` and capped at `FACTORY_INSTALL_TIMEOUT_SEC`. Before starting, the factory checks free space and parks the card in **Blocked** with a `disk-low` comment if it's below `FACTORY_MIN_FREE_DISK_GB`.

**Env knobs** (set in the launchd plist's `EnvironmentVariables`, alongside `FACTORY_PHASE`):

| Var                           | Default | Purpose                                                           |
| ----------------------------- | ------- | ----------------------------------------------------------------- |
| `FACTORY_INSTALL_TIMEOUT_SEC` | `600`   | Wall-clock cap per worktree `pnpm install`.                       |
| `FACTORY_MIN_FREE_DISK_GB`    | `3`     | Free-disk floor below which a card is Blocked instead of started. |

**Reclaiming disk:**

```bash
git worktree prune                       # drop metadata for removed worktrees
node scripts/lib/worktree-cli.mjs list   # show the factory's live worktrees
rm -rf ~/Library/Developer/Xcode/DerivedData/* ~/.gradle/caches/*
xcrun simctl delete unavailable
# stale Claude Code worktrees (verify the branch is merged first):
#   git worktree remove --force .claude/worktrees/<name>
# or strip just the (reinstallable) node_modules to keep unmerged work:
#   rm -rf .claude/worktrees/<name>/node_modules .claude/worktrees/<name>/{apps,packages}/*/node_modules
```

**Durable fix (optional):** move the pnpm store onto the internal volume so installs hardlink in seconds even without the clonefile seed — `pnpm config set store-dir ~/Library/pnpm/store && pnpm store prune && pnpm install` at the repo root (needs free internal space first). The clonefile seed then remains a cheap safety net regardless of store location.

## Related

- [`docs/features/dark-factory.md`](../features/dark-factory.md) — operator manual.
- [ADR-0026](../adr/0026-dark-factory-pipeline.md) — decision record.
- [`docs/operations/migrations.md`](./migrations.md) — migration safety + rollback workflow.
- [`docs/operations/builds-and-releases.md`](./builds-and-releases.md) — release commands, beta lanes.
