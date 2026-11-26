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
   scripts/setup-factory-board.sh --dry-run
   scripts/setup-factory-board.sh
   ```

   `--dry-run` previews the change and touches nothing; it's optional on a first run. The real run prints the board URL on success — paste it into `docs/features/dark-factory.md` ("The board" section). To add a column to a board that is already in use, follow "Changing the board's Status options" below instead.

3. **Link the repo to the project.**

   ```bash
   gh project link <number> --owner JakubAnderwald --repo JakubAnderwald/drafto
   ```

   The factory issue form (`.github/ISSUE_TEMPLATE/factory-feature.yml`) names the board in its `projects:` key, so an issue filed through it lands on the board. `gh issue create` needs `--project "Drafto Factory"`.

4. **Make new cards land in Backlog.**

   On the board, open ⋯ → **Workflows** → **Item added to project**, click **Edit**, set **Set value** to `Status: Backlog`, and click **Save and turn on workflow**. GitHub has no API to configure project workflows, so this step is manual. Check it took with:

   ```bash
   gh api graphql -f query='{user(login:"JakubAnderwald"){projectV2(number:1){workflows(first:20){nodes{name enabled}}}}}' \
     --jq '.data.user.projectV2.workflows.nodes[] | select(.name=="Item added to project")'
   ```

   Without it a new card has no Status and sits outside every column; with it the card waits in Backlog, which the factory ignores, until you drag it to Ready.

5. **Grant `gh` the `project` scope on the Mac mini.**

   The agent reads and writes the Project v2 board directly via the GitHub GraphQL API — there is no Action mirror. Refresh the existing token on the Mac mini to add Projects v2 read+write:

   ```bash
   gh auth refresh -s project
   ```

   Verify with `gh auth status` — the listed scopes should include `project`. Without it the agent's first board read fails on every tick with a `factory-project find-project failed` warning.

6. **Create the dedicated factory checkout (Deployment).**

   The factory runs from its **own git worktree pinned to `main`**, never from your
   everyday dev checkout. This guarantees it only ever executes reviewed,
   CI-gated code, and keeps its tick-start `git reset --hard` from ever touching
   uncommitted work in your dev tree. (History: the factory once ran straight
   from a feature branch in the dev checkout and shipped an unmerged `--release`
   crash to production — the dedicated tree exists to make that impossible.)

   Create it once as a **detached** worktree at `origin/main` (detached so it
   doesn't collide with `main` being checked out in the primary repo). It lives on
   the factory's build volume, `/Volumes/DraftoFactory` (an encrypted APFS volume on
   the external drive, [ADR-0060](../adr/0060-dedicated-factory-build-volume.md)),
   beside the pnpm store (`store-dir=/Volumes/DraftoFactory/pnpm-store` in pnpm's
   global config, `~/Library/Preferences/pnpm/rc`; set it with
   `pnpm config set store-dir … --location=global`). So `pnpm install` there, and
   in every worktree under it, clones packages from the store instead of copying
   them across volumes. The build toolchain lives on the same volume too:
   `~/.gradle`, Xcode's `DerivedData` / `Archives` / `iOS DeviceSupport`,
   `~/Library/Caches/CocoaPods`, `~/Library/Android/sdk` and `~/.android/avd` are
   symlinks into `/Volumes/DraftoFactory/{Developer,Android,android-avd}`. Keep
   `/Volumes/DraftoFactory/Developer/Xcode/Archives` in IDrive's backup set. The
   macOS archives hold the only copy of the macOS dSYMs, and every distributed
   build's archive must be retained:

   ```bash
   cd /Users/jakub/code/drafto
   git fetch origin main
   git worktree add --detach /Volumes/DraftoFactory/drafto-factory origin/main
   cd /Volumes/DraftoFactory/drafto-factory
   pnpm install                       # worktrees don't share node_modules
   bash scripts/worktree-bootstrap.sh # gitignored env/config files
   ```

   Each tick, `factory-agent-loop.sh` runs `git fetch origin main` +
   `git reset --hard origin/main` before the agent modes (guarded by
   `FACTORY_AUTOPULL=1`, the default), so a merged PR — or a revert — goes live
   on the next 5-min cycle with no manual pull. If the wrapper itself changed in
   that sync, it re-execs the fresh copy once. Set `FACTORY_AUTOPULL=0` only for
   ad-hoc manual runs against a dirty tree.

7. **Install the factory launchd job.**

   On the Mac mini, drop a plist at `~/Library/LaunchAgents/eu.drafto.factory.plist` modelled on `eu.drafto.support-agent.plist` with:
   - `Label = eu.drafto.factory`
   - `ProgramArguments = [/bin/bash, -c, <gate>; exec /bin/bash /Volumes/DraftoFactory/drafto-factory/scripts/factory-agent-loop.sh]` (the **dedicated** checkout from step 5, not the dev tree). The gate skips the tick with a log line unless `/Volumes/DraftoFactory/drafto-factory` exists. That one volume also holds the toolchain the builds use (Gradle home, Xcode DerivedData, the CocoaPods cache, the Android SDK and AVDs), so nothing else needs checking.
   - `StartInterval = 300` (5 min)
   - `EnvironmentVariables.FACTORY_PHASE = A`
   - Stdout/stderr paths under the primary checkout's `logs/launchd-factory-*.log`, on the internal disk, so launchd can still write the gate's "not mounted" line while the volume is missing

   Then load and smoke-test:

   ```bash
   launchctl load -w ~/Library/LaunchAgents/eu.drafto.factory.plist
   launchctl kickstart -k "gui/$(id -u)/eu.drafto.factory"
   tail -f /Users/jakub/code/drafto/logs/launchd-factory-stdout.log
   ```

   The first tick should log `self-update: synced to origin/main @ <sha>` then
   `=== factory-agent --plan run started (phase=A …) ===` followed by
   `=== factory-agent --plan completed in <N>s ===`. Subsequent ticks fire every 5 min.

8. **(Optional) Install the CodeRabbit CLI for the gap-fill lane.**

   Only needed before turning on `FACTORY_CR_CLI=1` (see "CodeRabbit CLI gap-fill lane" below). On the Mac mini:

   ```bash
   brew install coderabbit
   coderabbit auth login      # browser, one-time; the token lands in ~/.coderabbit/auth.json (0600)
   coderabbit doctor          # expect "9 passed, 0 warnings, 0 failed"
   coderabbit auth status     # expect "Plan : Free" (and "Seat : not assigned")
   coderabbit usage           # expect "Usage billing : inactive"
   ```

   > **⚠️ Check `pnpm` afterwards.** On 2026-09-12 `brew install coderabbit` also upgraded Homebrew's `node` (23 → 26) as a side effect. Node 25+ no longer bundles corepack, so `/opt/homebrew/bin/pnpm` became a dangling symlink — and every factory `pnpm install` would have failed on the next `--implement`. If `pnpm --version` fails after any `brew install`/`upgrade`, remove the dangling corepack links and reinstall corepack:
   >
   > ```bash
   > for l in /opt/homebrew/bin/{pnpm,pnpx,yarn,yarnpkg}; do [ -L "$l" ] && [ ! -e "$l" ] && rm "$l"; done
   > npm install -g corepack && corepack enable pnpm
   > pnpm --version   # run inside the repo: must print the packageManager pin (pnpm@10.30.1)
   > ```

## Changing the board's Status options

`scripts/setup-factory-board.sh` is also how a column is added to the live board, for example **Testing**, the pre-In-Test verification column (ADR-0053; see "Pre-In-Test verification (Testing)"). `updateProjectV2Field` replaces the Status field's whole option list. GitHub treats an option sent without its `id` as a new option, and every card in the old one loses its Status. Before 2026-10-20 the script sent no ids, so a re-run could clear the Status of every card on the board. Now the script:

- sends every existing option back with its `id`, colour and description. Only a name the board doesn't have yet is sent without an `id`.
- exits 1 when the board has an option that `STATUS_OPTIONS` doesn't list, because the update would delete it. `--allow-drop` deletes it anyway, so move its cards first.
- sends no update when the board already matches `STATUS_OPTIONS`.
- exits 1 when GitHub returns an option with a different `id`. Restore from your backup (below).
- with `--dry-run`, prints the `updateProjectV2Field` variables (each option with its `id`) and exits. It creates, updates and links nothing.

Only use the script from current `main`. An older copy sends no ids.

**Safe migration.** On the Mac mini. Run one step at a time and stop at the first one that fails. (The blocks carry no `#` comments: with zsh's `interactivecomments` off, a pasted comment becomes arguments.)

1. Go to the factory checkout, which tracks `origin/main`, and set two variables. `FACTORY_PROJECT_ID` saves every later call from looking the board up again; check that it starts with `PVT_`.

   ```bash
   cd /Volumes/DraftoFactory/drafto-factory
   export FACTORY_PROJECT_ID=$(node scripts/lib/factory-project.mjs find-project | jq -r .projectId)
   echo "$FACTORY_PROJECT_ID"
   BACKUP=~/factory-board-backup-$(date +%Y%m%d-%H%M).json
   ```

2. Create the labels first. The script is idempotent and adds `status:testing`.

   ```bash
   scripts/setup-factory-labels.sh
   ```

3. Pause the factory, then wait for runs already in flight. `factory:pause` only stops new ticks, and a run that's still going can move a card, which the diff in step 6 would show as a lost Status. Repeat the `pgrep` until it prints nothing.

   ```bash
   node scripts/lib/state-cli.mjs factory:pause "board migration"
   pgrep -fl factory-agent.sh
   ```

4. Back up every card's Status. Don't go on unless it prints `backup ok`.

   ```bash
   node scripts/lib/factory-project.mjs export-statuses > "$BACKUP" && jq -e 'length > 0' "$BACKUP" >/dev/null && echo "backup ok"
   ```

5. Preview the update. Every existing option in the printed `options` must have an `"id"`; only the new column (Testing) has none. Then run it for real.

   ```bash
   scripts/setup-factory-board.sh --dry-run
   scripts/setup-factory-board.sh
   ```

6. Check. The diff must print nothing, and `has-status-option` must print `"present": true` and exit 0.

   ```bash
   node scripts/lib/factory-project.mjs export-statuses | diff "$BACKUP" -
   node scripts/lib/factory-project.mjs has-status-option --name Testing
   ```

7. Resume.

   ```bash
   node scripts/lib/state-cli.mjs factory:resume
   ```

`export-statuses` is read-only. It prints every item on the board (`itemId`, `issueNumber`, `status`, `type`), sorted, so two exports diff cleanly. If the diff shows lost Statuses, keep the factory paused and put back each card whose Status changed. In the same shell as the steps above:

```bash
node scripts/lib/factory-project.mjs export-statuses > ~/factory-board-after.json
jq -r --slurpfile now ~/factory-board-after.json '($now[0] | map({(.itemId): .status}) | add // {}) as $cur | .[] | select(.status != null and $cur[.itemId] != .status) | [.itemId, .status] | @tsv' "$BACKUP" |
  while IFS=$'\t' read -r item opt; do
    node scripts/lib/factory-project.mjs set-status --item-id "$item" --status "$opt"
  done
```

`set-status` only moves the board card. The `status:*` labels live on the issues, and a board migration doesn't touch them.

`transition_status` removes only the `status:*` labels an issue actually carries, so a label the repo doesn't have yet doesn't break moving a card **out of** a column. Moving a card **into** Testing still needs the `status:testing` label. When the factory can't read an issue's labels, it falls back to removing every status label, and that fails if one is missing. So run the label script first, as in step 2.

## Phase progression criteria

| Promote from → to | Required signals before promotion                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (initial) → A     | Setup steps 1–6 above complete. `launchctl list \| grep eu.drafto.factory` shows the job registered, and a manual `launchctl kickstart` logs a clean `--plan` tick (board fetched, no `factory-failure` issue filed).                                                                                                                                                                                                                        |
| A → B             | ≥5 successful `--plan` runs (Ready → Planning → Plan Review with a usable plan comment). Zero `factory-failure` issues. Operator has read at least 3 plans and judges they were accurate enough to act on. `--implement` no-op confirmed: dragging Plan Review → In Progress in Phase A logs a "phase=A; implementation skipped" comment and leaves the card in In Progress without further action.                                          |
| B → C             | ≥5 successful end-to-end web-only runs (Ready → Plan Review → In Progress → In Review → In Test → **auto-merged + Released** after the operator drags to Approved), each with green CI, a reachable Vercel preview, and zero parity violations. SonarCloud quality gate green on all factory-authored PRs.                                                                                                                                   |
| C → D             | ≥5 successful runs that include mobile or desktop changes. Operator manually fired beta dispatches (TestFlight, Play internal) per Phase C — confirms the dispatch payloads work before the factory automates them. **Pre-merge beta dispatch (below) is the intended way to accumulate this evidence:** it runs at Phase C behind its own knob, so every native card exercises the real lanes before Phase D automates the post-merge ones. |
| D → (steady)      | ≥10 successful Released cards in Phase D. Beta dispatch path validated for both iOS and Android. Mac TestFlight lane runs locally on the Mac mini per the existing release pattern.                                                                                                                                                                                                                                                          |

Promote by editing the `FACTORY_PHASE` env var in the launchd plist and reloading:

```bash
launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist
# edit plist: EnvironmentVariables → FACTORY_PHASE: A → B (or B → C, etc.)
launchctl load -w ~/Library/LaunchAgents/eu.drafto.factory.plist
```

There is no "auto-promote". The phase change is always a deliberate operator action so a regression at one phase can't silently unlock the next.

### Promotion log

A dated record of actual phase changes so the current operating phase is auditable from the repo (the plist itself is a local, untracked file).

| Date       | Change | Operator | Rationale                                                                                                                                                                                                                                                         |
| ---------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-23 | B → C  | Jakub    | Unblock native (mobile/desktop) parity work — notably #537 (forgot-password parity), which the Phase-B web-only scope had blocked at plan time. Phase C implementation code (#535) was already merged. Beta dispatch stays dormant until a later C → D promotion. |

**`--release` runs at Phase B+.** The A→B→C→D phases control implementation _scope_ (web → web+mobile/desktop → beta dispatch); `--release` is the merge step layered on top. Each tick it scans the **Approved** column and, for a card a human dragged there, squash-merges the green PR via the GitHub API (`gh api --method PUT …/merge -f merge_method=squash`) and advances it to **Released** (Vercel auto-deploys main → prod for web). It is bounded by four hard rules:

1. It only ever acts on a card a human (or an allowlisted reporter) moved to **Approved** — the Approved drag _is_ the merge-authorisation gate (ADR-0026); the factory never moves a card to Approved itself.
2. It refuses to merge a PR touching `supabase/migrations/**` until `migration-approved` is on the PR — it leaves the card in Approved and comments once (`<!-- drafto-factory-migration-gate -->`). The label covers the migration SQL it was first seen with, and a later SQL change removes it. See "Migration approval" below.
3. It refuses to merge a PR that changes `supabase/config.toml` until the hosted projects match it. This is the last check before the merge. It leaves the card in Approved, comments once per head SHA, and pins the merge to that SHA. See "Hosted Supabase config gate" below.
4. It won't merge unless CI is green and the branch is conflict-free (a transient merge error is retried next tick, comment `<!-- drafto-factory-merge-failed -->`). Red CI moves the card back to **In Review** for the fix loop, and required checks GitHub cancelled before any runner picked them up are re-run first. See "Red or cancelled CI on a factory PR" below. A conflict with `main` moves the card back to **In Review** too, checked before the CI gate because a conflicting head gets no CI. See "A PR that conflicts with main" below. A branch that is only **behind** `main` (branch protection requires up-to-date branches) is updated with GitHub's update-branch, comments once (`<!-- drafto-factory-branch-updated -->`), and merges on a later tick once CI is green on the new head. `--watch` already did this before In Test, so this only catches a `main` that moved while the card waited for you. See "A PR that is behind main" below.

**"CI is green" means the branch-protection _required_ contexts only** — both `--watch` (In Review → In Test) and `--release` (the merge gate) count only failing/pending checks whose context is in `required_status_checks`, fetched once per run (`fetch_required_contexts` → `pr_failing_required` / `pr_pending_required`). An advisory bot like **CodeRabbit** is never a required context, so its red — including its **"Review rate limited"** status when it can't review — never triggers the `--watch` fix loop, blocks the In Test advance, or blocks the merge. Advisory reds are instead surfaced in the In Test hand-off comment for the operator to glance at before Approving. **A review _comment_ is a different thing from a review _check_:** the check status stays advisory and never gates anything, but an unresolved review **thread** is a hard block on the merge (see `--release` below). (Before this, a rate-limited CodeRabbit check would loop `--watch`'s fix path to exhaustion and park the card in Blocked — the #463 failure of 2026-07-22.) When branch protection is unreadable/empty the helpers fall back to counting all checks, so an unknown required set can't silently pass a red PR.

Right before merging it **verifies every review thread is resolved** (`fetch_review_threads`) — it does **not** resolve them for you. Until 2026-09-12 it did: `resolve_review_threads()` force-resolved every thread without reading one, which satisfied `required_conversation_resolution` on paper while discarding the findings (PR #601's five CodeRabbit threads are all `isResolved: true` for exactly that reason). Now an open thread **refuses the merge**, comments `<!-- drafto-factory-threads-open -->` listing `path:line`, and moves the card back to **In Review** — `--watch` is the only mode that runs the fix loop, so leaving it in Approved would strand it. The card returns to In Test for a fresh approval, because the diff changed after you authorised it. A failed thread query fails **closed** (no merge this tick). See [ADR-0035](../adr/0035-factory-code-review-gate.md).

It is idempotent (an already-merged PR just finishes the Released transition + slot/worktree teardown) and honours `factory-pause`. `factory:pause` stops `--release` along with every other mode.

**Phase-D beta dispatch.** At **Phase D only**, after a Released merge that touched a native platform, `--release` auto-dispatches beta builds via `scripts/lib/dispatch-release.mjs`: it derives the changed platforms from the diff (`apps/mobile/`→mobile, `apps/desktop/`→desktop, `packages/shared/`→both; `apps/web/` deploys via Vercel, no dispatch) and spawns the **local Fastlane lanes** on the Mac mini — `pnpm release:beta:all` (iOS TestFlight + Android internal) and/or `cd apps/desktop && pnpm release:beta` (macOS TestFlight). It uses the local lanes, **not** `gh workflow run`, because the CI release workflows are non-functional (see [builds-and-releases.md](./builds-and-releases.md)). Lanes are spawned detached (fire-and-forget; the Fastlane post-hook `comment-released-issues.mjs` posts the "now live" notice). Production store lanes are never invoked (`assertBetaOnly` denylist). The step is dormant at Phase B/C and marker-guarded (`<!-- drafto-factory-beta-dispatched -->`) so a re-tick can't re-trigger a build.

> **Phase-D prerequisites (operator):** the Mac-mini factory launchd env must carry the Fastlane secrets the lanes need (`MATCH_PASSWORD`, ASC API key, Android keystore + `google-play-service-account.json`), and the `$REPO_ROOT` main checkout must be clean enough to fast-forward (the engine best-effort `git merge --ff-only origin/main` before building so the mobile lane builds the merged code; the **desktop** lane builds from its own root — see below). Validate both at the **C → D manual dispatch step** before promoting. Concurrency caveat: two simultaneous native releases would run overlapping lanes (version/tag contention) — rare at the factory's 1–2-slot cadence, but kick lanes by hand if it occurs.

## Pre-merge beta dispatch (In Test)

A card in **In Test** needs a build a human can actually install. `--watch` therefore dispatches beta builds **from the PR head, before the merge**, for the native platforms the diff touched (ADR-0030). This is separate from the Phase-D post-merge lane above and has its own knobs — enabling pre-merge betas must not silently switch on post-merge auto-dispatch.

| Var                                  | Default                        | Purpose                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_INTEST_BETA`                | `0`                            | Master switch. `1` + Phase C/D dispatches the **mobile** lane (iOS TestFlight + Play internal).                                                                                                                                                                                                                                     |
| `FACTORY_INTEST_BETA_DESKTOP`        | `0`                            | Additionally dispatch the **macOS** lane. Only turn on after the one-time desktop validation below.                                                                                                                                                                                                                                 |
| `FACTORY_INTEST_BETA_REUSE`          | `1`                            | Keep a lane's last successful beta for a new PR head when nothing that lane builds from changed since (see **Reusing a beta across PR heads** below). `0` rebuilds every lane for every head, as before. Any other value turns it off with a warning.                                                                               |
| `FACTORY_INTEST_BETA_REUSE_MAX_DAYS` | `60`                           | Never reuse a build that finished more than this many days ago, or whose finish time is unknown. TestFlight expires builds after 90 days. Checked when the head's decision is made and again on every tick.                                                                                                                         |
| `FACTORY_INTEST_TIMEOUT_SEC`         | `600`                          | Wall-clock cap for the In Test scenario writer (read-only stage).                                                                                                                                                                                                                                                                   |
| `FACTORY_LANE_STALE_MIN`             | `120`                          | A lane silent this long with no exit code is declared dead and retried.                                                                                                                                                                                                                                                             |
| `FACTORY_LANE_MAX_MIN`               | `240`                          | A lane still running this long after ITS dispatch is killed (whole process group) and retried.                                                                                                                                                                                                                                      |
| `FACTORY_LSOF_BIN`                   | unset                          | Path to `lsof`, used to kill hung lanes; no fallback when set. Unset: PATH, then `/usr/sbin/lsof`. None found: WARNING in the agent log, no kill.                                                                                                                                                                                   |
| `FACTORY_LANE_MAX_ATTEMPTS`          | `3`                            | Retry budget per lane per commit; a new commit resets it.                                                                                                                                                                                                                                                                           |
| `DRAFTO_BUILDS_VOLUME_DIR`           | `/Volumes/DraftoFactory`       | The factory's build volume. While it is mounted, both build roots and the nightly's session worktrees default to it; otherwise they default to `/Users/jakub/code`. Its name must stay ASCII ([ADR-0060](../adr/0060-dedicated-factory-build-volume.md)).                                                                           |
| `DRAFTO_BETA_MOBILE_ROOT`            | `<volume>/drafto-beta-mobile`  | Dedicated mobile build root. Must be an **ASCII-only path**: React Native 0.83's iOS pods reject non-ASCII paths, so `ensure_beta_build_root` refuses one. The plist sets it.                                                                                                                                                       |
| `DRAFTO_DESKTOP_BUILD_ROOT`          | `<volume>/drafto-beta-desktop` | Dedicated macOS build root. Seeded and installed like the mobile root. The plist sets it.                                                                                                                                                                                                                                           |
| `DRAFTO_PRIMARY_CHECKOUT_ROOT`       | `/Users/jakub/code/drafto`     | The operator's primary checkout. The hard-reset safety rail reads it (no build root may be this path, so it is never reset or built in), and the In Test macOS comment names it as the checkout never to `git checkout` in. The old name `DRAFTO_DESKTOP_FOSSIL_ROOT` is still read as a fallback, so an older plist keeps working. |

**The build roots.** Each is a detached git worktree that the factory hard-resets to the PR head SHA, with `node_modules` seeded by `cp -c -R` and then `pnpm install`ed, plus a capped `bundle check || bundle install` in the app's directory. Mobile and desktop roots are prepared the same way. A root created by the factory is seeded from the factory checkout on the same volume, so its seed is an O(1) clone. One the nightly creates is seeded from the primary checkout on the internal disk, which makes it a full copy. They are **dedicated and disposable**: `ensure_beta_build_root` refuses, by canonical path, to use the caller's checkout or the primary checkout (`DRAFTO_PRIMARY_CHECKOUT_ROOT`) as a build root, because it resets what it is given and the primary checkout is your working tree. The helpers live in `scripts/lib/beta-build-root.sh`, which `nightly-support.sh` sources too: it ships merged support fixes into the **same** two roots ([ADR-0042](../adr/0042-nightly-support-runner-owns-beta-dispatch.md)). Each root has a pid lock at `<root>.lock`. `ensure_beta_build_root` takes it atomically, with its own pid, before touching the root. `claim_beta_build_root` hands it to the lane's pid, and `release_beta_build_root` drops a lock its holder no longer needs. A root locked by a live pid is skipped, by either scheduler, until a later tick or night. The issue's own worktree is deliberately not used either — the next `--watch` tick may install and edit files in it, and the cleanup sweep deletes it when the card leaves In Test.

**A stale desktop `Pods` is cleared automatically.** The reset's `git clean` keeps the desktop root's `apps/desktop/macos/Pods` and `apps/desktop/macos/build`, so builds stay warm. Right after the reset, still holding the root lock, `ensure_beta_build_root` runs the test Xcode's "[CP] Check Pods Manifest.lock" phase runs: it compares `Pods/Manifest.lock` with the checked-out `Podfile.lock`.

- **They differ, or `Pods` has no `Manifest.lock`:** it deletes both folders, so that build runs a full `pod install` and a cold build. It logs one line with the reason (`manifest mismatch` or `missing manifest`), the root and the commit.
- **They match:** both folders stay.
- **There is no `Pods`:** nothing happens.

The mobile root has no such check, because the iOS lane regenerates `apps/mobile/ios`, `Pods` included, with `expo prebuild --clean` on every build. The check exists because of #790. After #791 moved desktop to react-native-macos 0.83, the kept `Pods` still described hermes-engine 0.81.6 while `Podfile.lock` pinned 0.14.1. CocoaPods reused the cached podspec, and every desktop `pod install` failed with `could not find compatible versions for pod "hermes-engine"` until `Pods` and `build` were deleted by hand.

If the log shows this deletion on **every** desktop dispatch, the committed `Podfile.lock` is not the one a clean `pod install` writes. The lane rewrites it, and the next reset restores the committed one, which no longer matches. The builds are still correct, only cold. Commit the lock that a clean `pod install` writes after a clean `pnpm install` of the committed `pnpm-lock.yaml`, as [`apps/desktop/CLAUDE.md`](../../apps/desktop/CLAUDE.md) and the #618 note in [Release to TestFlight (macOS)](./builds-and-releases.md#release-to-testflight-macos) describe.

> ### The desktop root is a normal install
>
> Until #558 the desktop root was a clonefile replica of the React 19.1 fossil and must never be installed into. That rule is retired ([ADR-0067](../adr/0067-desktop-moves-to-react-native-macos-0-83.md)). The root now seeds from the caller's checkout and runs `pnpm install` like the mobile root. Before spawning the lane, `assertDesktopDeps()` in `dispatch-release.mjs` checks that the root's installed `react-native-macos` equals the version `apps/desktop/package.json` declares and that React is 19.2.x. A mismatch refuses the lane loudly, and the refusal is reported on the issue. The Fastfile's dependency preflight checks the same thing again before CocoaPods.

**One-time desktop validation before `FACTORY_INTEST_BETA_DESKTOP=1`.** A green compile is not proof; only an installed build that opens a note is. Two schedulers reset this root: the factory's lanes, and `nightly-support.sh` at 00:03. An idle factory therefore isn't enough.

The block below prepares the root with the factory's own `ensure_beta_build_root`, so it validates the root exactly as a lane gets it:

- **Preparation.** It fetches `origin/main` and stops if the fetch fails, so it never validates an older commit. It then resets the root to that commit, seeds and installs it, and copies the env files from the factory checkout, as for a lane.
- **The lock.** It takes the root's lock with the pid of the `bash` process that runs the block. While the block runs, both schedulers skip the root. The lock dies with that process, Ctrl-C included, and the schedulers reap a lock whose pid is gone, so there is nothing to clean up by hand.
- **A busy root.** If a live lane holds the lock, the block stops at once with `in use by pid N`. Run it again once that lane has finished. Don't delete the lock yourself.
- **Versions.** It prints the installed `react-native-macos` and React versions. The first must equal the version `apps/desktop/package.json` pins, and the second must be 19.2.x. The lane's dependency preflight refuses a mismatch before CocoaPods anyway.
- **The log.** It writes to `~/drafto-desktop-validation.log`.

```bash
bash -c "$(cat <<'EOF'
set -uo pipefail
REPO_ROOT=/Volumes/DraftoFactory/drafto-factory
SCRIPT_DIR=$REPO_ROOT/scripts
LOG_FILE=$HOME/drafto-desktop-validation.log
INSTALL_TIMEOUT_SEC=1800
DRAFTO_DESKTOP_BUILD_ROOT=/Volumes/DraftoFactory/drafto-beta-desktop
log() { echo "$*" | tee -a "$LOG_FILE"; }
logerr() { echo "$*" | tee -a "$LOG_FILE" >&2; }
git -C "$REPO_ROOT" fetch origin main || exit 1
source "$SCRIPT_DIR/lib/beta-build-root.sh"
trap 'release_beta_build_root desktop' EXIT
ROOT=$(ensure_beta_build_root desktop "$(git -C "$REPO_ROOT" rev-parse origin/main)") || exit 1
cd "$ROOT" || exit 1
node -p "require('./node_modules/react-native-macos/package.json').version"
node -p "require('./node_modules/react/package.json').version"
cd apps/desktop && pnpm release:beta
EOF
)"
```

Then install that TestFlight build and run the verifier, which launches the app rather than only inspecting its bundle. Run it from the factory checkout, not the build root, because the schedulers may reset the root once the block above has ended.

- **The password** is not an argument, because argv is world-readable via `ps`. Supply it in the env var, or leave the variable out and the script prompts for it silently.
- **Production.** The verifier signs in to production, so it asks you to type `sign in to production`. To run it unattended, also set `DRAFTO_VERIFY_CONFIRM='sign in to production'`.

```bash
cd /Volumes/DraftoFactory/drafto-factory
DRAFTO_VERIFY_PASSWORD='...' apps/desktop/scripts/verify-testflight-build.sh <email>
```

Test 6 is the launch check: it opens the app, requires it to survive 15 s, and fails on any new crash report. A React/JSI mismatch dies right after launch, and everything before test 6 passes on such a build, because the "login" test is a `curl` against Supabase rather than the app signing in.

**It still cannot prove the app renders** — a blank window is a healthy process — so finish by opening the app and **opening a note** yourself. Only then add the knob to the plist and reload.

> History: the fossil replica was validated on **2026-08-06** (macOS build 48). The installing root replaces it under [ADR-0067](../adr/0067-desktop-moves-to-react-native-macos-0-83.md), so validate again before turning the knob on, or back on. The plist may already set `FACTORY_INTEST_BETA_DESKTOP=1`: set it to `0` before merging #558, and back to `1` once the installed root's TestFlight build opens a note. The installing root was validated on **2026-11-09** (macOS 0.4.5 build 80, tag `desktop@0.4.5+80`, built from `main` with the block above): `verify-testflight-build.sh` passed 9/9 and the build opened a note, so the knob stays at `1`.

**Identifying a pre-merge build.** Release notes begin `PRE-MERGE TEST BUILD — issue #N / PR #M (sha)` (prepended before the char trim, so it survives Play's 500-char cap), and the Fastlane post-hook `comment-intest-build.mjs` posts the build number on the card when the lane lands.

> Both only apply to a PR branched **after** they landed (`d951b75`). Lanes build the PR head, so an older branch runs its own older copy of `generate-release-notes.sh` and Fastfile and produces neither. If a card's build arrives without the banner, rebase its branch onto `main` — that also re-triggers the scenario and both lanes off the new SHA.

**A pre-merge build never creates a release tag.** The desktop lane tags `desktop@<version>+<build>` after shipping, so the next build's notes start from that tag rather than dumping the whole history — but a pre-merge lane builds an **unmerged** commit. Tagging it publishes a release tag on a commit that is on no branch (and which a rebase can orphan, leaving the tag as the only thing keeping it alive), and it poisons the very range the tag exists to scope: the next real release would start from a tag on an abandoned branch. The tag step is therefore skipped whenever `DRAFTO_INTEST_ISSUE` is set. Both failure modes were observed before the guard — `desktop@0.3.2+49` and `+50` were pushed to origin for #463's pre-merge builds, and `+49`'s commit was orphaned by a rebase.

Mobile tags the same way, as `mobile@<version>+<platform>.<build>` — the platform segment is required because iOS and Android ship one version under two independent build counters (1.3.0 was iOS build 32 and Android build 41). Because those two counters make a version sort meaningless, `apps/mobile/scripts/generate-release-notes.sh` picks its anchor with `--sort=-creatordate` rather than `-v:refname`. Desktop has a single counter, so its notes generator (`apps/desktop/scripts/generate-release-notes.sh`) keeps the version sort; the "Now live" walk (`scripts/comment-released-issues.mjs`) sorts by `-creatordate` and skips every tag on `HEAD` for both apps.

**Triage.** `factory:get-issue <n>` shows the card's beta state:

- `intestBetaSha`: the commit the lanes were dispatched for;
- `intestBetaLanes`: the lanes confirmed started for it;
- `intestBetaReused`: the lanes kept from an earlier build for it (every reader, the verification report included, ignores an entry whose build is too old or no longer the lane's last);
- `intestBetaBuilt` and `intestBetaBuiltAt`: each lane's last successful build, and when it finished;
- `intestCommentSha`: the scenario's SHA.

Lane logs are scoped per dispatch, `beta-lane-<lane>-<issue>-<sha12>-a<attempt>.log`. The second command follows what a lane is doing, and the third prints its exit code once it's done:

```bash
node scripts/lib/state-cli.mjs factory:get-issue <n>
tail -f logs/factory/beta-lane-mobile-463-b243d8196fa2-a1.log
cat logs/factory/beta-lane-mobile-463-b243d8196fa2-a1.log.exit
```

**Reusing a beta across PR heads.** A new PR head doesn't always rebuild every lane ([ADR-0081](../adr/0081-reuse-pre-merge-betas-across-heads.md)). `intestBetaBuilt` records each lane's last **successful** build (`mobile:<sha40>,desktop:<sha40>`), written when its `.exit` reads 0. The first tick that sees a new head compares that commit with the head (`gh api repos/JakubAnderwald/drafto/compare/<built>...<head>`) and keeps the build when:

- the compare is `ahead` or `identical`, so the head contains the build's commit (a merge from main counts, a rebase doesn't);
- it lists fewer than 300 files;
- every one of them is in `docs/`, a `*.md` file outside `scripts/`, `supabase/` (except `config.toml`, which must reach the hosted-config gate), `apps/web/`, `.github/`, `.claude/`, or the **other** lane's app.

Any other file rebuilds the lane: root files such as `pnpm-lock.yaml`, `package.json`, `.npmrc` and `patches/`, `packages/shared/`, the lane's own app, and anything the rule doesn't know. So does any change under `scripts/`, prompts included. A lane runs root scripts, the Fastfile hooks and the build-root preparation, and what they import can only be read from the factory's checkout, not from the head being built, so a helper the PR adds there could otherwise be missed. So does an API error, a non-`ahead` status, too many files, or a lane whose last build failed or is still running. So does a build that finished more than `FACTORY_INTEST_BETA_REUSE_MAX_DAYS` (60) days ago, or at an unknown time (`intestBetaBuiltAt`, taken from its `.exit` file's mtime). That age is checked again on every tick, so a reused build that grows too old while its head waits is rebuilt. The decision is written once per head, in one state write (`factory:set-issue-fields`): `intestBetaSha` moves to the head with `intestBetaLanes` and `intestBetaAttempts` cleared, and `intestBetaReused` lists the kept lanes (`mobile:<built-sha40>`). If that write fails, nothing is dispatched that tick and the next tick decides again. Later ticks read the decision back instead of calling the API again. A kept lane is never dispatched for that head, and the outcome check skips it. The log says `beta lane mobile reused from <sha12> at <sha12>`, or `needs a new build at <sha12> (rebuild <first file>)`, and the In Test comment and the verification report say "No mobile change since Android build 152 / iOS build 147 (`<sha12>`); keep testing that build." The numbers come from the lane's own `drafto-factory-intest-build` notices for that commit. To check a list of paths by hand: `git diff --name-only <built> <head> | node scripts/lib/dispatch-release.mjs lane-reuse --lane mobile --files-file -`. Play's internal track installs only its latest release, so a reused Android build can be superseded by another card's upload. That's why a reused mobile line also tells the tester to check the installed Android build number and, if Play shows a newer one, to test iOS from TestFlight and ask for the Android build in a comment. TestFlight keeps older builds, so iOS and macOS need no such note.

**Dispatch is idempotent per lane, not per card.** `intestBetaLanes` holds only the lanes whose process the OS confirmed started for `intestBetaSha`. Each tick re-dispatches whatever is missing from that set, so a lane that was gated off (low disk, knob off), that failed to start, or that has since failed is picked up automatically — while a healthy sibling is left alone. A new commit invalidates the whole set.

**A failed lane re-arms itself.** Every lane's shell wrapper writes its exit code to `<log>.exit`. Before deciding what to dispatch, the sweep reads it:

| `<log>.exit`                                                     | meaning                                  | what happens                                                                                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| absent, log written recently                                     | still building                           | left alone                                                                                                                                               |
| absent, log silent > `FACTORY_LANE_STALE_MIN`                    | wrapper killed before it could record    | treated as failed, retried                                                                                                                               |
| absent, **no log at all**, dispatched > `FACTORY_LANE_STALE_MIN` | killed before it could even open its log | treated as failed, retried (judged against `intestBetaAt`)                                                                                               |
| absent, log active, dispatched > `FACTORY_LANE_MAX_MIN`          | hung but chatty (e.g. a stuck poll loop) | the lane's process group is killed (TERM, then KILL); treated as failed, retried                                                                         |
| present but empty / non-numeric                                  | caught mid-write                         | left alone; the staleness rows above are the backstop                                                                                                    |
| `0`                                                              | succeeded                                | stays suppressed; if a failure was announced for this lane+commit, a retraction is posted once (`<!-- drafto-factory-beta-recovered:<lane>:<sha12> -->`) |
| non-zero, attempt < `FACTORY_LANE_MAX_ATTEMPTS`                  | failed, budget remaining                 | dropped from `intestBetaLanes`, retried next tick, reported once (`<!-- drafto-factory-beta-failed:<lane>:<sha12> -->`)                                  |
| non-zero, attempt = `FACTORY_LANE_MAX_ATTEMPTS`                  | failed, budget spent                     | **stops** — stays in `intestBetaLanes` so nothing re-dispatches it; the comment says the budget is spent. A new commit resets it.                        |

So a build that dies at minute 20 — an Apple 5xx, a dropped connection — no longer needs a manual state clear, and a deterministically-broken one stops after `FACTORY_LANE_MAX_ATTEMPTS` instead of rebuilding every tick. Lane artefacts are scoped per attempt: `beta-lane-<lane>-<issue>-<sha12>-a<attempt>.log`.

**Two environment traps that make every attempt fail identically.** Both were hit on #463 and cost a day, because each looked like a mysterious process death rather than a one-line config error. Retries cannot help with either — only the operator can.

- **`PATH` must contain `~/.rbenv/shims`.** The launchd agent does not read your shell profile, so a `PATH` that looks fine interactively can still be wrong for the job. Without the shims, `bundle` resolves to `/usr/bin/bundle` (system Ruby 2.6) and every lane dies within seconds on `Could not find 'bundler' (…) required by your Gemfile.lock`. Verify with `launchctl print "gui/$(id -u)/eu.drafto.factory" | grep 'PATH =>'` — not with `which bundle` in your terminal, which consults a different `PATH` and will happily tell you it works.
- **The build must not inherit the factory's `umask 077`.** `factory-agent.sh` sets that so its logs (which carry GitHub tokens) stay owner-only. Inherited into a macOS build it produces a mode-700 `.app`; `productbuild` copies those modes verbatim into the pkg payload and App Store Connect rejects the upload with **ITMS-90255** — _"the installer package includes files that are only readable by the root user"_. The lane wrapper sets `umask 022` and `ensure_beta_build_root` normalises the tree with a `go+rX` pass, covering both what the build generates and what it copies in. Seeded credentials (`.env*`, `google-play-service-account.json`, signing material) are **pruned from that traversal**, never widened and restored — a build root is ~100k files, and "put the secrets back afterwards" leaves them world-readable for the length of the walk. **A macOS lane that compiles and signs cleanly but dies at `upload_to_testflight` is the signature of this regressing** — and note that a build made by hand will _not_ reproduce it, since an interactive shell runs at umask 022.

If you _do_ want to force everything to rebuild, clear both fields. Clearing `intestBetaLanes` re-dispatches every lane started for the head, and clearing `intestBetaReused` rebuilds a reused one too:

```bash
node scripts/lib/state-cli.mjs factory:set-issue-fields <n> intestBetaLanes "" intestBetaReused ""
```

Lanes are still skipped up front — with the reason in the In Test comment — when a knob is off, the phase is B, free disk is below `FACTORY_MIN_FREE_DISK_GB`, a build root can't be prepared, or the desktop dependency check (`assertDesktopDeps`) fails.

## In Test scenario writer

`intest_handoff` writes the test scenario for each new PR head: at Testing entry, at the In Review → In Test promotion, and from the In Test sweep. It counts a run as posted only when the issue holds the factory's own scenario for exactly that head: its comment, with the full-SHA `drafto-factory-scenario-sha` marker on a line of its own, and not the fallback. Otherwise it posts the deterministic fallback, unless that head already has one. A run that timed out is checked the same way, since it may have posted first; only a session limit posts the fallback straight away. When the head already has a real scenario, the writer isn't started at all. The log says `a test scenario for <sha12> is already posted; not invoking the writer`.

**Incremental rewrite ([ADR-0082](../adr/0082-incremental-in-test-scenario-rewrite.md)).** Each run keeps the head's PR diff, and the platforms the scenario is written for, in `logs/factory/scenario/<issue>-<sha12>.diff` and `.json` (mode 600). The next head's run compares the two diffs file by file. It ignores hunk line coordinates (not the function context) and the base blob ids, so a merge of main that touches nothing in the PR gives an empty delta. A diff is kept only when the PR head, read again after `gh pr diff`, is still the run's head; otherwise the log says `not keeping the diff (full mode)`. The writer then gets its previous scenario and only the patches of the files that changed, and still posts a complete scenario. The log line before each run gives the mode and the reason:

```text
Issue #794: scenario for ca1b0f44bfba in delta mode (4 file(s), 734 line(s) since 9859c88addb1)
Issue #794: scenario for 6e093f6e6d18 in full mode (delta-over-800-lines)
```

The other full-mode reasons are `off`, `no-diff`, `no-prior-scenario`, `no-stored-diff`, `platforms-changed`, `delta-over-300-files`, `full-every-<n>` and `invalid-delta`. A dropped file counts toward the line cap with its old patch.

| Var                                | Default | Purpose                                                                                                                                                       |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_SCENARIO_INCREMENTAL`     | `1`     | `0` always sends the whole PR diff and stores no diffs, as before ADR-0082.                                                                                   |
| `FACTORY_SCENARIO_DELTA_MAX_LINES` | `800`   | A delta over this many lines is rewritten from the whole diff.                                                                                                |
| `FACTORY_SCENARIO_FULL_EVERY`      | `4`     | After this many delta rounds in a row, the next scenario is rewritten from the whole diff. `intestScenarioRounds` in `factory:get-issue <n>` holds the count. |

An invalid value warns on stderr and falls back to the default.

**Stored diffs.** A card's older diffs are removed when a new real scenario lands, so each active card keeps about one. A merged card's go in `release_slot_and_worktree`, and any file older than 30 days is reaped at startup. Deleting the directory is safe: the next run of each card is full.

**When a delta scenario looks wrong.** A delta run keeps every step the delta doesn't touch, so a mistake in an older scenario can survive a few rounds. To force the next run of a card to rewrite from the whole diff, set its round count to the cap:

```bash
node scripts/lib/state-cli.mjs factory:set-issue-field <n> intestScenarioRounds 99
```

To turn the incremental mode off for every card, set `FACTORY_SCENARIO_INCREMENTAL=0` in the plist and reload. Nothing else depends on it.

## Hosted Supabase config gate

Pre-merge betas run against prod, so a PR that needs a new Redirect URL in the hosted projects must not reach testers before the entry exists. On #685 / PR #778 the betas went out while dev and prod both lacked `?sb_flow_id=*` entries, and their reset links would have opened drafto.eu instead of the app ([ADR-0065](../adr/0065-factory-hosted-config-gate.md)).

For a PR that changes `supabase/config.toml`, `hosted_config_gate` compares the PR head with its merge base on `main`. It runs in three places:

- in **In Review**, as the last check before Testing or In Test;
- in `intest_dispatch_betas`, before every pre-merge beta;
- in `--release`, as the last check before the merge, which is then pinned to the checked SHA.

What it checks:

- **Redirect URLs the PR adds.** The gate probes each one on dev and prod with an unauthenticated `/verify` request. Supabase redirects an allowlisted `redirect_to` to itself, and anything else to the project's Site URL.
- **Anything else it changes**, and Redirect URLs the probe can't sample, need the **`hosted-config-applied`** label on the PR. Comments, spacing and local-only settings such as `[studio]`, `[db.seed]` and the local ports in `[db]` don't count. `[db.settings]` and `[db.network_restrictions]` do: `supabase config push` applies them to a hosted project.
  - The label covers one version of `config.toml`. If a later commit changes the file, the factory removes the label, logging `removing the label`, and asks again.
  - The label also overrules an inconclusive check, though never a confirmed missing entry.

A held card stays where it is, with one comment per column (`in-review`, `beta`, `approved`) and head SHA:

- `<!-- drafto-factory-hosted-config-hold:<column>:<sha12> -->` lists each missing entry per project, with a dashboard link.
- `<!-- drafto-factory-hosted-config-unverified:<column>:<sha12> -->` means a probe failed, or a control probe misbehaved. The gate holds in this case too.
- A failure to read the merge base or `config.toml` from GitHub holds the card for that tick, with a `WARNING: hosted-config gate:` log line and no comment.
- A held beta lane shows up in the scenario as skipped with `hosted-config-hold`, and is dispatched on a later tick once the gate passes.

**To clear a hold:**

1. Add the listed entries under Authentication → URL Configuration → Redirect URLs in each project. Keep the existing entries. A prod change needs the operator.
2. For the label case, apply the other changes in both dashboards, then add `hosted-config-applied` to the PR.

The next cycle re-checks and the card carries on. **Don't use `supabase config push`**: it pushes the whole file, and `config.toml` doesn't configure prod's Resend SMTP.

To run the check yourself, from a checkout of the PR branch: `pnpm hosted-config:check`. It compares `HEAD` with its merge base on `origin/main`, probes both projects, prints JSON, and exits `0` (ok), `3` (hold) or `4` (unknown). To simulate the label, add `--labels hosted-config-applied`. The `--watch` and `--release` logs say `hosted-config gate passed` or `hosted-config gate held PR #<n>`.

## Migration approval (`migration-approved`)

`--release` merges a PR that touches `supabase/migrations/**` only once the `migration-approved` label is on it. The label covers the migration SQL it was first seen with, so SQL changed after you approved it doesn't merge on that approval ([ADR-0078](../adr/0078-migration-approval-tied-to-sql.md)). `migration_approval_vouch` runs every tick in each column the factory processes with the PR: In Review, Testing and In Test (`--watch`), before an `--implement` run on a card that came back with an open PR, and in `--release` right before the migration gate. It never moves or holds a card; it only ever removes the label.

- **Vouch.** The first time the factory sees the label, it records `<PR>:<head sha>:<hash>` in `migrationApprovedVouched` (`migration-approved on PR #<n> covers its migration SQL as of <sha12> (<hash>)`). The hash covers every file under `supabase/migrations/` that the PR adds, changes or deletes, at any depth. The PR's own version numbers are left out, but the order of its migrations counts: swapping two of their versions changes the hash. While the head stays the recorded one, the factory doesn't hash again. A new head with the same hash just moves the record to that head.
- **Void.** If a later head hashes differently, the factory logs `PR #<n>'s migration SQL changed since migration-approved was added (<old> -> <new> at <sha12>); removing the label`. It first makes sure the issue has the comment (`<!-- drafto-factory-migration-approval-void:<hash> -->`, once per new hash) that lists the PR's files under `supabase/migrations/`, then removes the label, then clears the record. In Approved, the migration gate then holds the card as if the label had never been added.
- **Kept.** The factory's own renumber ([ADR-0077](../adr/0077-factory-renumbers-migrations-mechanically.md)) and update-branch merges don't change the hash, so they keep the label.
- **Errors.** Each step waits for the one before it. If the comments can't be read (`couldn't read #<n>'s comments; keeping migration-approved …`), the comment can't be posted (`couldn't comment on #<n> about the voided migration approval …`) or the label can't be removed (`couldn't remove migration-approved from PR #<n>; retrying next tick`), the label and the record stay, and the next tick carries on from there. A `--release` tick that found the mismatch treats the label as missing either way. If the state, the diff or the hash can't be read (`migration approval: couldn't …`), nothing changes that tick: the factory never removes the label on an error.
- **Odd records.** A record for another PR of the same issue (`the recorded migration approval is for PR #<m>, not PR #<n>; vouching afresh`) or one that isn't `<PR>:<head sha>:<hash>` (`migrationApprovedVouched isn't <PR>:<head sha>:<hash>`) counts as nothing recorded, so the current SQL is vouched for afresh.
- **First sight.** A commit pushed after you add the label and before the factory next processes the card is vouched for as if you had reviewed it, the same window `hosted-config-applied` has. That is at most one tick while the card is in a column the factory processes. A card in Blocked, a card with `factory-pause`, or a paused factory isn't processed, so a label added then covers whatever is pushed before the card is processed again. Add the label after the last migration change you reviewed.

**To re-approve**, review the PR's migrations at its current head and add `migration-approved` again. The next tick records the new hash, and an Approved card merges on a later cycle. To see the hash the factory would record, run `node scripts/lib/migration-approval.mjs hash --pr <n> --head <sha>` in `drafto-factory`. It fetches `main` and the PR head and prints `{hash, files}`.

**Label description.** `scripts/setup-factory-labels.sh` holds the label's description. After it changes (as it did for ADR-0078), re-run `bash scripts/setup-factory-labels.sh` once to update the live label on GitHub; it's idempotent.

## Code review of a large PR

`review_stage` ([ADR-0035](../adr/0035-factory-code-review-gate.md)) fetches the PR's diff and, every time, its file listing (`gh api --paginate repos/JakubAnderwald/drafto/pulls/<n>/files`, one status, path and added/deleted line count per file). `factory-bundle.mjs` then picks the bundle's `reviewDiffMode`:

- **`inline`**: the whole diff, for a PR whose diff fits `truncateDiff`'s caps (4000 lines, 200 KB).
- **`file-list`**: an empty diff and the file stats (`prFileStats`, up to 1000 rows) for a larger diff, or for one `gh pr diff` refused with HTTP 406 (over 300 files or 20,000 lines). The reviewer saves the file listing once under `$TMPDIR`, reads each non-generated file's patch from it with jq, risky files first, and anchors inline comments only on lines in those patches. Until 2026-11, the reviewer got the first 200 KB of the diff instead. That cost the most per review, and the reviewer fetched the whole diff again almost every time.

The log says `PR #<n>'s diff is too large to send inline; reviewing in file-list mode (<k> files)`. Inline reviews log nothing extra. If the file listing call fails, a large diff still goes inline, truncated and flagged as partial, as before. If both calls fail, the log says `empty diff for PR #<n>; skipping review`, and that commit goes unreviewed.

The diff and the file lists reach `jq` through `--rawfile`. Before 2026-11 a diff of about 1 MB or more failed with `Argument list too long`, and the review was skipped with `build_review_bundle failed`.

When `gh pr diff --name-only` refuses a PR with HTTP 406, the In Review loop takes the changed files from the same endpoint and logs `gh pr diff refused PR #<n>'s diff (too large?); took its changed files from the files API`. Before that, the card was skipped with `gh pr diff #<n> failed (transient?)` on every tick and never reached its review. The later stages, such as the scenario writer and the gates, still call `gh pr diff` themselves. So such a PR gets its code review, then waits at the next of them: the hosted-config gate before a beta dispatch logs `hosted-config gate: gh pr diff #<n> failed (transient?)` on every tick. Split the PR, or move it by hand.

## CodeRabbit CLI gap-fill lane

CodeRabbit's PR bot runs on the free OSS tier and often doesn't review a factory commit: it is rate-limited (1–10 PR reviews/hr, scaled by the repo's stars), skipped, or auto-paused after two reviewed commits (`.coderabbit.yaml`). The **CodeRabbit CLI** has a separate free allowance of 3 reviews/hr. When the bot didn't cover a converged In Review card's head commit, `--watch` reviews that commit with the CLI on the Mac mini and posts the findings as review threads, which the ADR-0035 fix loop then answers. See [ADR-0036](../adr/0036-factory-coderabbit-cli-gap-fill.md).

**How it runs.** The lane only acts once a card has converged: required CI green, the Claude review done for the head SHA, and no open threads. It then:

1. **Waits for the bot.** It holds the card while the bot's review is in progress, or for `FACTORY_CR_BOT_GRACE_MIN` while the bot hasn't posted. Coverage is read from the bot's own review bodies and summary comment (REST, bot account only) — never from the `CodeRabbit` commit status, which reads SUCCESS even when rate-limited.
2. **Starts one CLI run** if the bot didn't cover the commit. The run is a detached supervisor process in its own detached worktree, with a stripped environment (no `GH_TOKEN`, no support secrets). **At most one run is ever in flight** — two concurrent CLI reviews fail with a WebSocket `connection` error. The card keeps holding while it runs. If the PR's head moves on (a fix commit) or the PR closes while the run is still going, the next tick terminates it (SIGTERM to its process group), removes its worktree and frees the slot — its results could only be a stale summary. That run's hourly slot stays spent, but it doesn't count against the card's run cap, and no coverage is recorded.
3. **Posts the findings** on a later tick, with no Claude call:
   - Critical/major/minor findings become inline threads (critical/major only on an incremental re-review). If `gh pr diff` fails (e.g. a diff too large for the API — exactly the PR most likely to carry criticals), they open as **file-level** threads instead, which need no diff hunk.
   - Everything else goes into one summary comment marked `<!-- drafto-factory-cr-cli sha=<sha> -->`: lower severities, findings outside the PR diff, anything past the per-run thread cap, and non-critical findings within 3 lines of an existing thread. That proximity check only counts comments by the owner or the CodeRabbit bot, in threads that are unresolved and not outdated (at the thread's current line), and never this run's own threads — a partial post must not demote the rest. A **critical** finding is never demoted for proximity. A thread-worthy finding that ends up only in the summary because of the thread cap, or because GitHub rejected its comment twice, makes the commit's coverage `cli-partial` (below): the fix loop reads threads, not the summary, so the tester is told.
   - Each thread starts `**[CodeRabbit CLI · <severity>]**` and carries a disclaimer and a `drafto-factory-cr-finding` fingerprint marker, so re-posting is idempotent. Only the owner's and the bot's comments count for that de-duplication (resolved threads included), and only within 20 lines of the earlier comment — the same wording elsewhere in the file is a separate finding. The summary counts as already posted only if the owner's own comment carries the full marker — a public commenter can't suppress findings by pasting one.
   - A failed post is retried on the next tick. If the post still hasn't succeeded more than 70 minutes past the run's deadline (the 10-minute overdue grace plus an hour), housekeeping gives up: it records `cli-failed` for the commit (unless the PR has closed or moved to a new head; a PR that can't be read at all is recorded anyway), removes the worktree and frees the slot, so the card promotes with a note instead of holding forever. Separately, the gate stops holding a card for its own run 80 minutes past that run's deadline and promotes it as `hold-expired`, even if housekeeping never manages to finish the run. If that run does finish later, housekeeping discards its results (`discarded: "already-decided"`) instead of posting threads onto a card that has moved on or overwriting the recorded coverage.
4. **Promotes** the card once CodeRabbit covered the commit, or once the hold expires. In the latter case the In Test hand-off says "CodeRabbit did not review `<sha12>` (…)". The note is its own field in the In Test bundle (`crCoverageNote`, rendered on its own line — never listed among the advisory checks). When the In Test sweep re-writes a scenario for the same head with the lane on (e.g. the promoting tick died before its comment), it rebuilds the note from the recorded coverage. If the lane itself errors, the card promotes anyway (fail open) with "CodeRabbit coverage of `<sha12>` unknown (lane error)" — that note isn't recorded, so a re-written scenario can't repeat it — and a commit pushed while the card is already In Test gets no note at all.

A thread-driven fix pass whose open threads are all CLI findings gets **one free pass per CLI run** (no retry attempt spent), and a card gets at most `FACTORY_CR_CLI_MAX_RUNS_PER_CARD` CLI runs per In Review stint, so CLI findings can't exhaust `FACTORY_MAX_ATTEMPTS` on their own. A missing binary, a failed `coderabbit doctor`, or an expired login never blocks a card — it promotes with a `cli-unavailable` note. A failed `doctor` pauses the lane for an hour and promotes the card in that same tick.

**Knobs** (launchd plist `EnvironmentVariables`):

| Var                                 | Default | Purpose                                                                                                                                                                                                                       |
| ----------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_CR_CLI`                    | `0`     | Master switch. Ships dark: dry-run first (see "Dry run" below), then set `1` in the plist. Setting it back to `0` is the kill switch.                                                                                         |
| `FACTORY_CR_CLI_MAX_PER_HOUR`       | `3`     | Rolling hourly CLI budget (the vendor's free allowance). Consider `2` if you also use the CLI interactively.                                                                                                                  |
| `FACTORY_CR_CLI_MAX_RUNS_PER_CARD`  | `2`     | CLI runs per card per In Review stint; reset when the card reaches In Test.                                                                                                                                                   |
| `FACTORY_CR_CLI_TIMEOUT_MIN`        | `45`    | Supervisor kills a CLI run after this long (a large review takes 7–30+ min).                                                                                                                                                  |
| `FACTORY_CR_BOT_GRACE_MIN`          | `15`    | How long to wait for the PR bot to post before treating the commit as a gap.                                                                                                                                                  |
| `FACTORY_CR_HOLD_MAX_MIN`           | `60`    | Cap on holding a converged card waiting to start a run. Worst-case hold per head commit ≈ this + `FACTORY_CR_CLI_TIMEOUT_MIN` (up to 80 min more if collecting the run keeps failing); the clock restarts on each new commit. |
| `FACTORY_CR_CLI_BIN`                | unset   | Explicit path to `coderabbit`. Otherwise PATH, then `/opt/homebrew/bin`, then `/usr/local/bin`.                                                                                                                               |
| `FACTORY_CR_CLI_LIMIT_FALLBACK_MIN` | `60`    | Lane pause when the vendor rate-limits without a parseable `waitTime`.                                                                                                                                                        |

The hold bound is per head commit, not per card. Normally one commit holds for at most `FACTORY_CR_HOLD_MAX_MIN` + `FACTORY_CR_CLI_TIMEOUT_MIN` (~105 min): a run started just before the hold cap, plus its timeout. If collecting that run keeps failing (the PR can't be read, posts keep failing, housekeeping throws), the card's hold on its own run ends 80 minutes past the run's deadline, so the absolute worst case is ~185 min. Each fix commit that converges starts a fresh `FACTORY_CR_HOLD_MAX_MIN` window, so a card that goes through two CLI rounds (`FACTORY_CR_CLI_MAX_RUNS_PER_CARD`) can sit in In Review for 3–4 h in total, plus the bot grace on any later commit.

**Dry run.** Pass the phase explicitly. `factory-agent.sh` ignores `FACTORY_PHASE` in the environment (only `factory-agent-loop.sh` reads it) and defaults to Phase A, where `--watch` is a no-op that never reaches the lane:

```bash
FACTORY_CR_CLI=1 bash scripts/factory-agent.sh --watch --phase B --dry-run   # use the plist's current FACTORY_PHASE
```

Look for `CodeRabbit lane → promote (dry-run:<action>:<reason>)` lines. A dry run saves nothing, so the bot grace clock restarts on every tick: a commit with no CodeRabbit bot activity always reports `dry-run:hold:bot-grace`. `dry-run:start:gap:<state>` only shows for a commit where the bot left a rate-limit, skip or pause marker.

**Inspecting and steering it:**

```bash
node scripts/lib/state-cli.mjs factory:cr-cli-status            # inFlight run, runs in the last hour, nextSlotAt, lane pause
node scripts/lib/state-cli.mjs factory:cr-cli-pause-until <iso> "<reason>"  # pause the LANE only (not the factory)
node scripts/lib/state-cli.mjs factory:cr-cli-resume            # lift a lane pause early (e.g. after re-auth)
node scripts/lib/state-cli.mjs factory:get-issue <n>            # crCoverageSha / crCoverage / crLastCoveredSha / crCliRuns
```

A vendor rate-limit (`errorType:"rate_limit"`, with a `waitTime` such as "50 minutes") pauses **only this lane** until then. It never uses `factory:pause-until`, which would stop the whole factory.

**What a lane pause does to cards.** A pause only stops new CLI runs. A converged card still holds for the bot (grace / in progress) and for a CLI run of its own that is already in flight; that run finishes and posts as usual. After that, the pause reason decides:

- `rate_limited` / `action_required` (the pauses the lane sets itself on a vendor rate limit or billing-consent prompt): the card holds as `cli-paused` if the pause ends inside its `FACTORY_CR_HOLD_MAX_MIN` window, and otherwise promotes with coverage `budget`.
- Anything else (`auth`, `doctor`, an operator's `factory:cr-cli-pause-until` reason, or a pause with no parseable end): the card promotes at once with coverage `cli-unavailable`.

`factory:cr-cli-pause-until` is therefore not a way to stop cards holding. Use `FACTORY_CR_CLI=0` for that.

**Where things live** (in the factory checkout, `/Volumes/DraftoFactory/drafto-factory`):

- `logs/factory/cr-cli/<runId>/` — `meta.json` (binary, args, base commit, deadline), `events.ndjson` (the CLI's `--agent` event stream), `stderr.log`, and `exit.json` (`exitCode`, `signal`, `timedOut`, written when the run ends). Reaped after 30 days by the lane's housekeeping, which runs at the top of every `--watch` tick (the only retention rule for these dirs).
- `worktrees/cr-cli-<issue>-<sha12>` — the detached checkout the CLI reviews. Removed when the run is processed; orphans are reaped by the next tick. A worktree is never reaped while a supervisor for it is still alive (a run dir's `meta.json` names the worktree, and a live process's command line carries that run id), even after its ledger entry was released; if the process table can't be read, every worktree a run dir claims is kept.

**Killing a wedged run.** The supervisor runs the CLI in its own process group. `factory:cr-cli-finish` SIGTERMs that group itself — only when the run is still ours (the recorded pid is alive with the run id on its command line, or the supervisor has exited but members of its process group, i.e. the CLI, are still running, or the supervisor is mid-exit — `ps` then shows it as `(node)` on macOS, without its command line, and it counts as a live member itself until it is gone; a reused pid is left alone) — and waits up to `--wait-ms` (default 10 s) until no live member of the group is left. Only then does it release the ledger slot and report `killed:true|false`. Otherwise it changes nothing and prints `ok:false`, so the gate never starts a second, vendor-refused run on top of a still-connected CLI:

- `supervisor-still-running` — the group ignored SIGTERM. `kill -KILL -<pid>` (negative pid = the whole group) and run the finish again.
- `supervisor-unverifiable` — `ps` failed, so ownership couldn't be checked. Do **not** kill a process group blind: inspect it first (`ps -axo pid,pgid,stat,command | awk '$2 == <pid>'`), fix whatever blocks `ps`, and retry.

This is also the manual escape hatch when you can't wait for the next tick's housekeeping:

```bash
node scripts/lib/state-cli.mjs factory:cr-cli-status           # note inFlight.pid, .runId, .worktree
node scripts/lib/state-cli.mjs factory:cr-cli-finish <runId> --refund none   # SIGTERMs the group, waits, then frees the slot
kill -KILL -<pid>                                              # ONLY on supervisor-still-running (negative pid = the whole group); then re-run finish
```

Leave the worktree to housekeeping: its reap skips a worktree until that run's supervisor has actually exited, then removes it.

**Coverage values** (`crCoverage`, recorded per head SHA). The first three produce no In Test note; the rest add "CodeRabbit did not review `<sha12>` (…)":

| `crCoverage`      | Meaning                                                                                                                                                                                                                                                         | What to do                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `bot`             | The PR bot reviewed this commit.                                                                                                                                                                                                                                | Nothing.                                                                                                     |
| `cli`             | The CLI reviewed it and posted findings, every thread-worthy one as a thread (plus the summary).                                                                                                                                                                | Nothing — the fix loop answers the threads.                                                                  |
| `cli-empty`       | The CLI reviewed it and found nothing (or skipped it because there were no changes).                                                                                                                                                                            | Nothing.                                                                                                     |
| `cli-partial`     | The CLI reviewed it, but some thread-worthy findings only reached the summary comment (thread cap, or GitHub rejected the comment), or fewer findings could be parsed than the CLI reported.                                                                    | Read the CLI summary comment on the PR; nothing acted on those findings.                                     |
| `cli-failed`      | The CLI run errored, timed out, or died; it reported a failed review, or skipped the review for any reason other than no changes; reported findings none of which could be parsed; or its findings still couldn't be posted 70 minutes past the run's deadline. | Read `logs/factory/cr-cli/<runId>/stderr.log` and `events.ndjson`, and the `--watch` log for the post error. |
| `budget`          | No CLI slot (hourly budget, or the lane's own rate-limit / billing-consent pause) would open inside the hold window.                                                                                                                                            | Nothing, unless it's frequent — then lower interactive CLI use or raise `FACTORY_CR_HOLD_MAX_MIN`.           |
| `hold-expired`    | The card waited `FACTORY_CR_HOLD_MAX_MIN` without coverage (e.g. another card's run was in flight), or its own run still wasn't collected 80 minutes past the run's deadline.                                                                                   | Nothing; review the commit by hand if it matters.                                                            |
| `cap-reached`     | This card already used `FACTORY_CR_CLI_MAX_RUNS_PER_CARD` CLI runs this stint.                                                                                                                                                                                  | Nothing.                                                                                                     |
| `cli-unavailable` | No `coderabbit` binary, `coderabbit doctor` failing, or the lane is paused for any reason but a vendor rate limit or billing-consent prompt (`auth`, `doctor`, an operator pause).                                                                              | See "Re-auth" below, or lift an operator pause with `factory:cr-cli-resume`.                                 |

**Never `--use-credits`.** That flag bills usage-based reviews once the included allowance is spent. The factory never passes it (a test scans `scripts/` for the string, and the supervisor re-checks the command it is about to spawn), and an `action_required` (on-demand billing consent) result is treated as an exhausted budget. Note that the spike's rate-limit error reported "Usage-based reviews are enabled" for the organisation even though `coderabbit usage` shows "Usage billing : inactive" (the account has no assigned seat, so it can't be charged today). Belt and braces: in the CodeRabbit dashboard (Subscription and Billing), disable usage-based reviews or set a $0 spending cap.

**Re-auth.** If a run fails with an auth error, the lane pauses itself for 6 h and cards promote with `cli-unavailable`. Fix it on the Mac mini:

```bash
coderabbit auth status        # "Signed in"? which organisation?
coderabbit auth login         # browser; re-writes ~/.coderabbit/auth.json
coderabbit doctor             # all checks must pass
node scripts/lib/state-cli.mjs factory:cr-cli-resume
```

Auth is a file, not the Keychain, so it keeps working from launchd after a headless reboot. If `doctor` fails on `Backend reachable` / `WebSocket reachable`, it's the network or the vendor — the lane's 60-minute `doctor` pause retries on its own.

### Asking whether a PR was reviewed

The lane records coverage in factory state, but a PR merged by hand has no card. This answers
the same question from the PR alone, for any PR in this repo:

```bash
node scripts/lib/coderabbit-cli.mjs coverage --pr 628
# {"covered":false,"source":null,"bot":"absent","cli":"absent",…,"reason":"nothing has reviewed this commit"}
```

Exit `0` when covered, `2` when it ran fine and the answer is no, `1` when it could not answer
at all — a caller that cannot tell those apart fails open on an outage. `covered` is true for a
bot review of the head commit or a completed CLI run (`COVERED_KINDS`); `cli-partial` is not
coverage, because findings that only reached the collapsed summary never went in front of the
fix loop.

It is read-only — no ledger, no worktree, no CLI binary — and it is what the `/merge` skill
calls before merging. Two states are worth knowing apart: `retryable: true` means a review is
running right now and is worth waiting for, while `rate_limited` means waiting needs the hour
to roll over.

### Reviewing a hand-made PR with the CLI

The lane only reviews factory cards. For a PR opened by hand whose head has not been covered by a review, run the same CLI review yourself ([ADR-0037](../adr/0037-manual-coderabbit-cli-review.md)):

```bash
node scripts/lib/coderabbit-cli.mjs review --pr 637 --repo-root "$PWD" \
  --state-file /Volumes/DraftoFactory/drafto-factory/logs/factory-state.json --timeout-min 30
# {"pr":637,"headSha":"…","ran":true,"reason":"reviewed","outcome":"ok","coverage":"cli","posted":{"inline":1,…}}
```

- **It waits.** A review takes minutes, so `/merge` starts it in the background.
- **What it posts.** Findings go up as review threads plus a summary comment, exactly as the lane posts them, so `coverage` then reports `source: "cli"`.
- **What it skips.** A head the bot reviewed or is reviewing, a head a CLI review already covered, and a PR that is no longer open.
- **Always pass the factory's state file on the Mac mini.** The run then shares the lane's run log: it refuses to start (`cli-busy`, `cli-paused`, `cli-budget`) instead of colliding with a factory run, it uses up an hourly slot, and a vendor rate limit pauses the lane.
- **While it runs**, `factory:cr-cli-status` shows an `inFlight` with `"manual": true` and the process's pid. Factory cards wait at `cli-busy`, and housekeeping leaves the run alone. If the process dies, the next `--watch` tick frees the slot. `factory:cr-cli-finish <runId>` frees it at once.
- **Primary checkout's state file.** `logs/factory-state.json` there is not the factory's; the live one is in `drafto-factory`.

## Browser runner (Claude in Chrome)

The factory's only way into a browser ([ADR-0051](../adr/0051-factory-browser-runner.md)). `run_browser_task` in `scripts/factory-agent.sh` starts a `claude -p --chrome` session, the one claude call that doesn't pass `--no-chrome`, locked down like this:

- **Tools:** `--permission-mode dontAsk --tools ""` and an allowlist of Chrome tools, so no Bash, files, `gh` or subagents.
- **Isolation:** `--setting-sources "" --strict-mcp-config` drops your user settings, plugins, `~/.claude/CLAUDE.md` and the claude.ai connectors from its session.
- **Guard:** a generated `--settings` file wires in `scripts/lib/browser-guard.mjs` (see [claude-code-hooks.md](./claude-code-hooks.md#the-browser-runners-guard-generated-not-committed)).
- **Prompt:** `scripts/factory-browser-prompt.md`, fed on stdin.
- **Working directory:** an empty temp dir outside the repo.

The runner drives **this Mac mini's own Chrome profile** — your real sign-ins — so it never gets more than this.

It has three uses, the **kinds** in `FACTORY_BROWSER_KINDS`. The first two run the `### Web` section of the factory's own scenario for the head commit, the same way:

- **`verify`, the Testing column's browser lane** ([ADR-0053](../adr/0053-pre-in-test-verification-stage.md)). For web cards in Testing, with `FACTORY_VERIFY=1`. It posts nothing: its result goes into the verification report the card gets at In Test. See "Pre-In-Test verification (Testing)" and [factory-verification.md](../features/factory-verification.md#the-browser-lane).
- **`intest`, the In Test web run.** For cards in In Test whose diff touches `apps/web`. It posts one report comment. It skips a commit the verify lane already reported on, so it is the fallback for a commit that lane couldn't report on.
- **`plan`, the plan-stage browser probe** ([ADR-0071](../adr/0071-plan-stage-browser-probe.md)). For web cards in Plan Review, with `FACTORY_PLAN_PROBE=1`. It runs the planner's own checks on a throwaway probe preview, not a PR's, and its result goes into the probe's report comment. It works differently from the other two; see "Plan-stage browser probe" below.

How `verify` and `intest` run:

- **Candidates:** the `--watch` sweeps list them in `logs/factory-browser-candidates`, one `<kind>:<issue>:<pr>:<sha>` line each, `verify` lines first (a bare `<issue>:<pr>:<sha>`, the old format, reads as `intest`). The `--browser` mode, which the loop runs after `--release` and `--watch` and before `--implement` and `--plan` ([ADR-0068](../adr/0068-factory-runs-the-board-right-to-left.md)), re-checks each against its own column (Testing, In Test, or Plan Review for a plan-stage probe) and runs at most one per tick: `verify` first, plan-stage probes last. Its log is `logs/factory/factory-agent-browser-<date>.log`.
- **Where:** on that commit's own preview, found through the GitHub Deployments API (`vercel[bot]`, state `success`), signed in as the factory's dev-database test account.
- **What gets posted:** for `intest`, one report comment, with the run's screenshots under its steps once publishing is set up (see "Test-run screenshots on GitHub"); for `verify`, nothing, and its screenshots go into the verification report. A FAIL doesn't move the card.
- **How often:** each head SHA gets two attempts, shared by both kinds, and a new commit re-arms it. A run that fails on the browser's side gives its attempt back: unavailable, auth-expired, guard-not-loaded, or a session limit. A timeout or an error keeps it.
- **Sign-in lease:** the run mints its one-time sign-in link under the sign-in lease it shares with the verification shell lane (see "The sign-in lease" below), after every cheap check. If the shell lane holds it, the run is deferred to the next `--browser` tick: no attempt spent, no health result, nothing written or posted.

| Var                                  | Default                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_BROWSER`                    | `1`                                          | Master switch; `0` turns the runner off. Anything but `0`/`1` falls back to `0`.                                                                                                                                                                                                                                                                                                                                |
| `FACTORY_BROWSER_KINDS`              | `intest,verify,plan`                         | Comma list of live uses: `intest` (the In Test web run), `verify` (the Testing column's browser lane, inert while `FACTORY_VERIFY=0`) and `plan` (the plan-stage browser probe, inert while `FACTORY_PLAN_PROBE=0`). Unknown words are dropped with a warning.                                                                                                                                                  |
| `FACTORY_BROWSER_DEVICE_ID`          | `9796912b-8977-4d74-9c08-d9bb283b9496`       | The only browser the guard lets the runner select: this Mac mini's Chrome, never the MacBook's. A malformed value turns the runner off.                                                                                                                                                                                                                                                                         |
| `FACTORY_BROWSER_TIMEOUT_SEC`        | `900`                                        | Wall cap per runner session.                                                                                                                                                                                                                                                                                                                                                                                    |
| `FACTORY_BROWSER_MODEL`              | empty                                        | `--model` for every runner session, all three kinds (ADR-0080). Empty means `FACTORY_MODEL` (`opus[1m]`, ADR-0101): the runner has no setting sources, so it always gets an explicit model. An alias (`opus`, `sonnet`, `haiku`, `fable`) or a full `claude-…` name, optionally with `[1m]`; anything else warns and falls back to empty. Smoke-test a model before setting it: see "Claude effort & timeouts". |
| `FACTORY_SIGNIN_LEASE_SEC`           | `300`                                        | How long a browser run holds the sign-in lease from its mint (see "The sign-in lease"). The runner opens its link early in its session, so a few minutes is enough. It is released when the run ends anyway. Positive integer; a bad value falls back to `300`. Above 360 the shell lane, which waits at most 6 minutes, gives up first and runs without a session.                                             |
| `FACTORY_BROWSER_ACCOUNT_FILE`       | `~/drafto-secrets/browser-account.env`       | `FACTORY_BROWSER_EMAIL=` / `FACTORY_BROWSER_PASSWORD=` of the test account. Must be mode `600`; read by node, never sourced. Without it the runner doesn't start. The runner itself gets only the email; the password is used for the secret scan.                                                                                                                                                              |
| `FACTORY_BROWSER_UPLOADS`            | `0`                                          | Uploads in the runner's intest and verify runs: files from the scenario's `### Fixtures` section, generated into the run's `fixtures/` before the session ([ADR-0073](../adr/0073-factory-verification-data-checks-live-tests-uploads-admin-js.md)). The guard allows `file_upload` for those files only.                                                                                                       |
| `FACTORY_BROWSER_JS`                 | `0`                                          | Read-only page JavaScript (`javascript_tool`) in intest and verify runs, checked by the guard's `jsVerdict` (ADR-0073).                                                                                                                                                                                                                                                                                         |
| `FACTORY_BROWSER_ADMIN`              | `0`                                          | Steps marked `(admin)`, signed in as the admin account by one-time link (ADR-0073). Needs `FACTORY_BROWSER_ADMIN_ACCOUNT_FILE`.                                                                                                                                                                                                                                                                                 |
| `FACTORY_BROWSER_ADMIN_ACCOUNT_FILE` | `~/drafto-secrets/browser-admin-account.env` | `FACTORY_BROWSER_ADMIN_EMAIL=` of the factory admin account on dev (setup step 4), mode `600`. The email only: the admin signs in by link, never with a password. A missing or unusable file means no admin steps (they're SKIP), never a failed run.                                                                                                                                                           |
| `FACTORY_BROWSER_SIGNIN_KEY_FILE`    | `~/drafto-secrets/dev-supabase-admin.env`    | `DEV_SUPABASE_URL=` / `DEV_SUPABASE_SERVICE_ROLE_KEY=` of the **dev** project. Mode `600`. The factory uses it only to mint the runner's one-time preview sign-in link (`browser-signin.mjs`); minting refuses any other project. Never reaches the runner. Operators also read it via `pnpm test:live:supabase`, in interactive sessions only.                                                                 |

With `FACTORY_BROWSER_UPLOADS=1`, the run's settings also share its `fixtures/` with the session (`permissions.additionalDirectories`). Claude Code's `file_upload` takes only files the session may read, and the runner's working directory is an empty one elsewhere, so without it every upload is refused ("only files this session is allowed to read can be uploaded"). That check also needs the Read tool in the session: with `--tools ""` an upload is refused whatever folders are shared (measured with Claude Code 2.1.323). So an uploads run's `--tools` includes `Read`. It's never in `--allowedTools`, which would allow any path, and never in `permissions.deny`, which makes `file_upload` refuse every file. The guard hooks Read and denies every call, so the runner can upload those files and read nothing.

### One-time setup

1. **Chrome and the extension.** Chrome runs on the Mac mini with the Claude in Chrome extension signed in. From an interactive session, `list_connected_browsers` lists `9796912b-…` with `isLocal: true`.
2. **Vercel login.** Open any current Vercel preview in that Chrome. It should load the app directly, not Vercel's login page. The runner relies on this session to get past preview protection.
3. **A test account in the dev project.** Create it in `huhzactreblzcogqkbsd`, **never prod**: sign up as `jakub+factory-browser@anderwald.info` on a preview or on `localhost:3000`. Then approve it in the dev project's SQL editor:
   ```sql
   update public.profiles set is_approved = true
   where id = (select id from auth.users where email = 'jakub+factory-browser@anderwald.info');
   ```
   It's a separate account from the CI E2E user (`E2E_TEST_EMAIL`), so the runner's test data never collides with CI's.
4. **Optional, ADR-0073: uploads, page JavaScript, admin steps and data checks.** Each has its own switch in the plist, `FACTORY_BROWSER_UPLOADS`, `FACTORY_BROWSER_JS`, `FACTORY_BROWSER_ADMIN` and `FACTORY_DEV_INSPECT`, and each is off by default. Turn them on one at a time and watch a run's guard log (`logs/factory/browser-guard/`) before the next. Admin steps need a dev admin account of their own, separate from the test account and from your own account:
   - **The account:** `jakub+factory-admin@anderwald.info` in `huhzactreblzcogqkbsd`, **never prod**. It was created through the dev Auth admin API with no password, since the factory only signs in by link, then approved and made admin:
     ```sql
     update public.profiles set is_approved = true, is_admin = true
     where id = (select id from auth.users where email = 'jakub+factory-admin@anderwald.info');
     ```
     To recreate it, sign up as that address on a preview and run the same SQL.
   - **The file on the Mac mini:** the email only, never a password:
     ```bash
     (umask 077 && printf 'FACTORY_BROWSER_ADMIN_EMAIL=%s\n' 'jakub+factory-admin@anderwald.info' > ~/drafto-secrets/browser-admin-account.env)
     node scripts/lib/browser-report.mjs admin-email --account-file ~/drafto-secrets/browser-admin-account.env   # prints the email
     ```
5. **The account file.** Write it with an editor rather than `echo`, which would leave the password in shell history:
   ```bash
   # ~/drafto-secrets also holds the factory's other secrets (support-env.sh, zoho-oauth.json)
   $EDITOR ~/drafto-secrets/browser-account.env   # FACTORY_BROWSER_EMAIL=… / FACTORY_BROWSER_PASSWORD=…
   chmod 600 ~/drafto-secrets/browser-account.env
   node scripts/lib/browser-report.mjs account-check --account-file ~/drafto-secrets/browser-account.env   # prints ok
   ```
6. **The dev sign-in key.** The runner signs in on a preview by opening a one-time link, because Claude in Chrome won't type a password there (ADR-0051). Minting that link needs the **dev** service-role key. Fetch it with the Supabase CLI login rather than copying it by hand:
   ```bash
   # writes ~/drafto-secrets/dev-supabase-admin.env (mode 600); prints nothing secret
   TOKEN=$(security find-generic-password -s "Supabase CLI" -a supabase -w | sed 's/^go-keyring-base64://' | base64 -D)
   curl -s "https://api.supabase.com/v1/projects/huhzactreblzcogqkbsd/api-keys?reveal=true" -H "Authorization: Bearer $TOKEN" \
     | jq -r '"DEV_SUPABASE_URL=https://huhzactreblzcogqkbsd.supabase.co\nDEV_SUPABASE_SERVICE_ROLE_KEY=" + ([.[] | select(.name=="service_role")][0].api_key)' \
     > ~/drafto-secrets/dev-supabase-admin.env && chmod 600 ~/drafto-secrets/dev-supabase-admin.env; unset TOKEN
   ```
   The web app's `/auth/test-sign-in` route must be on the PR's branch: it is on every branch cut after ADR-0051 landed. The factory skips older branches and notes it on the issue.
7. **Nothing to switch on.** The runner is on by default (`FACTORY_BROWSER=1`, `FACTORY_BROWSER_KINDS=intest,verify,plan`), so the next tick after steps 1–5 runs it. To turn it off, set `FACTORY_BROWSER=0` in the plist's `EnvironmentVariables`, then `launchctl unload`/`load` it.

### What a run leaves behind

- **Run directory:** `logs/factory/browser/issue-<n>-<sha12>-<timestamp>/` (`…-<sha12>-verify-<timestamp>/` for a verify run, `issue-<n>-probe-<probeId>-<timestamp>/` for a plan probe run) holds:
  - `runner-output.txt`, the runner's whole reply (the verification report reads a verify run's from here);
  - `comment.md`, exactly what was posted, for an In Test run; `section.md` for a verify or plan run, the same scanned and defanged report with no markers, never posted on its own;
  - `render.json`, the parsed status, verdict and secret-scan result;
  - `evidence/`, the screenshots the guard copied, mode 700;
  - `session-id`, the runner's session id, which names its guard decision log (below). Publishing reads that log to know which files in `evidence/` the guard copied, and in what order;
  - `upload.json` (mode 600), the screenshot upload record: what was published and where, or why nothing was (see "Test-run screenshots on GitHub");
  - `render-images.json`, an In Test run's second render, the one with its screenshots; `verify-render.json` in a verify run's dir, the verification report's first render result, whose secret scan decided whether the Web lane's screenshots could be published;
  - `guard-config.json` and `guard-settings.json`, the config and the generated settings;
  - `guard-state/`, the per-session tab and selection state.
- **Decision log:** `logs/factory/browser-guard/<session-id>.jsonl` has every guard decision (tool, tab, URL, allow/deny and why), never the values typed into forms.
- **Retention:** both are reaped after 30 days.
- **Orphaned tabs:** a runner killed mid-run leaves its tabs open in Chrome in an orphaned tab group. Close them by hand.
- **The lease file:** `logs/factory/factory-signin.lease` exists only while a run holds the sign-in lease (see below).

### The sign-in lease

Supabase keeps one live magic-link token per user, so a newer mint invalidates an older link that hasn't been opened yet. The browser runner and the verification shell lane both sign in to previews as the same test account. The runner opens its link a minute or more after `browser_run` mints it. The shell lane runs detached and can overlap a `--browser` run. If the shell lane mints in that gap, the runner's link is dead and the run ends `signin-failed`, spending an attempt and adding a health strike. Two of those email you "browser checks failing", a false alarm.

So both minters take one lease first: `logs/factory/factory-signin.lease`, a small JSON file (`{owner, pid, acquiredAt, until, nonce}`) that `scripts/lib/browser-signin.mjs` hard-links into place, so of two minters only one gets it. Once a lease's `until` has passed, the next minter takes it over: it moves exactly that lease aside (putting back anything that changed since it read it) and links its own in. Release removes the lease the same way, and only for its owner. If the lease file can't be used at all (the directory isn't writable), minting goes ahead without it, as before the lease existed, with `browser-signin: WARNING: the sign-in lease couldn't be used …` in the log (the browser log, or the shell run's `supervisor.log`). That isn't a health strike.

- **The browser run** takes it as `browser:<kind>:<issue>:<sha12>` for `FACTORY_SIGNIN_LEASE_SEC` (300 s), and releases it when the runner is done, on every exit path. If the `--browser` process dies mid-run, its exit trap releases it too. If the lease is busy, the log says `the preview sign-in lease is held (<owner> until <time>); browser run (<kind>) deferred to the next --browser tick`, and nothing else happens. A verify lane stays pending and `--watch` queues it again.
- **The shell lane** takes it as `shell:<issue>:<sha12>` for 120 s, from its mint to the end of its curl exchange, and releases it at once (the hold covers the mint's 30-second request cap and the exchange's 45-second one, so it can't run out mid-exchange). While a browser run holds it, the lane polls every 5 s for at most 6 minutes, or until 2 minutes before the run's deadline if that comes first. Its `supervisor.log` says `the preview sign-in lease is held …; waiting up to <n>s`. If the lease is still held after that, the run goes on without a preview session: tests only, signed-in API steps listed as manual, and `signin-busy` as a coverage gap in the report. A run stopped during the wait records `stopped` instead.

**A stale lease file.** A lease nobody released, because a process was killed with `SIGKILL` or the Mac mini restarted mid-run, **expires on its own** at its `until`. After that the next minter takes it over; before then the factory removes it only for its owner. Until it expires, browser runs keep deferring and shell runs wait, then run without a session. To clear it early, check that no `--browser` run or shell-lane run is in flight (`pgrep -fl "factory-agent.sh --browser"`, `node scripts/lib/state-cli.mjs factory:verify-status`), then remove it:

```bash
cat logs/factory/factory-signin.lease        # who holds it, and until when
node scripts/lib/browser-signin.mjs release --lease-file logs/factory/factory-signin.lease --owner '<owner>'
# or, with nothing in flight: rm logs/factory/factory-signin.lease
```

### Health and triage

The runner never pauses the factory. `scripts/lib/browser-health.mjs` tracks results in `factory-state.json` → `browser`, and emails the operator after two bad results in a row and again on recovery. Check it with `node scripts/lib/state-cli.mjs factory:browser-status`.

| Result                               | Meaning                                                                                                            | Fix                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight:chrome-not-running`       | Chrome isn't running in the factory's macOS account. Another account's Chrome (fast user switching) doesn't count. | Open Chrome in the factory's account.                                                                                                                                      |
| `preflight:account-*`                | The account file is missing, not a file, readable by others (`mode`), or lacks a key.                              | Fix the file (setup step 4).                                                                                                                                               |
| `unavailable`                        | The pinned browser isn't connected, or Chrome tools failed before any step ran.                                    | Sign the Mac mini's Claude in Chrome extension back in.                                                                                                                    |
| `auth-expired`                       | The preview showed a Vercel (or other) login page.                                                                 | Open a preview in Chrome on the Mac mini and sign in to Vercel.                                                                                                            |
| `signin-failed`                      | The one-time sign-in link didn't sign the runner in on the preview.                                                | Check the preview uses dev Supabase and the test account still exists and is approved. (A branch without `/auth/test-sign-in` is skipped before the run; see below.)       |
| `preflight:signin-key-*`             | The dev sign-in key file is missing, not a file, or readable by others.                                            | Recreate it (setup step 5).                                                                                                                                                |
| `preflight:signin-mint`              | Dev Supabase refused to mint the link (bad key, unknown test account).                                             | The reason is in `logs/factory/factory-agent-browser-<date>.log`.                                                                                                          |
| `blocked`                            | The runner stopped on purpose: suspected injection in the scenario or a page. The report says why.                 | Read the report on the issue.                                                                                                                                              |
| `malformed` / `timeout` / `error`    | No parseable status line, the wall cap was hit, or claude exited non-zero.                                         | Read `runner-output.txt` and `logs/factory/factory-agent-browser-<date>.log`.                                                                                              |
| `guard-not-loaded` (runner disabled) | The guard's SessionStart record is missing: `claude -p` silently dropped the settings file. The runner is now off. | Check `guard-settings.json` against the current Claude Code settings schema, then `node scripts/lib/state-cli.mjs factory:browser-reset`. The runner stays off until then. |

**`unavailable` because the browser wasn't drawing.** The runner also stops with `browser=unavailable` when two screenshots in a row time out ("renderer may be frozen or unresponsive"): Chrome isn't drawing frames, so clicks don't reach the page either, although page text and scripts still work (rule 14 in `scripts/factory-browser-prompt.md`). The report says so. Ordinary display sleep doesn't cause it: runs with the display asleep take screenshots normally. On 2026-11-13 it followed the display going dark at 19:19, five minutes after it woke, so not by the 10-minute idle timer: a manual lock, display-off or input switch is the likely cause. Make sure the Mac mini's display is on its input, then let the next tick retry. Before this rule, such a run carried on, marked the interactive steps SKIP and reported `ok`/`pass` (#794's verify run).

**A Testing card's browser lane.** A verify run never comments on the issue; its result is the card's `verifyBrowser` (`node scripts/lib/state-cli.mjs factory:get-issue <n>`), and the verification report shows it as the Web row. The lane ends at once on anything waiting can't fix, so the card isn't held to the hold cap:

| `verifyBrowser` (after the SHA)                                                                                                                                 | Meaning                                                                                                                                                                                    | Fix                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `reported:<verdict>`                                                                                                                                            | It ran. The report has its table.                                                                                                                                                          | None.                                                                                                        |
| `unavailable:chrome-not-running`, `runner-disabled`, `account`, `signin-key`, `signin-mint`, `chrome`, `auth-expired`, `guard`, `session-limit`, `runner-start` | The operator's side, the same causes as the matching results above. The attempt was refunded.                                                                                              | Fix it as above. The card goes on to In Test without a browser verdict, and its In Test run is the fallback. |
| `unavailable:signin-failed`                                                                                                                                     | The sign-in link didn't sign the runner in.                                                                                                                                                | As `signin-failed` above.                                                                                    |
| `unavailable:runner-error`, `malformed`, `attempts`                                                                                                             | claude failed or printed no status line on the commit's last attempt, or the attempts were already spent.                                                                                  | Read `runner-output.txt` and the browser log.                                                                |
| `timeout`                                                                                                                                                       | The session hit `FACTORY_BROWSER_TIMEOUT_SEC`. The In Test run may use the attempt that's left.                                                                                            | Read the run's guard log for where it stalled.                                                               |
| `stale-branch`                                                                                                                                                  | The PR head predates `/auth/test-sign-in`. No session, no strike; the report says to update the branch.                                                                                    | **Update branch** on the PR.                                                                                 |
| `no-preview`                                                                                                                                                    | Still no successful preview deployment of the head `FACTORY_VERIFY_PREVIEW_WAIT_MIN` after the lane first found none (`waiting-preview:<iso>` until then).                                 | Check the Vercel integration; the In Test run runs once the preview exists.                                  |
| `skipped:not-web`, `browser-off`, `no-scenario`, `no-web-steps`, `already-run`                                                                                  | No `apps/web/` or `packages/shared/` change; `FACTORY_BROWSER` or `FACTORY_BROWSER_KINDS` leaves `verify` out; there's nothing to run; or the In Test run already reported on this commit. | None, unless the runner was meant to be on.                                                                  |

A PR that reaches the web app only through `packages/shared/` (which the web app imports) does get a verify run, but no In Test run: the In Test platforms read `apps/web/` only. So when its lane ends without a report, the verification report lists its Web steps for you to do by hand.

**No report on the issue, for a reason other than the above.** The issue gets no comment for `unavailable`, `auth-expired`, `signin-failed` or `malformed`. The first three are the operator's to fix and the email says so; a `malformed` run simply tries again on the next attempt. A scenario without a `### Web` section is recorded as done for that commit and never run. A PR whose head doesn't have `apps/web/src/app/auth/test-sign-in/route.ts` (a branch cut before ADR-0051 landed) is caught by a GitHub contents API check just before the sign-in link is minted: it gets no browser session and no health strike, and the issue gets one note per commit (`drafto-factory-browser-stale-branch:<sha12>`) asking for `main` to be merged into the branch with **Update branch** (not "Update with rebase", which diverges from the factory's worktree). The commit is recorded only once that note is posted, and the next head re-arms the check. If GitHub can't answer, or answers "No commit found", the run goes ahead. The factory fast-forwards its own worktree to the updated branch the next time it resumes the card (`worktree-cli.mjs add --fetch`). A withheld report means the runner's output matched a secret pattern. The posted notice names the pattern, and the full output stays in the run directory.

**Re-running a commit by hand.** After fixing the browser, re-arm the card for its current head, and the next `--watch` tick runs it:

```bash
node scripts/lib/state-cli.mjs factory:set-issue-field <n> browserRunAttempts ""
node scripts/lib/state-cli.mjs factory:set-issue-field <n> browserRunSha ""
node scripts/lib/state-cli.mjs factory:set-issue-field <n> verifyBrowser ""   # a card still in Testing
```

For a card still in Testing, `factory:verify-reset <n>` instead restarts its whole round, browser fields included.

### Weekly usage readout (ADR-0093)

Once a week, on Sunday evening, the runner reads the Vercel and Supabase usage dashboards, read-only, and posts the figures to Drafto's `POST /api/cron/hosted-usage`. `/admin/stats` then shows fast data transfer, CDN requests, function invocations, active CPU, Supabase egress and Supabase log ingestion against their plan limits ([product metrics → Hosting usage](../features/product-metrics.md#hosting-usage-egress-vercel)). The decision and its risk are in [ADR-0093](../adr/0093-weekly-hosting-usage-readout.md).

**How it is locked down.** This Chrome profile is signed in to the Vercel account with full control, so the run is a separate, read-only `usage` kind:

- **Pages.** The guard's config has `allowUrls` instead of an origin, and `navigate` must name one of the two pages exactly. A tab that ends up anywhere else, such as a login redirect, is quarantined.
- **Tools.** Only the tab tools, `navigate`, `read_page`, `get_page_text`, and `computer` for `screenshot`, `wait`, `scroll`, `scroll_to` and `zoom`. No click, hover, key, typing, form, network or console reader, and no capability.
- **Prompt.** It has its own, `scripts/factory-usage-prompt.md`. A login wall ends the run with `browser=auth-expired`, and the runner never signs in.
- **Other kinds.** `vercel.com` stays forbidden for them, and `drafto.eu` for every kind.

The runner prints the figures as shown. `scripts/lib/usage-readout.mjs` then turns them into numbers, refuses output that looks like a secret, posts the readout, and emails you on any failure. A run that stopped part-way, at one site's login wall for example, still posts what it read. The readout itself posts nothing to GitHub. If the script crashes, the factory's usual `factory-failure` issue is filed as for any mode.

It starts no session while the browser runner is disabled (the `guard-not-loaded` latch, cleared with `factory:browser-reset`). It is also skipped, with no email, while the factory is paused or in Phase A, like every other mode. Readings then go stale on `/admin/stats` after 8 days.

**Variables** (in the usage job's plist):

| Variable                      | Default                                               | Meaning                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FACTORY_USAGE_READOUT`       | `1`                                                   | `0` turns the readout off. `FACTORY_BROWSER=0` does too.                                                                                                                             |
| `FACTORY_USAGE_VERCEL_URL`    | `https://vercel.com/jakubanderwalds-projects/~/usage` | The Vercel team's usage page. Exact, with no query.                                                                                                                                  |
| `FACTORY_USAGE_SUPABASE_URL`  | (empty)                                               | The Supabase org's usage page, `https://supabase.com/dashboard/org/<org-slug>/usage`. Empty means Vercel only, and then the Supabase figures are neither expected nor emailed about. |
| `FACTORY_USAGE_POST_URL`      | `https://drafto.eu/api/cron/hosted-usage`             | Where the readout goes.                                                                                                                                                              |
| `FACTORY_USAGE_SECRET_FILE`   | `~/drafto-secrets/hosted-usage.env`                   | Holds `HOSTED_USAGE_SECRET=…`, mode 600. Only `usage-readout.mjs` reads it.                                                                                                          |
| `FACTORY_USAGE_READOUT_FORCE` | `0`                                                   | `1` runs even if a readout already ran in the last 20 hours, for a manual run.                                                                                                       |

**One-time setup** (on the Mac mini):

1. In the factory's Chrome profile, make sure you are signed in to vercel.com and supabase.com. Open the Supabase org's Usage page and copy its URL without any query: that is `FACTORY_USAGE_SUPABASE_URL`.
2. Make the route's secret, store it once on each side, and never print it:
   ```bash
   umask 077 && printf 'HOSTED_USAGE_SECRET=%s\n' "$(openssl rand -hex 32)" > ~/drafto-secrets/hosted-usage.env
   chmod 600 ~/drafto-secrets/hosted-usage.env
   ```
   Add the same value to the Vercel project as `HOSTED_USAGE_SECRET`, in the **Production** environment, and redeploy. The route answers 500 until it has it.
3. Install `~/Library/LaunchAgents/eu.drafto.usage-readout.plist`, modelled on `eu.drafto.factory.plist` with the same `EnvironmentVariables` (`PATH`, `FACTORY_PHASE`, …), plus:
   - `Label = eu.drafto.usage-readout`
   - `ProgramArguments = [/bin/bash, -c, <the same volume gate>; exec /bin/bash /Volumes/DraftoFactory/drafto-factory/scripts/factory-agent.sh --usage-readout --phase "$FACTORY_PHASE"]`
   - `EnvironmentVariables.FACTORY_USAGE_SUPABASE_URL = <the URL from step 1>`
   - `StartCalendarInterval`: four entries on Sunday (`Weekday 0`) at 20:00, 20:20, 20:40 and 21:00 local time. The readout shares `--browser`'s lock, so a slot where a factory browser run holds it exits quietly. The first slot that gets the lock runs, and the later ones skip it (the readout runs once per 20 hours).
   - Stdout and stderr under the primary checkout's `logs/launchd-usage-readout-*.log`.
4. Load it, then run it once by hand and check the result. A manual run skips the readout if one ran in the last 20 hours, so delete the marker first:
   ```bash
   launchctl load -w ~/Library/LaunchAgents/eu.drafto.usage-readout.plist
   rm -f /Volumes/DraftoFactory/drafto-factory/logs/usage-readout-last
   launchctl kickstart -k "gui/$(id -u)/eu.drafto.usage-readout"
   grep 'Usage readout' /Volumes/DraftoFactory/drafto-factory/logs/factory/factory-agent-browser-*.log | tail -1
   ```
   A good run logs `Usage readout (ran): {"posted":true,"resources":[…],"missing":[]}`, and `/admin/stats` then shows the readings under Platform limits.

**Triage.** Every failure emails you ("Drafto factory: weekly usage readout failed (…)"), with the reason:

- `runner preflight:chrome-not-running`: Chrome isn't running on the Mac mini.
- `runner preflight:disabled:guard-not-loaded`: an earlier browser session ran without the guard, so every browser run is off. Fix the cause, then run `node scripts/lib/state-cli.mjs factory:browser-reset` (see "Browser runner" above).
- `browser=auth-expired`: the profile is signed out of vercel.com or supabase.com. Sign back in by hand. The runner never signs in. Whatever it read before the wall was still posted, so the email says "incomplete" and names what wasn't read.
- `browser=unavailable`: the extension isn't connected, or the display was off and the browser wasn't drawing (see "Browser runner" above).
- `no figure could be read`, or "incomplete" with `Not read: …`: a dashboard redesign moved or renamed a figure. Update the field names in `scripts/factory-usage-prompt.md` (and the parser, `usage-readout.mjs`, if the format changed).
- `post failed: HTTP 401`: the two copies of `HOSTED_USAGE_SECRET` differ. `HTTP 500`: Vercel doesn't have it yet, or the insert failed (Sentry has the cause).
- `post skipped: secret file … must be mode 600`: `chmod 600` the file.

The guard's decisions for the run are in `logs/factory/browser-guard/`, like any browser run, and a denied navigation or click shows there. A missed week shows on `/admin/stats` too: after 8 days, every reading is marked stale, and Needs attention says when the readout last ran.

### Plan-stage browser probe

The runner's `plan` kind ([ADR-0071](../adr/0071-plan-stage-browser-probe.md); what you see on the issue is in [dark-factory.md](../features/dark-factory.md#plan-stage-browser-probe)). It's off by default. With `FACTORY_PLAN_PROBE=1`, the planner may request a probe on a web card in Plan Review:

1. **`--plan` stages a dir.** Before each plan or replan run, bash stages `logs/factory/plan-probe/<probeId>/`. The planner writes `checks.md`, an optional `headers.txt` and an optional `spike/` there.
2. **`--plan` checks and pushes.** After the run, `plan-probe.mjs finalize` validates and scans those files, builds one commit with git plumbing (`main` + spike + `apps/web/.factory-plan-probe`), pushes `factory/plan-probe-<n>` (never a PR) and records the round as `queued`.
3. **`--browser` runs it,** after any Testing or In Test candidate. It confirms the branch still points at the pushed SHA and waits for the preview. Then it records the allowlisted headers (bash, with the bypass secret), runs the runner with the planner's checks, posts one report comment and deletes the branch.
4. **The replan folds it in.** The replan sweep sees the unacked round and replans in place with the report. The planner appends an ack marker to the plan.

At the top of every `--plan` tick, in every phase, housekeeping ends what can't go on and deletes probe branches that no queued probe owns. Code: `scripts/lib/plan-probe.mjs` and the `plan_probe_*` functions in `scripts/factory-agent.sh`.

Logs:

- the `--plan` log has staging, finalize, housekeeping and folds (`Issue #<n>: plan probe …`, `plan probe housekeeping: <action>`);
- the `--browser` log has the preview wait, the header capture and the runner.

All the settings are in the launchd plist. A bad value warns in the launchd log and falls back.

| Setting                               | Default                              | What it does                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_PLAN_PROBE`                  | `0`                                  | The master switch and kill switch. It also needs `FACTORY_BROWSER=1` and `plan` in `FACTORY_BROWSER_KINDS`, which are the defaults. With either off, the next `--plan` tick cancels any queued probe (`cancelled:off`, nothing posted) and deletes its branch.                                                                                                  |
| `FACTORY_PLAN_PROBE_SPIKE`            | `1`                                  | `0` drops every spike, so probes build `main` plus the marker file only. A spike the planner still writes is reported as dropped (`spike-off`).                                                                                                                                                                                                                 |
| `FACTORY_PLAN_PROBE_MAX_ROUNDS`       | `2`                                  | Probe rounds per issue, 1–9. `factory:plan-probe-reset <n>` gives them back.                                                                                                                                                                                                                                                                                    |
| `FACTORY_PLAN_PROBE_PREVIEW_WAIT_MIN` | `15`                                 | Minutes from the push that a probe waits for a Preview deployment to appear. Once Vercel is building, it waits three times as long. Then the round ends as `failed:no-preview`.                                                                                                                                                                                 |
| `FACTORY_PLAN_PROBE_TIMEOUT_SEC`      | `900`                                | The planner's wall cap while a probe is available. The larger of this and `FACTORY_PLAN_TIMEOUT_SEC` wins.                                                                                                                                                                                                                                                      |
| `FACTORY_SECRETS_DIR`                 | `~/drafto-secrets`                   | The planner's files and the report are scanned for every secret in every file here (secret-named or token-shaped values, `name: value` passwords, long tokens; not emails, the allowlist or plain URLs), as well as the test password, the bypass secret and the dev service-role key. A file here that can't be read stops the probe (`rejected:secret-scan`). |
| `FACTORY_VERIFY_BYPASS_FILE`          | `~/drafto-secrets/vercel-bypass.env` | Shared with the verification shell lane (see "Pre-In-Test verification (Testing)" → "One-time setup", step 2). Header capture reads it even with `FACTORY_VERIFY=0`, and passes it to curl on stdin. Missing or unusable: the report notes `no-bypass-secret`.                                                                                                  |

Some limits are fixed in the script:

- 2 runner sessions per probe commit; a session that fails on the browser's side is refunded;
- 2 fold replans per round;
- 120 minutes from the push to the end of a round (`failed:expired`);
- 30 days' retention for probe dirs that no record names.

**State.** `node scripts/lib/state-cli.mjs factory:get-issue <n>` shows the card's `planProbe*` fields:

- `planProbeId`: `<issue>-<epoch>`. It names the dir `logs/factory/plan-probe/<planProbeId>/` and is part of the report and ack markers.
- `planProbeStatus`: one of these.
  - `queued`
  - `reported`
  - `failed:build`, `failed:no-preview`, `failed:push`, `failed:branch-moved`, `failed:expired` or `failed:runner`
  - `rejected:checks`, `rejected:secret`, `rejected:secret-scan` or `rejected:cap`
  - `cancelled:off` or `cancelled:left-plan-review`
  - `folded`, `folded:gave-up` or `folded:left-plan-review`
- `planProbeRound`: the rounds used so far.
- `planProbeSha` and `planProbeMainSha`: the probe commit, and the `main` commit it was built on.
- `planProbeQueuedAt`: the push time, which anchors the preview wait and the deadline.
- `planProbeAttempts`: `<sha>:<n>`, the runner sessions spent.
- `planProbeFoldAttempts`: `<probeId>:<n>`, the fold replans run.
- `planProbeStaging`: set only while a planner run is in progress.

The probe never touches `browserRunSha` or `browserRunAttempts`.

```bash
node scripts/lib/state-cli.mjs factory:get-issue <n>          # the planProbe* fields
node scripts/lib/state-cli.mjs factory:plan-probe-reset <n>   # forget the probe record and give back its rounds
```

`factory:plan-probe-reset` clears every `planProbe*` field. It refuses (`{"ok":false,"reason":"probe-queued"}`) while a probe is queued, because that probe's branch is still on GitHub. To stop a queued probe, set `FACTORY_PLAN_PROBE=0` and reload: the next `--plan` housekeeping cancels it and deletes its branch, and the reset then works. To get a new round, comment on the issue asking for browser checks.

**What a probe leaves behind.** The probe dir (mode 700) holds:

- the planner's `checks.md`, `headers.txt` and `spike/`;
- `probe.json`: what finalize decided, including the header paths, whether the spike was kept and why it was dropped;
- `headers.json`: the captured headers;
- `result.json`: how the round ended;
- `section.md`: the runner's rendered table;
- `report.md`: the report, as the planner reads it for the fold.

The runner's own run dir is `logs/factory/browser/issue-<n>-probe-<probeId>-<timestamp>/`. The probe commit stays reachable by SHA on GitHub after the branch is deleted, and so do its Vercel and GitHub deployment records.

**Triage:**

- **A probe stays `queued`.** The `--browser` log says what it waits for:
  - `plan probe preview is pending|building (<n> min); its browser run waits`: Vercel hasn't built it yet. If no deployment ever appears, check the Vercel project's Git integration and its Ignored Build Step setting. That setting decides whether Vercel builds a branch that has no PR. On 2026-11-09 it did. The round ends as `failed:no-preview` after the wait above.
  - `plan probe browser run skipped (<reason>)`, or an `unavailable` or `auth-expired` run: the browser is the problem. The causes and fixes are those in "Health and triage" above. The session is refunded, and the run tries again on later ticks.
  - `the preview sign-in lease is held …; plan probe run deferred`: another run holds the lease (see "The sign-in lease").
  - `no longer a Plan Review candidate`: the card left Plan Review or has a `factory-pause` or `support` label. A card in Planning waits for the rescue sweep.
  - Nothing for the issue at all: it's waiting its turn. Probes run after any Testing or In Test candidate, one browser run per tick.

  Whatever the cause, housekeeping ends the round as `failed:expired` 120 minutes after the push. Its report carries any headers already captured.

- **`failed:build`.** Vercel reported the probe's deployment as failed, usually because a spike doesn't compile. The factory can't read Vercel's build log, so the report and the planner only learn that the build failed. To see the log from an interactive session, take `planProbeSha` from `factory:get-issue <n>` and look up the deployment, which stays after the branch is deleted:

  ```bash
  gh api "repos/JakubAnderwald/drafto/deployments?sha=<planProbeSha>&environment=Preview" --jq '.[0].id'
  gh api "repos/JakubAnderwald/drafto/deployments/<id>/statuses" --jq '.[0].environment_url'
  npx vercel inspect <that url> --logs
  ```

- **`rejected:secret`.** A file the planner wrote matched a secret pattern. The patterns are the test password, the bypass secret, the dev service-role key, a value from `~/drafto-secrets`, and GitHub token, Anthropic key and private-key patterns. Nothing was pushed. The posted report only says the probe was rejected, and it is withheld entirely if the checks themselves held the match. The files stay in the probe dir: read them there to see what matched, and treat it as possible prompt injection through the issue. The round counts against the cap; `factory:plan-probe-reset <n>` gives it back.
- **An orphan `factory/plan-probe-*` branch** (after a reset, a crash or a killed tick). The next `--plan` housekeeping deletes it, under a lease on the SHA it saw, and logs `plan probe housekeeping: orphan-deleted`. To delete it by hand:

  ```bash
  git ls-remote origin 'refs/heads/factory/plan-probe-*'
  git push --force-with-lease=refs/heads/factory/plan-probe-<n>:<sha> origin :refs/heads/factory/plan-probe-<n>
  ```

- **Headers missing from the report.** There are four likely causes:
  - The planner asked for none: there's no `headers.txt`.
  - Its paths were rejected: the report's note says `The headers file was ignored (…)`.
  - The capture failed: the `--browser` log says `capturing #<n>'s plan probe headers failed`.
  - Every path shows a redirect to `off-origin`: curl got Vercel's login wall. With the note `no-bypass-secret (<problem>)`, the bypass file is missing or unusable; run `node scripts/lib/verify-lane.mjs bypass-check`. Without that note, the secret itself is wrong, so regenerate it in the Vercel dashboard.

  Headers are captured once per probe, before the browser run.

- **`signin-failed` in a probe report.** This is the probe's own result, not a health strike. Most often the spike changed the middleware or auth. If the probe had no spike, check the test account, as for `signin-failed` in "Health and triage".
- **`failed:runner`.** Two runner sessions on the probe commit timed out, errored or printed no status line. Read the run dir's `runner-output.txt` and the `--browser` log.
- **`rejected:secret-scan`.** The factory couldn't read every file the scan needs: the account file, the sign-in key file, the bypass file (when it exists) or a file in `~/drafto-secrets`. Nothing was pushed. Fix the file's mode or path (`ls -l ~/drafto-secrets`), then `factory:plan-probe-reset <n>` if the round should come back.
- **A probe that never started after a killed tick.** A planner run that dies before bash settles its staging leaves only the staging dir, which the next `--plan` housekeeping drops (`staging-dropped` in the log). No round is spent; the planner requests the probe again on its next run.
- **`folded:gave-up`.** The planner didn't append the ack in 2 fold replans; the `--plan` log has a WARNING. The report is still on the issue, so read it yourself, or comment to start a replan.
- **Turning spikes off.** Set `FACTORY_PLAN_PROBE_SPIKE=0` in the plist and reload. Probes then run on `main`'s own code only.

## Pre-In-Test verification (Testing)

A factory-owned **Testing** column between In Review and In Test ([ADR-0053](../adr/0053-pre-in-test-verification-stage.md), [factory-verification.md](../features/factory-verification.md)). With `FACTORY_VERIFY=1`, a converged In Review card moves to Testing instead of In Test. The scenario is written and the betas dispatched there. The Testing sweep in `--watch` works the verification lanes, then moves the card to In Test with one report comment. Verification is evidence, never a gate. Three lanes are built: the **shell lane** (see "The shell lane" below), the **browser lane**, the browser runner's `verify` kind (see "Browser runner (Claude in Chrome)" → "A Testing card's browser lane"), and the **device lane** (see "The device lane" below), which is off by default. The card is promoted once every lane has a result, or at the hold cap. The device lane holds it only `FACTORY_VERIFY_DEVICE_WAIT_MIN`.

### Settings

All in the launchd plist. A bad value warns in the launchd log and falls back to its default.

| Setting                            | Default                              | What it does                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_VERIFY`                   | `0`                                  | The master switch and kill switch. Off: cards go straight to In Test, and the Testing sweep only drains the column.                                                                                                                                                                                                                                                                                   |
| `FACTORY_VERIFY_LANES`             | `shell,browser`                      | Which lanes run (`shell`, `browser`, `device`). Unknown words are dropped. Set it empty for no lanes: scenario and betas still move to Testing, and the card is promoted on the next sweep.                                                                                                                                                                                                           |
| `FACTORY_VERIFY_ONLY_LABEL`        | (none)                               | Canary: only issues with this label enter Testing. A label the factory can't match exactly (comma, newline, leading or trailing blank) turns verification off.                                                                                                                                                                                                                                        |
| `FACTORY_VERIFY_HOLD_MAX_MIN`      | `60`                                 | Longest stay in Testing, from the start of the card's round. At the cap the card is promoted, lanes still running or not.                                                                                                                                                                                                                                                                             |
| `FACTORY_VERIFY_SHELL_TIMEOUT_MIN` | `30`                                 | Per-run cap for the shell lane: install, sign-in, the claude session and key revocation.                                                                                                                                                                                                                                                                                                              |
| `FACTORY_VERIFY_MAX_ATTEMPTS`      | `2`                                  | Shell-lane runs per commit. A run the factory stops itself gives its attempt back: a push, a closed PR, a session limit, verification switched off, or the factory moving the card out of Testing (`verify_shell_stop`). A run housekeeping kills because the card lost `status:testing` some other way, such as a drag by hand, keeps it spent, so a label that disagrees with the board can't loop. |
| `FACTORY_VERIFY_BOUNCE_MAX`        | `2`                                  | Hand-backs to In Review per commit for open review threads (the other hand-back reasons don't count). `0` never hands back for threads. Past it the card carries on, and `--release` still refuses the merge.                                                                                                                                                                                         |
| `FACTORY_VERIFY_PREVIEW_WAIT_MIN`  | `10`                                 | How long the lanes wait for the commit's Vercel preview. After that the shell lane runs without one (tests only, API steps listed as manual), and the browser lane, which counts from when it first found none (GitHub errors don't count), ends as `no-preview`.                                                                                                                                     |
| `FACTORY_DEV_INSPECT`              | `0`                                  | The shell lane's `dev-inspect` wrapper: read-only checks of the factory test account's data on dev ([ADR-0073](../adr/0073-factory-verification-data-checks-live-tests-uploads-admin-js.md)). Reads `FACTORY_BROWSER_SIGNIN_KEY_FILE` and `FACTORY_BROWSER_ACCOUNT_FILE` in its own process.                                                                                                          |
| `FACTORY_VERIFY_LIVE_TESTS`        | `0`                                  | The shell lane's live tests: before the session, the supervisor runs the scenario's `### Live tests` at the PR head, and `live-tests` shows the session only filtered result lines: test names and outcomes, counts and durations (ADR-0073). Needs the key file and `apps/web/.env.local` in the factory checkout (dev URL and anon key).                                                            |
| `FACTORY_VERIFY_BYPASS_FILE`       | `~/drafto-secrets/vercel-bypass.env` | The Vercel protection-bypass secret for the shell lane's curl against previews. A missing or unusable file (not mode 600, no key) means the lane runs without it, and the report says so.                                                                                                                                                                                                             |
| `FACTORY_VERIFY_DEVICE`            | `0`                                  | The device lane's switch ([ADR-0106](../adr/0106-factory-device-lane.md)). It runs only when this is `1` **and** `device` is in `FACTORY_VERIFY_LANES` (it isn't in the default list). Off, the iOS / Android row reads as before. See "The device lane" below.                                                                                                                                       |
| `FACTORY_VERIFY_DEVICE_WAIT_MIN`   | `30`                                 | How long a Testing card waits for its device run, from the start of its round. After that a run still going no longer holds the card: the report's device rows read "running — results follow" and the run posts a follow-up comment when it ends. The hold cap still wins.                                                                                                                           |
| `FACTORY_DEVICE_ACCOUNT_FILE`      | (none)                               | The device lane's own **dev** account, `E2E_TEST_EMAIL=` and `E2E_TEST_PASSWORD=`, mode 600. Without a usable one the lane doesn't start (`unavailable:no-account`). The reports are scanned for its password.                                                                                                                                                                                        |

### One-time setup

1. **Board and label.** Follow "Changing the board's Status options": `scripts/setup-factory-labels.sh` adds `status:testing`, and `scripts/setup-factory-board.sh` adds the Testing option without losing any card's Status. Until both exist, the factory logs a WARNING once per tick and sends cards straight to In Test.
2. **Bypass secret** (needed by the shell lane's API checks). In the Vercel dashboard, go to the project → **Settings** → **Deployment Protection** → **Protection Bypass for Automation**, and create a secret. **Never use `vercel curl`**: it creates a bypass secret of its own without telling you. Then, on the Mac mini:

   ```bash
   read -rs VERCEL_SECRET
   (umask 077 && printf 'VERCEL_AUTOMATION_BYPASS_SECRET=%s\n' "$VERCEL_SECRET" > ~/drafto-secrets/vercel-bypass.env)
   unset VERCEL_SECRET
   chmod 600 ~/drafto-secrets/vercel-bypass.env
   cd /Volumes/DraftoFactory/drafto-factory && node scripts/lib/verify-lane.mjs bypass-check
   ```

   `read -rs` keeps the secret out of the shell history and off the screen; paste it and press Enter. `bypass-check` prints `{"ok":true,…}` (exit 0) when the file is a regular file, mode 600 or stricter, with a well-formed `VERCEL_AUTOMATION_BYPASS_SECRET`; otherwise `ok:false` and the `problem` (`missing`, `mode`, `no-key`, `empty`, `malformed`), exit 2. It never prints the value. The report scans every lane's output for the secret and for the bypass header names, and withholds a lane that prints either.

3. **Data checks and live tests (optional, ADR-0073).** Both need `~/drafto-secrets/dev-supabase-admin.env` (already there for sign-in links) and the factory checkout's `apps/web/.env.local` with the dev URL and anon key. Turn them on one at a time: `FACTORY_DEV_INSPECT=1`, watch a Testing card's report for `dev-inspect` results, then `FACTORY_VERIFY_LIVE_TESTS=1`. A quick check from the factory checkout, with a run dir of a finished run (its `private/` is gone, so expect "isn't available in this run"): `node scripts/lib/verify-lane.mjs dev-inspect --run-dir <dir> -- whoami`.
4. **Canary.** Create the label once (`gh label create factory-verify --repo JakubAnderwald/drafto`), set `FACTORY_VERIFY=1` and `FACTORY_VERIFY_ONLY_LABEL=factory-verify` in the plist, and reload. File a small web issue with that label (`gh issue create --project "Drafto Factory" … --label factory-verify`), then watch it go In Review → Testing → In Test. Drop the label gate after several clean runs.

### What a round looks like

- **Entry** (`verify_enter`): the card moves to Testing first. Then `verifySha`, `verifyStartedAt` and `verifyCrNote` are set, and `lastFeedbackAt` too if it was empty. Betas are dispatched (from the plain platforms) and the scenario is written with the Testing title and the verification platforms, where a `packages/shared/` change counts as web (`derive-platforms --verify`), so a shared-only PR gets the `### Web` section the browser lane walks. Attempts and the CodeRabbit run cap aren't reset here; that happens at the move to In Test. If the move to Testing fails, the card is promoted to In Test as before.
- **The sweep** (`verify_sweep`, every tick, oldest issue first) logs `Issue #N: Testing → <action> (<reason>)`. `verify-decide.mjs` picks the action:

| Action       | Reasons                                                                  | What happens                                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skip`       | `pr-merged`, `pr-closed`, `pr-unknown`                                   | Nothing. The card waits for you.                                                                                                                                                                                                                                                                                                        |
| `promote`    | `verification-off`, `feedback`, `lanes-done`, `hold-cap`, `decide-error` | Report composed, card moved to In Test, report posted once, attempts and `crCliRuns` reset.                                                                                                                                                                                                                                             |
| `hand-back`  | `head-moved`, `ci-red`, `not-reviewed`, `threads`                        | Back to In Review (a `threads` one also bumps `verifyBounces`), one comment per commit and reason (`drafto-factory-verify-handback:<sha12>:<reason>`).                                                                                                                                                                                  |
| `init`       | `no-round`, `new-round`                                                  | A round starts for the head (a card dragged in, or the revision no-op path). Betas are checked; the scenario is written if this commit has none.                                                                                                                                                                                        |
| `wait`       | `ci-pending`, `threads-unknown`, `head-unknown`                          | Nothing this tick. The hold cap still applies.                                                                                                                                                                                                                                                                                          |
| `work-lanes` | `lanes-pending`                                                          | Betas re-checked, and the lanes started or polled: the shell lane (`verify_shell_work`) starts its run; the browser lane (`verify_browser_work`) queues a `verify` candidate for `--browser`, or ends at once (no web changes, runner off); the device lane (`verify_device_work`) starts its run, or ends at once (no mobile changes). |

- **The report** is composed into `logs/factory/verify/report-<issue>-<sha>.md`, with the scenario it was built from beside it, and kept for 30 days. If posting fails, the In Test sweep tries again 10, 20 and 30 minutes after it was composed (4 failed attempts per commit in all, counted in `verifyReportPosts`). If the composer fails, a minimal "INCOMPLETE: couldn't be composed" notice goes out instead, with the same markers.

### The shell lane

A detached claude session that runs the scenario from a terminal: targeted tests, the scenario's command steps, the macOS `--preflight` (ADR-0043) and API / MCP checks against the commit's preview. `scripts/lib/verify-lane.mjs`, guarded by `scripts/lib/verify-guard.mjs`, prompt `scripts/factory-verify-prompt.md`. It never blocks a tick: `--watch` starts it (`verify_shell_work`), collects it at the top of the next ticks (`verify_shell_housekeeping`), and stops it when the card leaves Testing (`verify_shell_stop`).

- **One run at a time, factory-wide** (the `verify` ledger in the state file), under `nice -n 10`. A start is refused (and retried next tick) under memory pressure (`kern.memorystatus_vm_pressure_level` ≥ 2), with less than `FACTORY_MIN_FREE_DISK_GB` free, or while another card's run holds the lane; the card's shell row then reads `deferred:<why>`, which the report shows as `skipped: <why>` if the hold cap comes first. A run never outlives the hold cap: its deadline is cut to it, and none starts with less than 10 minutes of the round left (`hold-cap-near`).
- **Where it runs:** a fresh detached worktree, `worktrees/verify-<issue>-<sha12>`, with `node_modules` cloned from the factory checkout and `pnpm install --frozen-lockfile --prefer-offline`. Never the card's slot worktree (its `.env.production` files), and no env file copied in. The PR's own code (its install scripts, the tests the lane runs) runs with the factory user's access, as it does in the implement and fix stages: the guard governs what the model asks for, not what the PR's code does.
- **What it may do:** `claude -p --no-chrome --strict-mcp-config --setting-sources "" --settings <guard> --permission-mode dontAsk --tools Bash,Read,Grep,Glob`. Never `--chrome`, never `--dangerously-skip-permissions`. The environment is an allowlist (no GH, Vercel or Supabase tokens), `GH_CONFIG_DIR` points at an empty directory, and the guard denies `gh`, `claude`, `vercel`, `supabase`, git writes, installs, releases, `node scripts/…`, secrets paths and any curl but http(s) to localhost. See [claude-code-hooks.md](claude-code-hooks.md#the-verification-lanes-guard).
- **The preview, only through `preview-curl`:** a wrapper on the session's PATH that pins the commit's preview origin and reads the bypass header and the test account's session cookie from `private/curl.cfg` (mode 600), or with `--signed-out` the bypass header alone from `private/curl-signed-out.cfg` (mode 600, no cookie jar). The secret is never in the prompt, the environment or a command line, so it stays out of the transcript. That isn't a wall against a session that sets out to read it ([claude-code-hooks.md](claude-code-hooks.md#the-verification-lanes-guard)). The session comes from the same one-time link the browser runner uses (`browser-signin.mjs`), exchanged by the supervisor with curl. A branch that predates `/auth/test-sign-in` gets no session; the report says so.
- **The sign-in lease:** the supervisor mints under the lease it shares with the browser runner (`verify_shell_work` passes `--signin-lease-file`, kept in `meta.json`). It holds the lease for 120 s and releases it right after the exchange. While a browser run holds it, the supervisor waits, polling every 5 s, for at most 6 minutes and never into the run's 2-minute cleanup reserve. A stop or SIGTERM ends the wait at once (`facts.session` = `stopped`). Still held after that: no session (`facts.session` = `signin-busy`), tests only, and the report lists the gap. See "Browser runner (Claude in Chrome)" → "The sign-in lease".
- **API keys:** the lane may create one, named with its run's tag (`factory-shell-<issue>-<sha7>-<HHMMSS>…`). After the session the supervisor revokes the keys carrying that tag, plus any `factory-shell-` key created before the run started (left by a run that was killed before its own cleanup). It never touches a newer run's key, so a stopped run still cleaning up can't break the next card's MCP checks.
- **Results** (`verifyShell` = `<sha>:<state>`): `reported:<verdict>`; `timeout`; `unavailable:install|guard|error|no-result|lost|claude-missing|…` (the last three only once attempts are spent; before that `retry:<why>`, which the report shows as `skipped: … and the hold cap came before another attempt` if the cap comes first); `skipped:attempts`; `deferred:session-limit` (the factory is paused until the reset and the attempt refunded). A run whose guard didn't load (no SessionStart canary, tool calls with no guard record, or a guard log that can't be read) is `unavailable:guard` and **pauses the lane for 24 hours**: find out why, then `node scripts/lib/state-cli.mjs factory:verify-resume`.
- **Kills:** housekeeping SIGTERMs the run's process group when the PR's head moves, the PR closes or the card loses `status:testing`, and once it is 10 minutes past its deadline (SIGKILL at 20; recorded as `timeout`). A reservation whose tick died before the supervisor was attached is released after 5 minutes, and a supervisor found running for it (by its run id in the process table) is stopped first.

Each run has a directory, `logs/factory/verify/<issue>-<sha12>-<timestamp>/` (mode 700, reaped after 30 days):

| File                                                          | What it is                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `meta.json`                                                   | What `start` decided: worktree, deadline, session id, binaries, secret-file **paths** (never values), lane facts |
| `prompt.md`, `bundle.json`                                    | The prompt and the bundle (`factory_verify_shell`: the scenario sections, files, platforms, preview origin)      |
| `guard-config.json`, `guard-settings.json`                    | The guard's config and the `--settings` file; `guard/<session>.jsonl` is its decision log                        |
| `supervisor.log`, `install.log`                               | The supervisor's own log and the pnpm output                                                                     |
| `shell-output.txt`, `claude-stderr.log`                       | The session's report (what the report composer reads) and claude's stderr                                        |
| `bin/preview-curl`                                            | The wrapper                                                                                                      |
| `exit.json`                                                   | How it ended: exit code, timeout, termination, install / session / bypass facts, guard counts, keys revoked      |
| `private/` (`curl.cfg`, `curl-signed-out.cfg`, `cookies.txt`) | Only while the run is live. Removed at the end, and by housekeeping if the supervisor was killed                 |

To stop a run by hand: `node scripts/lib/state-cli.mjs factory:verify-status` for its run id, then `factory:verify-finish <runId> --refund attempt`. Housekeeping removes its worktree on the next tick.

### The device lane

The third lane ([ADR-0106](../adr/0106-factory-device-lane.md)), off by default. A node supervisor, `scripts/lib/device-lane.mjs`, builds a **dev-backed** app from the PR head with the JS bundle embedded, then runs the repo's Maestro flows on a dedicated headless Android emulator and a dedicated iOS simulator, one platform at a time. No claude session touches a device: the shell lane's guard still denies `maestro`, `adb`, `emulator`, `xcrun`, `xcodebuild` and `gradle`. It's evidence, never a gate, and it never moves a card.

- **When it runs:** a Testing card whose PR changes `apps/mobile/` (except `apps/mobile/store/`) or `packages/shared/`. Any other card's device row reads `skipped:not-applicable` at once, so it never waits on another card's run. `--watch` starts the run (`verify_device_work` → `device-lane.mjs start --trigger testing`), collects it at the top of the next ticks (`verify_device_housekeeping`, step 1d) and stops it (`verify_device_stop`).
- **One run at a time,** under its own pid lock, `<volume>/drafto-device.lock`, and a ledger, `logs/factory/device/ledger.json`. **Betas come first:** a run doesn't start while a beta build root is locked, under memory pressure, or with the build volume under `FACTORY_DEVICE_MIN_FREE_GB` free (or the internal disk under `FACTORY_MIN_FREE_DISK_GB` + 5). The card's device row then reads `deferred:<why>` (`busy`, `beta-build`, `memory`, `disk`) and the next tick tries again. Betas never wait for the device lane: a beta that starts while a device run is going makes the run yield. The supervisor sees the live beta lock, shuts its device down and ends as `retry:beta-build`; the attempt is given back and the lane starts again once the betas are done.
- **How long a card waits:** `FACTORY_VERIFY_DEVICE_WAIT_MIN` from the start of its round, never past `FACTORY_VERIFY_HOLD_MAX_MIN`. After that the card is promoted when the other lanes are done. A run still going reads "running — results follow in a separate comment", with no device screenshots; a lane that hadn't started, or has to run again, says why (`--device-state`). On most mobile cards the betas are still building at that point, so the run hasn't started: `verify_device_intest_work` (in `--watch`, after the In Test feedback sweep) keeps starting it while the card is in In Test, for the head its round was for, until its state is terminal, the head moves or the card leaves In Test. It continues only a round promoted for that head (`verifyPromotedSha`, written at the move to In Test, so a report that never posted doesn't strand the run), skips a card with actionable feedback pending or whose comments can't be read that tick, and adopts a run the ledger has for the head that the state never recorded (a tick that ended between `start` and the write) instead of starting another. It picks up `deferred:*` and `retry:*`, and no record at all: a round that starts with the lane off or not built records `skipped:lane-off` / `skipped:not-built`, so a missing record means the lane was on but nothing ran yet, and switching the lane on starts nothing for cards already past Testing. In Testing those two records are re-derived from the settings, and a round that starts with the lane on clears them. The results then arrive as the follow-up comment, which is the normal path.
- **The follow-up comment:** when a run ends (finished, timed out or failed), housekeeping posts one comment with its results and its screenshots, from the factory's identity. It carries `<!-- drafto-factory-device-report -->` and `<!-- drafto-factory-device-sha:<sha>:<runId> -->`, so the feedback detectors ignore it and the card stays where it is. The run's commit must still be the open PR's head, checked before the screenshots are published and again last, after the comment lookup, just before posting. The comment and its screenshots are scanned for the password of the account file the run recorded in its `meta.json` (`FACTORY_DEVICE_ACCOUNT_FILE` only when it recorded none). A stale run posts nothing (`deviceReportPosted` = `<sha>:<runId>:stale`). A stopped or retried run posts nothing either. The round's own run waits while no verification report has been posted for its commit and the card is in Testing or In Review (after a hand-back) on the board (`factory-project.mjs item-status`, not the `status:*` label a drag by hand leaves behind; a board that can't be read keeps it waiting): that report carries its results. Once it is posted showing them, no follow-up is needed (`:in-report`). A report composed with them that couldn't be posted holds the follow-up too, while the card is in In Test and the sweep's retry still has attempts left, so the results never go out twice. A report without them, the card anywhere else, or `FACTORY_VERIFY_HOLD_MAX_MIN` + 60 minutes since the run finished releases it and posts the follow-up; a head that moved releases it as stale. A follow-up posted before the report (the card held in Testing past that, say by `factory-pause`) isn't repeated in it: the device rows point at the comment.
- **Stops:** the factory stops a run when it hands the card back to In Review (from Testing, or from In Test for a merge conflict), on feedback (in Testing or In Test), or with verification switched off while the card is in Testing, and gives its attempt back; the report then doesn't promise its results, and the run is retried if the card comes back to Testing on the same commit. A stop by hand (`device-lane.mjs stop`), a signal, or the card dragged out of Testing and In Test sticks (`skipped:stopped-<why>`). Promotion at the hold cap or with the other lanes done lets it run on. Housekeeping also stops a run whose PR head moved, whose PR closed or merged, whose card left Testing and In Test, or that passed `FACTORY_DEVICE_RUN_MAX_MIN`. Switching `FACTORY_VERIFY` off doesn't stop a run whose card is already in In Test: it finishes and posts its follow-up. Stop it by hand (`device-lane.mjs stop --issue <n> --reason stop`) if it must not.
- **Results** (`verifyDevice` = `<sha>:<state>`): `running` (not terminal: it holds the card until the wait is over); `reported:pass|fail|error`; `timeout`; `unavailable:<why>` (`no-account`, `<bin>-missing`, `error`, `lost`); `skipped:not-applicable|attempts|lane-off|not-built|stopped-<why>`; `deferred:<why>`; `retry:<why>` (a supervisor lost, a run that gave way to a beta build or memory pressure, or `retry:stopped-<why>` for the factory's own stops: the lane starts again, in Testing or from In Test). Attempts per commit (`FACTORY_DEVICE_MAX_ATTEMPTS`) are counted in the ledger, not in the factory state.

- **On demand: the `factory-device-run` label.** Add it to a card in Testing or In Test to run the device lane on the card's PR head now (`verify_device_ondemand_work`, in `--watch` right after the In Test device pass). A comment can't ask for this, because an owner comment on an In Test card is feedback and rolls the card back. The label works whatever `FACTORY_VERIFY_DEVICE` says (the lane only has to be built), allows one run past the per-commit attempt cap (`--force-attempt`), and never moves the card. The factory removes the label once the run has started (`deviceRunRequest` = `<sha>:<runId>`), and the run ends with the same follow-up comment. While the lane is busy, a beta builds, memory is short, or git, GitHub or the spawn failed for a moment, the label stays and each tick tries again (`<sha>:waiting:<why>`, logged once per reason). If a run for the head is already going, or the card is in Testing and its verification round runs the lane for that head anyway (`<sha>:round`), the label just comes off. If the label won't come off after a start (`<sha>:<runId>:label-stuck`), later ticks only retry removing it, never a second run. If the run can't happen (no device-lane account, a missing tool, no open PR, a PR that changes nothing the app is built from), the factory says why in a comment, records `<sha>:refused` (`none:refused` before the head is known) and removes the label. An on-demand run that is cut off before it finishes (a hand-back, feedback, a moved head, a beta that needed the machine) posts a short comment saying so, once (`deviceReportPosted` = `<sha>:<runId>:cut-off`); add the label again to rerun it. Paused, `driver:interactive` and `support` cards are skipped and keep the label. Run `scripts/setup-factory-labels.sh` once to create it.

#### Device-lane settings

`FACTORY_VERIFY_DEVICE`, `FACTORY_VERIFY_DEVICE_WAIT_MIN` and `FACTORY_DEVICE_ACCOUNT_FILE` are in the table above. `device-lane.mjs` reads the rest itself (`readDeviceKnobs`). A bad value falls back to its default.

| Setting                            | Default                                                 | What it does                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_DEVICE_VOLUME`            | `$DRAFTO_BUILDS_VOLUME_DIR` or `/Volumes/DraftoFactory` | The volume for the build roots (`drafto-device-{android,ios}`), the lock and `drafto-device/` (AVD, Gradle home, keystore).                       |
| `FACTORY_DEVICE_BUILD_TIMEOUT_MIN` | `45`                                                    | Cap per build (Gradle or xcodebuild).                                                                                                             |
| `FACTORY_DEVICE_FLOW_TIMEOUT_MIN`  | `20`                                                    | Cap per Maestro flow.                                                                                                                             |
| `FACTORY_DEVICE_BOOT_TIMEOUT_MIN`  | `10`                                                    | Cap for the emulator or simulator to boot.                                                                                                        |
| `FACTORY_DEVICE_RUN_MAX_MIN`       | `150`                                                   | Cap for a whole run. Housekeeping kills a run past it (`timeout`).                                                                                |
| `FACTORY_DEVICE_MAX_ATTEMPTS`      | `2`                                                     | Runs per commit. A run stopped for a reason that isn't the card's (head moved, PR closed, a beta build, memory pressure) gives its attempt back.  |
| `FACTORY_DEVICE_MIN_FREE_GB`       | `25`                                                    | Free space the build volume needs before a run starts. The internal disk needs `FACTORY_MIN_FREE_DISK_GB` + 5 (the simulator's data lives there). |
| `FACTORY_DEVICE_JAVA_HOME`         | the newest JDK 17–24 found, else `java_home -v 17+`     | The JDK for Gradle (17–24) and Maestro (17+). Android Studio's JBR is a good choice.                                                              |
| `FACTORY_DEVICE_JDK_PATHS`         | (none)                                                  | Extra JDK homes, comma-separated, offered to Gradle as toolchains (the React Native plugin asks for 17; auto-download is off).                    |
| `FACTORY_ANDROID_SDK`              | `~/Library/Android/sdk`                                 | The Android SDK (`emulator`, `adb`, `avdmanager`).                                                                                                |
| `ANDROID_AVD_HOME`                 | `<volume>/drafto-device/avd`                            | Where the `drafto-factory` AVD lives.                                                                                                             |
| `FACTORY_DEVICE_KEYSTORE`          | `<volume>/drafto-device/debug.keystore`                 | The factory debug keystore the Android build is signed with. Never the release keystore.                                                          |
| `FACTORY_DEVICE_KEEP_RAW`          | `0`                                                     | `1` keeps a run's `private/` (raw JUnit and Maestro output) for debugging. Housekeeping still reaps it once the run is gone.                      |

#### One-time setup

On the Mac mini, from the factory checkout (`/Volumes/DraftoFactory/drafto-factory`):

1. **Volume dirs and the debug keystore:**

   ```bash
   mkdir -p /Volumes/DraftoFactory/drafto-device/{avd,gradle}
   keytool -genkeypair -v -keystore /Volumes/DraftoFactory/drafto-device/debug.keystore \
     -storepass android -alias androiddebugkey -keypass android \
     -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
   ```

   These are Android's standard debug-keystore values, not secrets: the APK only ever goes to the lane's emulator.

2. **The AVD** `drafto-factory`, on android-35 `google_apis` arm64 (not a Play Store image: those block `adb root`), with a `clean` snapshot:

   ```bash
   export ANDROID_AVD_HOME=/Volumes/DraftoFactory/drafto-device/avd
   SDK=~/Library/Android/sdk
   "$SDK/cmdline-tools/latest/bin/avdmanager" create avd -n drafto-factory \
     -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_6
   "$SDK/emulator/emulator" -avd drafto-factory -port 5580 -no-window -no-audio -no-snapshot-load &
   "$SDK/platform-tools/adb" -s emulator-5580 wait-for-device
   # once `adb -s emulator-5580 shell getprop sys.boot_completed` prints 1:
   "$SDK/platform-tools/adb" -s emulator-5580 emu avd snapshot save clean
   "$SDK/platform-tools/adb" -s emulator-5580 emu kill
   ```

   The lane boots it with `-port 5580 -snapshot clean -no-snapshot-save`, so the operator's `emulator-5554` is never touched and the snapshot stays clean.

3. **The simulator** `drafto-factory-iphone`, driven by `simctl` alone (Xcode 27 has no Simulator.app), and its UDID in `logs/factory/device-config.json`:

   ```bash
   UDID=$(xcrun simctl create drafto-factory-iphone \
     com.apple.CoreSimulator.SimDeviceType.iPhone-16 com.apple.CoreSimulator.SimRuntime.iOS-27-0)
   printf '{"iosSimUdid":"%s"}\n' "$UDID" > logs/factory/device-config.json
   ```

   Pick any installed device type and runtime (`xcrun simctl list devicetypes`, `xcrun simctl list runtimes`). The lane erases it before each run.

4. **The dedicated dev account.** Create an account on **dev** (`huhzactreblzcogqkbsd`, never prod) for the device lane alone, so a sign-out on a device never ends the browser lane's session, and approve it. Then:

   ```bash
   read -r EMAIL; read -rs PASSWORD
   (umask 077 && printf 'E2E_TEST_EMAIL=%s\nE2E_TEST_PASSWORD=%s\n' "$EMAIL" "$PASSWORD" \
     > ~/drafto-secrets/device-account.env)
   unset EMAIL PASSWORD
   chmod 600 ~/drafto-secrets/device-account.env
   ```

   The password reaches Maestro only as `MAESTRO_E2E_TEST_PASSWORD` in its environment, never on a command line, and no claude session sees it.

5. **The plist:** add `FACTORY_DEVICE_ACCOUNT_FILE=~/drafto-secrets/device-account.env`, `FACTORY_DEVICE_JAVA_HOME` (for example Android Studio's JBR, `/Applications/Android Studio.app/Contents/jbr/Contents/Home`), `FACTORY_ANDROID_SDK`, `ANDROID_AVD_HOME=/Volumes/DraftoFactory/drafto-device/avd`, and `FACTORY_VERIFY_DEVICE=0` for now. Reload the agent.

6. **Selftest:**

   ```bash
   node scripts/lib/device-lane.mjs selftest                               # read-only checks, both platforms
   node scripts/lib/device-lane.mjs selftest --build --platform android    # builds origin/main, boots, runs one flow
   node scripts/lib/device-lane.mjs selftest --build --platform ios
   ```

   Plain `selftest` prints one PASS / FAIL line per check: the volume, the binaries, the JDKs, the AVD, the keystore, the simulator UDID, free disk, memory pressure, `apps/mobile/.env` being dev, the account file, and no beta build or device run holding its lock. `--build` runs in the foreground, holding the device lock: it builds `origin/main`, checks the artifact is dev-only, boots the device and runs `09-password-visibility.yaml` (no sign-in), then shuts the device down. Run each platform once while a beta build is going too, and watch the memory: the lane is meant to wait for betas, never to run beside one.

#### Switching it on

1. Add `device` to `FACTORY_VERIFY_LANES` (`shell,browser,device`) and set `FACTORY_VERIFY_DEVICE=1`. Keep the canary label (`FACTORY_VERIFY_ONLY_LABEL`) on, and reload.
2. Put the label on one mobile card. Watch it in Testing: `device lane started for …`, then either a `reported:*` row in the report or "running — results follow" and, later, the follow-up comment. The card must stay in In Test when the follow-up lands.
3. After a few clean runs, drop the canary.

To turn it off, set `FACTORY_VERIFY_DEVICE=0`. A run already going finishes (or is stopped by housekeeping), and its follow-up is still posted.

#### Reading a run

Each run has a directory, `logs/factory/device/runs/<issue>-<sha12>-<timestamp>/` (mode 700, reaped after 30 days):

| File                                                                  | What it is                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `meta.json`                                                           | What `start` decided: platforms and flows, deadline, binaries, knobs, secret-file **paths** (never values)             |
| `device-output.json`                                                  | The results, per platform: state, verdict, build (cached, duration) and each flow's status, duration and failure line  |
| `supervisor.log`                                                      | The supervisor's log, including the filtered JUnit lines                                                               |
| `device-<platform>/`                                                  | That platform's `prebuild.log` and `build.log`                                                                         |
| `evidence/` (`shots.json`, `device-<platform>/`)                      | The screenshots the supervisor took after each flow, with their sha256 in `shots.json`. Only these are ever published  |
| `exit.json`                                                           | How the supervisor ended                                                                                               |
| `followup.md`, `followup-render.json`, `upload.json`, `followup.done` | The follow-up comment as composed, its render result, the screenshots' upload record, and the marker that it's settled |
| `private/`                                                            | Raw JUnit and Maestro output, only while the run is live (or with `FACTORY_DEVICE_KEEP_RAW=1`)                         |

```bash
node scripts/lib/device-lane.mjs status                          # the ledger, the run in flight and its progress
node scripts/lib/device-lane.mjs render --run-dir <dir>          # device-output.json as the follow-up comment would read
node scripts/lib/device-lane.mjs stop --issue <n> --reason stop  # stop a card's run (its attempt is given back)
```

**The Android adb drop.** Now and then the emulator drops off adb in the middle of a flow, and Maestro fails with `device offline` or `device '…' not found`. That's the harness, not the app, so the supervisor runs that flow once more. The log says `lost the device (adb); retrying once`, and a failure after the retry says `(after one retry for an adb drop)`. A flow that drops twice is reported as it failed. If it keeps happening, cold-boot the AVD and save its `clean` snapshot again (setup step 2).

#### Device-lane triage

| Symptom                                     | Look at                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device row `deferred:*` for a long time     | The `--watch` log's `device lane not started (<reason>)` lines. `busy`: another card's run (`device-lane.mjs status`). `beta-build`: a beta is building, which is expected. `memory` / `disk`: the Mac mini.                                                                  |
| `unavailable:no-account` / `*-missing`      | `node scripts/lib/device-lane.mjs selftest` names what's missing (setup steps 4 and 5).                                                                                                                                                                                       |
| A platform `unavailable:artifact-not-dev`   | The build wasn't provably dev-only (the dev ref missing from the app config, the prod ref somewhere in the artifact, or the API URL not the `.invalid` one). Check the factory checkout's `apps/mobile/.env`. Nothing was installed.                                          |
| No follow-up comment                        | `factory:get-issue <n>` → `deviceReportPosted`. `:stale` means the head moved, so nothing will be posted. Nothing recorded: the `--watch` log for `device lane's follow-up` lines, and the run dir's `followup.md` (post it by hand with `gh issue comment <n> --body-file`). |
| Device row `retry:beta-build` over and over | A beta started mid-run each time, so the run gave way (as it should). It starts again once no beta build root is locked; `device-lane.mjs status` shows the run in flight, if any.                                                                                            |

### Triage

| Symptom                                             | Look at                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cards skip Testing with `FACTORY_VERIFY=1`          | The `--watch` log for `no Testing column` or `no status:testing label` (setup step 1), or the canary label missing on the issue. A commit that already has a posted report goes straight to In Test.                                                                                                                                                 |
| A card sits in Testing                              | Its `Testing → wait/skip/work-lanes` lines. `skip (pr-merged)` is yours to move. Anything else ends at the hold cap. For the browser lane, `factory:get-issue <n>` → `verifyBrowser` and the `--browser` log (see "A Testing card's browser lane").                                                                                                  |
| A card keeps bouncing between Testing and In Review | The hand-back comments. Each bounce is about the commit (CI, review, threads). The fix budget isn't reset on the way in, so a loop ends in Blocked.                                                                                                                                                                                                  |
| No report on an In Test card that came from Testing | `factory:get-issue <n>` → `verifyReportSha`, `verifyReportPosts`, and the body in `logs/factory/verify/`. After 4 failed attempts (the promotion's, then retries 10, 20 and 30 minutes after composing), post it by hand: `gh issue comment <n> --body-file <that file>`.                                                                            |
| Shell lane `deferred:*` or never starting           | The `--watch` log's `verification shell lane not started (<reason>)` lines. `busy`: another card's run (`factory:verify-status`). `memory` / `disk`: the Mac mini (beta builds running?). `lane-paused`: `factory:verify-status` → `pausedReason`.                                                                                                   |
| Shell lane `unavailable:guard` (lane paused)        | The run dir's `guard/<session>.jsonl` (no `session-start` record means claude dropped the settings file) and `claude-stderr.log`. A claude update can change the settings schema. Fix, then `factory:verify-resume`.                                                                                                                                 |
| Shell lane `unavailable:install`                    | The run dir's `install.log`. Usually a lockfile the offline store can't satisfy; the next commit gets a fresh run.                                                                                                                                                                                                                                   |
| Report says no bypass secret / no session           | `node scripts/lib/verify-lane.mjs bypass-check`; the run dir's `exit.json` → `facts.session` (`signin-failed`: the branch predates `/auth/test-sign-in` or the test account is gone; `protected`: Vercel's SSO answered, so the bypass secret is wrong; `signin-busy`: a browser run held the sign-in lease past the wait, see "The sign-in lease"). |
| Shell report withheld                               | The run's `shell-output.txt` printed something secret-shaped (the report names the pattern). The lane's text stays on the Mac mini.                                                                                                                                                                                                                  |
| A lane's text says "withheld"                       | The lane printed something that matched a secret pattern, or a secret file was unreadable. Read the lane's local output; the report names the pattern, never the match.                                                                                                                                                                              |

### The ledger and its commands

The stage keeps a `verify` ledger in `factory-state.json`. Like the CodeRabbit lane, it allows one shell-lane run in flight at a time across the whole factory, and has a lane-only pause. Each card gets `verify*` fields for its current round, the one for `verifySha`:

- **Keyed by commit** (a push re-arms them): the lane results `verifyShell` and `verifyBrowser` (`<sha>:<state>[:<verdict>]`), the counters `verifyShellAttempts`, `verifyBounces` and `verifyReportPosts` (`<sha>:<count>`), the CodeRabbit note the card carried in, `verifyCrNote` (`<sha>:<note>`), `verifyReportSha`, and `verifyPromotedSha` (the head moved to In Test, recorded at the move even if its report never posted). The device lane adds `verifyDevice` (`<sha>:<state>`) and `deviceReportPosted` (`<sha>:<runId>[:<why>]`).
- **Not keyed by commit:** `verifyStartedAt`, the hold-cap anchor, and the run directories `verifyShellRunDir`, `verifyBrowserRunDir` and `verifyDeviceRunDir`. They only mean something while `verifySha` is the card's head; a new round overwrites them.

```bash
node scripts/lib/state-cli.mjs factory:verify-status                       # in-flight run, lane pause, every card's verify* fields
node scripts/lib/state-cli.mjs factory:verify-finish <runId>               # stop a stuck run, then free the lane
node scripts/lib/state-cli.mjs factory:verify-pause-until <iso> "<reason>" # pause the LANE only (not the factory)
node scripts/lib/state-cli.mjs factory:verify-resume                       # lift a lane pause early
node scripts/lib/state-cli.mjs factory:verify-reset <n>                    # forget the card's round; the next tick starts it again
```

- **`factory:verify-finish`** works like `factory:cr-cli-finish` (see "Killing a wedged run"). It SIGTERMs the run's process group, but only while the run is still ours, and waits up to `--wait-ms` (default 10 s). Only then does it free the lane. The spent attempt stays spent unless you pass `--refund attempt`. The run's worktree is left to housekeeping. What it prints:
  - `ok:false`, `supervisor-still-running` or `supervisor-unverifiable`: the group survived, or `ps` couldn't check it. Nothing changed.
  - `ok:false`, `supervisor-attached-meanwhile`: the factory attached a process during the wait that this command never checked. Nothing changed; run it again.
  - `ok:true`, `releasedBy:"factory"`: the factory freed the run itself during the wait.
- **`factory:verify-reset`** clears the card's `verify*` fields, plus `browserRunSha` and `browserRunAttempts`: the browser runner skips any commit `browserRunSha` names, so keeping it would leave the new round without a browser verdict. On a card already in In Test, the In Test browser run then runs again. While the lane is running for that card, it prints `ok:false, reason:"run-in-flight"` and changes nothing, so run `factory:verify-finish` first.

## Test-run screenshots on GitHub

The In Test browser report and the verification report's Web lane embed the run's screenshots under the steps that took them ([ADR-0096](../adr/0096-factory-test-run-screenshots-on-github.md)). After a run, and only once its report has passed the secret scan, the factory's own code does this, never a claude session:

1. `scripts/lib/evidence-upload.mjs` takes the screenshots the guard copied, in the order its decision log recorded them;
2. it checks each file and OCR-scans it for secrets (`scripts/lib/evidence-images.mjs`);
3. it commits the ones that pass as one parentless commit, and pushes it to `refs/factory-evidence/<issue>/<sha12>/<run-id>` with a create-only lease;
4. bash renders the report again, showing them as `<img width="480">` from `raw.githubusercontent.com` URLs pinned to that commit.

The ref isn't a branch or a tag, so a normal clone or fetch never downloads it and no workflow runs on it. The selftest below checks that Vercel ignores it too. The `plan` kind and the shell lane never publish anything. macOS harness runs are posted by hand: see [macos-in-test-automation.md](./macos-in-test-automation.md#posting-a-run-on-the-issue). Code: `evidence-upload.mjs`, `evidence-images.mjs`, `evidence-embed.mjs`, `evidence-post.mjs`, and the `evidence_*`, `browser_publish_screenshots` and `verify_publish_screenshots` functions in `scripts/factory-agent.sh`.

| Setting                   | Default | What it does                                                                                                                                                                                                                                        |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_EVIDENCE_UPLOAD` | `1`     | `0` keeps every screenshot on the Mac mini, as before ADR-0096, and each report says so. Any value but `0` or `1` warns in the launchd log and acts as `0`. Even at `1`, nothing is published until the selftest below has passed on this Mac mini. |

Fixed in the code: at most 20 images and 20 MB per comment, 5 MB per image, `.png` or `.jpg` only.

The runner takes each screenshot at `scale: 1` (prompt rule 7), the largest image Claude in Chrome returns: 1081×1120 on the Mac mini's Chrome window. When a step's result is a small detail, it adds a `zoom` close-up of that region. Comments show every image 480 px wide (`IMAGE_WIDTH` in `evidence-embed.mjs`), and a click opens it at full size.

### One-time setup

1. **Run the selftest** from the factory checkout. It pushes with that checkout's git credentials, so run it as the factory's user:

   ```bash
   cd /Volumes/DraftoFactory/drafto-factory
   node scripts/lib/evidence-upload.mjs selftest --log-dir logs/factory --repo-root .
   ```

   It pushes a parentless commit holding a 1×1 PNG to `refs/factory-evidence/selftest/<epoch>`. Then it fetches the image's raw URL with no credentials (up to 6 tries, 5 s apart), and asks the GitHub Deployments API 4 times, 15 s apart, whether Vercel started a deployment for the commit. It prints one JSON line, writes `logs/factory/evidence-selftest.json` (mode 600), and exits 0 only when it passed.

2. **Re-check a few minutes later**, once Vercel would have reacted to the push:

   ```bash
   node scripts/lib/evidence-upload.mjs selftest --log-dir logs/factory --status 1
   ```

   This asks the Deployments API again about the recorded commit and updates the record. A deployment found now turns `ok` off, for good: a later check that finds none doesn't turn it back on. A check that sees no deployment, for a commit whose image was served, turns `ok` on.

3. **Read the record** (`cat logs/factory/evidence-selftest.json`):

   | Field        | Meaning                                                                                                                                                                                             |
   | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `ok`         | Whether uploads may run: `true` when the image was served and no Vercel deployment was found. Every upload checks it.                                                                               |
   | `commit`     | The selftest's evidence commit.                                                                                                                                                                     |
   | `ref`        | The ref it pushed, `refs/factory-evidence/selftest/<epoch>`.                                                                                                                                        |
   | `url`        | The test image's `raw.githubusercontent.com` URL, pinned to `commit`. Open it in a private window to see it served to someone signed out.                                                           |
   | `served`     | Whether that URL answered 200 to a request with no credentials, with an `image/*` content type and the same bytes.                                                                                  |
   | `deployment` | `none`: the Deployments API lists no Vercel deployment for the commit. `found:<state>` (`ready`, `building` or `failed`): Vercel started one. `unknown`: GitHub couldn't be asked.                  |
   | `at`         | When the selftest ran. `statusAt` is when `--status 1` last re-checked.                                                                                                                             |
   | `reason`     | Only on a failure: `push` (the ref didn't land), `not-served:status`, `not-served:content-type` or `not-served:bytes`, `vercel-deployment`, `deployment-unknown` (GitHub couldn't say), or `error`. |

   `ok` is `true` only when the image was served and the check saw `none`. An `unknown` fails closed (`reason: "deployment-unknown"`): run step 2 again once GitHub answers, and it turns `ok` on if it sees `none`. The selftest ref holds only the 1×1 PNG, so it can stay. Running the selftest itself again pushes a new ref and overwrites the record.

**If it found a Vercel deployment** (`reason: "vercel-deployment"`), every published run would start a Vercel build. Uploads are already refused while `ok` is `false`. To be sure, also set `FACTORY_EVIDENCE_UPLOAD=0` in the plist and reload. Then decide what to do. Vercel's settings, such as the Git integration and its Ignored Build Step, are hosted config that the factory never changes, so that's your call. After any change, run the selftest itself again: `--status 1` keeps a deployment it has once seen.

**If GitHub rejected the ref** (`reason: "push"`), push the recorded commit by hand to see GitHub's message. The selftest itself never prints git's error output, because it can echo the remote's URL. Take `<commit>` and `<epoch>` from the record's `commit` and `ref`:

```bash
git push origin <commit>:refs/factory-evidence/selftest/<epoch>
```

If GitHub refuses the namespace itself, the fallback is a tag prefix, `refs/tags/factory-evidence/`. That's one constant, `EVIDENCE_REF_PREFIX` in `scripts/lib/evidence-upload.mjs`, changed in a PR, not a setting. ADR-0096 gives the cost: every evidence tag is listed on the repo's Tags page, and `git fetch --tags` downloads them all. Once it's merged, run the selftest again.

**The OCR helper.** Each screenshot's text is read with `logs/factory/bin/ocr` and scanned like the report. The factory compiles it on first use from the macOS harness's `apps/desktop/e2e/in-test/lib/ocr.swift`, with `swiftc -O` (the Xcode command-line tools) under a 300-second cap. It compiles it again whenever `ocr.swift` is newer than the binary. The device lane's screenshots are published from `--watch`, which never compiles, so a device run's start builds the helper in the background when it's missing or stale (`evidence_ocr_provision`; `logs/factory/bin/ocr.building` while it builds). Without it nothing is published (`ocr-missing`), and the browser log says `the OCR helper that scans screenshots for secrets isn't available (swiftc?)`. To build and try it by hand:

```bash
cd /Volumes/DraftoFactory/drafto-factory
mkdir -p logs/factory/bin
swiftc -O -o logs/factory/bin/ocr apps/desktop/e2e/in-test/lib/ocr.swift
logs/factory/bin/ocr <any.png>
```

The last command prints one JSON line, `{"width":…,"height":…,"items":[{"text":…,…}]}`.

### What a run does

- **In Test (`intest`).** The report is rendered and scanned (`render.json`). Unless it was withheld, the screenshots are published, and the report is rendered again with them (`render-images.json`), which is what gets posted. If the upload fails, the first render is posted, saying the screenshots stayed on the Mac mini and why. If the upload succeeded but the second render fails (the log says `re-rendering #<n>'s browser report with its screenshots failed`), the first render is still posted, and its footer still says they stayed on the Mac mini. That isn't true then: they were published on the run's ref, and no comment links them. The run's `upload.json` has the `ref`, the `commit` and each image's URL. If one shouldn't stay public, follow "Taking a screenshot down" below (there is no comment to edit).
- **Testing (`verify`).** The browser run publishes nothing itself. When the verification report is composed, bash composes it once without screenshots. Only if the Web lane reported, and that render withheld neither the lane's text nor the body (`verify-render.json`), are the browser run's screenshots published. The report is then composed again with them inside the Web lane's details. If that second composition fails (`composing #<n>'s verification report with the Web lane's screenshots failed`), the report goes out without them, as for In Test: they are published on the run's ref, in its `upload.json`, but not linked.
- **Evidence, never a gate.** A failed upload never moves a card, never spends an attempt and never holds a report back.

The log (`logs/factory/factory-agent-browser-<date>.log` for an In Test run, `logs/factory/factory-agent-watch-<date>.log` for the verification report) has one line per upload: `Issue #<n>: screenshots of <sha12> (<run-id>): {"ok":…,"reason":…,"commit":…,"images":<n>,"overflow":<n>,"reused":…}`. `reused: true` means an earlier attempt had already published them, so nothing was pushed again.

**Where the upload record lives.** Each run's `upload.json` (mode 600) records what was published, or why nothing was:

- an In Test run: `logs/factory/browser/issue-<n>-<sha12>-<timestamp>/upload.json`, run id `intest-<timestamp>`;
- a verify run: `logs/factory/browser/issue-<n>-<sha12>-verify-<timestamp>/upload.json`, run id `verify-<timestamp>`;
- a macOS run: `<run-dir>/upload.json`, run id `macos-<timestamp>`, with `posted.json` beside it once the comment is posted.

A published record is `{ok: true, issue, sha, runId, ref, commit, images: [{n, url, local, name}], overflow: [{n, path, why}]}`. `n` is the runner's "screenshot n", and `overflow` is what was kept on the Mac mini. A refusal is `{ok: false, reason}`. A refusal for a run that already published (the switch turned off or the selftest record moved aside before a retry) keeps that record's `ref`, `commit` and `images` beside `ok: false`, so takedown still finds them. The report doesn't embed them, and a retry with the gates open reuses the commit on the ref.

### Why nothing was published

The report's footer gives the reason as a sentence. The tokens below are the `REASONS` in `scripts/lib/evidence-embed.mjs`; `upload.json` holds the ones the upload itself decided:

| Reason             | Meaning                                                                                                                             | What to do                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `withheld`         | The secret scan withheld the report, or the verification report's Web lane, or its whole body. Its screenshots were withheld too.   | Read the run's `runner-output.txt`. Nothing to fix in publishing.                                                                        |
| `not-reported`     | The Web lane didn't report a result, so there's nothing to put its screenshots under.                                               | None.                                                                                                                                    |
| `off`              | `FACTORY_EVIDENCE_UPLOAD=0` (or a bad value).                                                                                       | Set it to `1` and reload, if you want them.                                                                                              |
| `unattended`       | A macOS run's upload was asked for in an unattended session (`DRAFTO_UNATTENDED=1`). Only a person publishes a macOS run.           | Run `evidence-post.mjs macos` from a Terminal.                                                                                           |
| `account-live`     | A macOS run's `state.env` exists, so its throwaway account may still be live.                                                       | Clean the run up first ("Posting a run on the issue", step 1, in `macos-in-test-automation.md`).                                         |
| `selftest-missing` | There's no `logs/factory/evidence-selftest.json`.                                                                                   | Run the selftest ("One-time setup").                                                                                                     |
| `selftest-failed`  | The selftest record's `ok` is `false`.                                                                                              | Read its `reason` ("One-time setup").                                                                                                    |
| `ocr-missing`      | The OCR helper isn't there or isn't executable.                                                                                     | Build it ("The OCR helper").                                                                                                             |
| `account-file`     | The test account file couldn't be read, so the scan couldn't check for the password.                                                | Fix `FACTORY_BROWSER_ACCOUNT_FILE` ("Browser runner (Claude in Chrome)" → "One-time setup", step 4).                                     |
| `secret-file`      | The bypass secret file or the sign-in key file was given but couldn't be read, or has no value, so the scan can't check for it.     | Fix `FACTORY_VERIFY_BYPASS_FILE` / `FACTORY_BROWSER_SIGNIN_KEY_FILE`.                                                                    |
| `no-session`       | The run's guard decision log couldn't be found: no `session-id` in the run dir, or no `logs/factory/browser-guard/<session>.jsonl`. | A run from before this change, or a log already reaped. Later runs are unaffected.                                                       |
| `push`             | Pushing the evidence commit failed, and nothing is on the ref.                                                                      | Check the factory checkout can push (`gh auth status`, `git ls-remote origin`). That report went out without them; later runs try again. |
| `remote`           | `git ls-remote` couldn't say whether the ref exists, or the commit on it couldn't be read.                                          | Usually the network or GitHub. Later runs try again.                                                                                     |
| `none`             | The run saved no screenshots.                                                                                                       | Rule 7 of `scripts/factory-browser-prompt.md` asks for one per step. Check the run's `runner-output.txt`.                                |
| `none-passed`      | Every screenshot failed a check or was held back. The report's "Kept on the Mac mini" list says why for each.                       | See below.                                                                                                                               |
| `unreadable`       | The upload record couldn't be read when the report was rendered again.                                                              | Look at the run's `upload.json`.                                                                                                         |
| `unsafe`           | The screenshots section still matched a secret pattern after its step labels and matching "Kept on the Mac mini" lines were hidden. | Look at the run's `upload.json`. Its images were published but aren't embedded.                                                          |
| `error`            | Anything else. Any other token reads as "the upload failed (`<token>`)".                                                            | The browser or `--watch` log, around the upload line.                                                                                    |

**"Kept on the Mac mini".** Even when some screenshots are published, the report lists the others with their local path and why. The reasons include: the guard rejected the screenshot or couldn't copy it (the path is then the evidence directory, since there is no file); taken while the tab wasn't on the preview; over the per-comment cap; not a `.png` or `.jpg`; a symlink; not a regular file; outside the evidence directory; empty; larger than 5 MB; bytes that aren't a PNG or JPEG; a file that changed while it was being checked; the OCR scan couldn't read it; its text matched a secret pattern, named, never with the matched text; or, for a browser screenshot, its text showed an email address other than `support@drafto.eu` or the sign-in forms' `you@example.com` placeholder, never saying which. Treat a secret-pattern match as a near-miss. Look at the file on the Mac mini, and if it does show a credential, rotate it as below even though it wasn't published.

### Taking a screenshot down

If a published image shows something it shouldn't:

1. **Rotate the credential first.** Revoke the API key, change the test account's password (and update `~/drafto-secrets/browser-account.env`), or regenerate whatever it was. Deleting doesn't unpublish: raw.githubusercontent.com keeps serving a commit whose SHA is known until GitHub garbage-collects it, and GitHub's image proxy (camo) caches the image. Only GitHub Support can purge it sooner.
2. **Delete the run's ref.** It's the `ref` in the run's `upload.json`. The first command lists every evidence ref on GitHub, and the second deletes one:

   ```bash
   git ls-remote origin 'refs/factory-evidence/*'
   git push origin :refs/factory-evidence/<issue>/<sha12>/<run-id>
   ```

3. **Edit the comment** on the issue and remove its `<img>` tags.

To stop the factory's own uploads, set `FACTORY_EVIDENCE_UPLOAD=0` in the plist and reload. That doesn't stop `node scripts/lib/evidence-post.mjs macos --yes`: it reads the switch from the shell that runs it, and a Terminal doesn't inherit the plist's environment. To stop every upload at once, the macOS command included, move `logs/factory/evidence-selftest.json` aside, so each one refuses with `selftest-missing`. Each upload checks the record before it scans its screenshots and again after the scan, just before it pushes, so this also stops one that is still scanning. Only a push already under way finishes. Or `export FACTORY_EVIDENCE_UPLOAD=0` in the shell before running the macOS command.

**Storage.** A run adds about 2–5 MB to the repo's object store. Normal clones, CI and Vercel never fetch evidence refs, but `git clone --mirror` fetches every ref, and so every image. Nothing prunes old refs yet. Delete them by hand as above if they pile up.

## Kill switches

| Severity                          | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One bad card                      | Drag to **Blocked**, or apply `factory-pause` to the issue. Factory skips it next tick.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Weekly usage readout misbehaving  | `FACTORY_USAGE_READOUT=0` in `eu.drafto.usage-readout.plist`, or `launchctl unload` it. `/admin/stats` keeps the last readings, marked stale after 8 days.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Stop all factory work             | `node scripts/lib/state-cli.mjs factory:pause` (Wave 2+). Manual pause never auto-expires. Resume with `factory:resume`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Stop the launchd job              | `launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist`. Reload to resume. A detached implement run already started keeps going: stop it with `implement-lane.mjs kill` (see "Detached implement runs").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Active Claude session hangs       | `node scripts/lib/state-cli.mjs factory:slot-status` shows the PID + issue for each implement/watch slot; `kill -TERM <pid>`. The wall-time wrapper (`run-claude.mjs`) caps each invocation (`FACTORY_PLAN_TIMEOUT_SEC` — default 360 s — for `--plan`/replan, `FACTORY_IMPLEMENT_TIMEOUT_SEC`/`FACTORY_WATCH_TIMEOUT_SEC` for the engines — default 2700/1800 s) so a true hang is rare.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Worktree install hangs            | Each `pnpm install` is wrapped by `run-with-timeout.mjs` and capped at `FACTORY_INSTALL_TIMEOUT_SEC` (default 600 s); on cap, `--implement` releases the slot + worktree and bumps the card's attempt budget, while `--watch` logs a warning and proceeds. A cold install should take seconds (clonefile seed + offline reconcile), not minutes — see "Worktree installs & disk".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A `gh` call hangs                 | Every `gh` call in `factory-agent.sh` and its node helpers (`factory-project`, `verify-lane`, `coderabbit-cli`) is capped at `FACTORY_GH_TIMEOUT_SEC` (default 120 s): bash through a `gh()` wrapper over `run-with-timeout.mjs`, node through `scripts/lib/gh-timeout.mjs`. At the cap `gh` is killed and the caller treats it as any other `gh` failure. A capped bash call logs `WARNING: gh <subcommand> timed out after <n>s` unless its stderr goes to `/dev/null`; a capped node call shows as that helper's usual failure. Before the cap, one idle `gh issue comment` on #748 held the loop lock for 2+ days. If a tick still looks stuck, `ps -ax -o pid,etime,command \| grep -E 'factory-agent\|gh '` shows what it waits on.                                                                                                                                       |
| CodeRabbit CLI lane misbehaving   | Set `FACTORY_CR_CLI=0` in the plist and reload. Cards then promote without waiting for CodeRabbit. Housekeeping keeps running with the lane off: it terminates an in-flight CLI run (SIGTERM to its process group) and discards any finished run's results — nothing is posted and no coverage is recorded — then removes the run's worktree and frees the slot. To do that by hand right away, see "Killing a wedged run". A lane pause (`factory:cr-cli-pause-until`) only stops new runs; cards still hold for the bot and their own in-flight run (see "What a lane pause does to cards"). See "CodeRabbit CLI gap-fill lane". The kill switch covers factory runs only: a manual `coderabbit-cli.mjs review` (`"manual": true` in `factory:cr-cli-status`) keeps running and posting. Stop one with `factory:cr-cli-finish <runId>`.                                       |
| Browser runner misbehaving        | Set `FACTORY_BROWSER=0` in both the factory's plist and `eu.drafto.usage-readout.plist` (or unload the usage job) and reload them. No claude call gets Chrome after that, and a Testing card's browser lane ends as `skipped:browser-off`. To stop a run in flight, kill its `run-claude.mjs` process; its tabs stay open in an orphaned group in Chrome. See "Browser runner (Claude in Chrome)".                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Screenshot publishing misbehaving | Set `FACTORY_EVIDENCE_UPLOAD=0` in the plist and reload. The factory's reports then keep every screenshot on the Mac mini. That doesn't stop `node scripts/lib/evidence-post.mjs macos --yes`, which reads the switch from the shell that runs it. To stop every upload, that command included, also move `logs/factory/evidence-selftest.json` aside, so each one refuses with `selftest-missing`. A screenshot already published stays served: see "Test-run screenshots on GitHub" → "Taking a screenshot down".                                                                                                                                                                                                                                                                                                                                                             |
| Plan-stage probe misbehaving      | Set `FACTORY_PLAN_PROBE=0` in the plist and reload. The next `--plan` tick cancels any queued probe (`cancelled:off`, nothing posted) and deletes its branch. A round that already reported is still folded into its plan. To keep probes but stop building the planner's code, set `FACTORY_PLAN_PROBE_SPIKE=0` instead. See "Browser runner (Claude in Chrome)" → "Plan-stage browser probe".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Oversize label misbehaving        | Set `FACTORY_PLAN_OVERSIZE_LINES=0` in the plist and reload. The factory stops adding or removing `factory-oversize`, and stops holding oversize cards; plans keep their **Size** section and marker. Cards it already held stay in **Plan Review**: drag each back to **In Progress** to run it. See "Plan size and the oversize label".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Oversize hold misbehaving         | Set `FACTORY_OVERSIZE_HOLD=0` in the plist and reload. Approved oversize cards are implemented again without a split; the `factory-oversize` label keeps working. Turning the hold off doesn't move the cards it already sent back: they stay in **Plan Review** until you drag each one back to **In Progress**. For one card, add `oversize-approved` to the issue and drag it back to **In Progress**. See "Plan size and the oversize label".                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/split` misbehaving              | Set `FACTORY_SPLIT=0` in the plist and reload. A `/split` comment is then ordinary feedback for the planner; a split already part-way stops where it is. See "`/split`: filing a plan's Proposed split".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Verification stage misbehaving    | Set `FACTORY_VERIFY=0` in the plist and reload. Cards go straight to In Test again. Any card already in Testing is promoted on the next tick, with a report saying verification was switched off. **Rollback drill:** set `FACTORY_VERIFY=0`, wait for Testing to drain (the `--watch` log shows `promote (verification-off)` lines), then check the board column is **empty**. The sweep leaves some cards there: ones with a `factory-pause` or `support` label, a merged or closed PR, or no PR, and any whose move failed. Move those by hand. Only **then** revert the code. Reverting first strands cards: the old code never looks at Testing. With the device lane on, a run whose card already reached In Test keeps going: wait for `node scripts/lib/device-lane.mjs status` to show nothing in flight, or stop it, first. See "Pre-In-Test verification (Testing)". |
| Implement resume misbehaving      | Set `FACTORY_IMPLEMENT_RESUME=0` in the plist and reload. Every implement attempt then starts a fresh session. For one card, `node scripts/lib/state-cli.mjs factory:implement-resume-clear <n>` stops its next run from resuming. See "Resuming a timed-out implement".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Detached implement misbehaving    | Set `FACTORY_IMPLEMENT_DETACHED=0` in the plist and reload. Runs already started are still collected; new ones run in the foreground again. To stop one run: `implement-lane.mjs kill` as "Stopping a run" under "Detached implement runs" describes (from the factory checkout, with `--repo-root`, between ticks).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Stuck PR with a wrong commit      | `gh pr close <n> --delete-branch`. Drag the card back to Ready. Factory will re-plan on the next tick.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Plan needs a single tweak         | Comment on the issue with the correction; on the next tick the factory edits the existing plan comment in place (preserves the rest, stamps `<!-- drafto-factory-replan-ack:<id> -->` so the same comment doesn't loop) and posts one reply per comment you wrote (`<!-- drafto-factory-plan-reply-<id> -->`). Drag back to Ready only if you want a full restart. See `docs/features/dark-factory.md` → "The plan comment looks wrong".                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Automatic pause on a Claude session limit (self-healing)

The factory shares a Claude subscription with interactive sessions on the Mac mini. When a `claude -p` call dies because that subscription hit its 5-hour session usage limit, the failure is invisible in the factory logs (`claude exited non-zero (1)` with empty stdout/stderr — the "resets HH:MM" message lives only in the CLI's session transcript under `~/.claude/projects/<cwd-slug>/*.jsonl`). Before this was handled, issue #463 burned all 5 implement retries in 41 minutes against a limit that couldn't reset until later that morning.

Now, on any non-timeout claude failure (`--plan`, replan, `--implement`, `--watch`), the engine checks the transcript (`scripts/lib/session-limit.mjs`). If the last assistant message is a session/usage-limit error it:

- does **not** bump the card's attempt budget (the failure wasn't the card's fault),
- parses the reset time and sets a **timed pause** via `node scripts/lib/state-cli.mjs factory:pause-until <iso> "<reason>"` (fallback: `FACTORY_LIMIT_FALLBACK_MIN`, default 30 min, when the reset time can't be parsed), and
- returns the card to its re-entrant state (plan → Ready, replan → Plan Review, implement keeps its warm slot + worktree in In Progress).

The next tick's pause gate reports the factory paused (`… (until: <iso>)`) and exits until the deadline; once `now ≥ pausedUntil`, `factory:paused?` auto-resumes and work continues — no operator action needed. A **manual** `factory:pause` has no deadline and never auto-expires. To lift a timed pause early, run `factory:resume`. To inspect it: `node scripts/lib/state-cli.mjs factory:status` shows `paused` + `pausedUntil` + `pausedReason`.

Trade-off: the pause gate stops every mode, `--release` included, so merges also wait for the reset. Since the loop runs right to left ([ADR-0068](../adr/0068-factory-runs-the-board-right-to-left.md)), `--release` runs before any Claude call in a tick, so a limit hit later in that tick no longer holds that tick's merges. Later ticks still wait — acceptable at the factory's cadence.

> **A pause doesn't stop a detached implement run.** With `FACTORY_IMPLEMENT_DETACHED=1`, a run started before the pause keeps going to its end or its cap; nothing collects it until the pause ends. At a session limit the run usually fails on the same limit, and its collection then pauses again until the reset read against the run's own end time. To stop a run during a pause, see "Detached implement runs".

### Automatic toolchain pause (self-healing)

On 2026-10-04 an Xcode 27 update landed on the Mac mini with its license unaccepted. From then on every `/usr/bin/git` call failed with "You have not agreed to the Xcode license agreements". For about 3 hours every tick failed `worktree add` / `worktree resume`, self-update blamed "(offline?)", each mode still exited 0 (so no `factory-failure` issue was filed), and nobody was told.

Now `factory-agent-loop.sh` runs `scripts/lib/toolchain-health.mjs check` every tick, right after self-update and before the modes. It probes `git --version`, `git rev-parse HEAD` in the factory checkout, `gh --version` and `claude --version`. All the probes are local, so a network blip can't trip them.

- **Any probe fails:** the tick is skipped (`toolchain-health: unhealthy; skipping this tick` in `launchd-factory-stderr.log`, after a JSON line naming the failure and its class).
- **Same fault on 2 consecutive ticks:**
  - The factory pauses itself with reason `toolchain: <tool> broken (<class>)`. The `toolchain:` prefix marks the pause as the check's own. A pause with any other reason is never rewritten or resumed, including a manual `factory:pause` you add mid-incident (for example to keep the factory stopped after fixing the host).
  - It emails the operator once from `support@drafto.eu` via `zoho-cli.mjs send`. GitHub doesn't notify Jakub about issues his own token files, so email is the real alert.
  - It files one `factory-failure` issue as the record. The issue carries a `<!-- drafto-factory-toolchain:<signature> -->` marker and the exact fix.
  - A different fault mid-incident gets a fresh email and a comment on the same issue. A fault still present after 24h sends one reminder email.
- **The probes pass again:** the factory resumes its own pause (only a pause whose reason starts with `toolchain:`, even if the incident record was lost), closes the issue, sends a recovery email and clears `toolchainIncident` in `logs/factory-state.json`. A failed close is retried on later ticks.
- **Retries:** the email and the issue are tracked separately and each is retried every tick until it succeeds. A failed email is never treated as sent just because the issue was filed.
- **Fails open:** the check runs after self-update, so a broken check can always be fixed by merging to main. Only exit 3 (a broken tool) skips the tick. If the check itself crashes (corrupt state file, full disk), the loop logs `toolchain-health: check itself failed (rc=N); running the tick anyway` and the tick runs as before.

Known fault classes and fixes:

| Class                  | Fix                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `xcode-license`        | `sudo xcodebuild -license accept` in a **real Terminal** on the Mac mini. sudo can't prompt under launchd or a Claude `!` command. |
| `xcode-developer-path` | `xcode-select --install` (or `sudo xcode-select -s /Applications/Xcode.app`)                                                       |
| `not-found`            | Binary missing from launchd's `PATH`: reinstall it or fix the plist's `PATH`.                                                      |
| `timeout`              | A probe hung; look for a stuck process or a pending system dialog.                                                                 |

Inspect with `node scripts/lib/state-cli.mjs factory:status` (pause) and `jq .toolchainIncident logs/factory-state.json` (incident). Dry-run the check by hand with `node scripts/lib/toolchain-health.mjs check --repo . --dry-run`. Set `FACTORY_HEALTHCHECK=0` in the plist to disable it.

### Red or cancelled CI on a factory PR (self-healing)

On 2026-10-05 GitHub cancelled three required checks on #654's PR because it had no runner for them ("The job was not acquired by Runner of type hosted"). `--release` counted `CANCELLED` as a failure and logged `not merging (left in Approved)` every tick for about 2.5 days, without a comment, a re-run or a transition. Updating the branch would have started a fresh run, but that step came after the failing-checks gate and was never reached.

Now `--watch` and `--release` sort failing **required** checks into two kinds (`classify_failing_required`). Advisory checks such as CodeRabbit still never count. If branch protection can't be read, the required set is unknown and the fallback would count advisory bots too, so the card simply waits, as before.

- **CI couldn't run.** Every failing required check is `CANCELLED` (or `TIMED_OUT`), and the GitHub Actions job behind each one never judged the code. Either it never got a runner (the job API shows no `runner_name` and no steps, which is exactly how #654's three jobs look), or it ran out of time in a step that can't be the code's fault (`is_ci_infra_step`: checkout, toolchain setup, cache and artifact transfers, the Playwright browser install, the SonarCloud steps). The job's annotation must say it "exceeded the maximum execution time": a job someone cancelled by hand is never re-run. Every job in `ci.yml` has a `timeout-minutes` a few times its usual run, so a hung job ends in minutes instead of GitHub's 6 hours. A test ties `is_ci_infra_step` to the step names in `ci.yml`.
  - Both modes re-run the cancelled jobs with `gh run rerun <run> --failed`. They make at most `FACTORY_CI_RERUN_MAX` re-runs per head SHA (default 2) and spend no fix attempt. They wait until the whole workflow run has finished first, because GitHub refuses to re-run a run that still has jobs going. A stale branch is not updated at this point: the existing BEHIND step does that once the checks are green.
  - When the re-runs are spent, the factory posts one comment (`<!-- drafto-factory-ci-infra:<sha12> -->`) with the `gh run rerun` commands. The card **stays where it is**: Approved, or In Review. The Claude fix agent is never spawned for it. A card held in In Review keeps its worktree slot. During a runner outage nothing can get through CI anyway, but if you need the slot back, re-run the checks or drag the card to Blocked.
  - If the job lookup fails, the tick is skipped and the next one classifies again.
- **CI is red.** Anything else: `FAILURE`, `ERROR`, `ACTION_REQUIRED`, `STARTUP_FAILURE` (often a workflow file the PR itself broke), a job that timed out (`CANCELLED` or `TIMED_OUT`) in `pnpm install`, the build or the tests (likely a hang in the code; a PR's dependency or lockfile change can hang the install), a job someone cancelled by hand, or a cancelled check that isn't an Actions job.
  - `--watch` runs its fix loop as before. A `noop` pass on red CI spends an attempt and records the head SHA and the red checks as `ciNoop` (`"<sha>:<names, sorted, newline-joined>"`). When the next tick sees the same red on the same head (those checks, or some of them while a re-run is still going), it doesn't start another Claude pass. Instead it re-runs those checks with `gh run rerun <run> --failed`, under the same `ciRerun` budget as the "CI couldn't run" case. When the re-runs are spent and the checks are still red, the factory posts one comment (`<!-- drafto-factory-ci-noop-hold:<sha12> -->`) with the commands, sets `lastError`, and moves the card to **Blocked**, freeing its slot unless its worktree holds commits the PR lacks. The migration renumber gate still runs first on those ticks, and a card that `--release` or the Testing stage hands back to In Review for red CI has the record cleared, so it gets the fix pass the hand-back promises. Before this, #899 spent ten `noop` passes on one head ([ADR-0102](../adr/0102-factory-reruns-red-ci-after-noop-pass.md)).
  - Nothing picks cards out of Blocked, so push a fix and drag the card back to In Review: the new commit re-arms the factory. To give the fix agent another pass on the same commit, clear the record in the live state file in `drafto-factory`, then drag the card back to In Review: `node scripts/lib/state-cli.mjs factory:set-issue-field <n> ciNoop "" --state-file logs/factory-state.json`. If you re-ran the checks yourself, drag the card back once they're green; dragging it back while they're still red sends it straight back to Blocked (with no second comment).
  - `--release` posts one comment (`<!-- drafto-factory-ci-red:<sha12> -->`) listing the failures and moves the card back to **In Review** for the fix loop, the same as an unresolved review thread. It comes back to In Test, and the Approved drag is required again. See [ADR-0041](../adr/0041-factory-ci-red-and-cancelled-checks.md).

All three markers are keyed on the head SHA, so a new push re-arms them. The re-run budget is stored per issue as `ciRerun` (`"<sha>:<count>"`) in the **live** state file in `drafto-factory`. To grant a fresh budget on the same commit, run `node scripts/lib/state-cli.mjs factory:set-issue-field <n> ciRerun "" --state-file logs/factory-state.json` there.

### A PR that conflicts with main (self-healing)

On 2026-10-27 #688 was approved while its PR #755 conflicted with `main`: it and #757 had both added an ADR numbered 0059. `--release` commented once and left the card in Approved, where it kept its worktree slot. With the other slot held by an In Test card, #718 couldn't start for two days. (Since [ADR-0070](../adr/0070-factory-in-test-frees-slot-and-updates-behind-prs.md), neither In Test nor Approved holds a slot.) Nothing in the factory merged `main` into a PR branch, and the comment's advice, to comment a change request, reached no mode.

Now a conflict is handed back to the fix loop like red CI ([ADR-0061](../adr/0061-factory-resolves-merge-conflicts.md)):

- **Approved and In Test.** `--release`, and the In Test sweep when no feedback is pending, post one comment per head SHA (`<!-- drafto-factory-conflict:<sha12> -->`) and move the card back to **In Review**. `--release` checks this before the CI gate, because GitHub runs no `pull_request` CI on a conflicting head.
- **In Review.** `--watch` runs a conflict pass before any CI wait. Bash merges `origin/main` into the branch (`worktree-cli.mjs merge-main`). A failed fetch of main skips the tick at no cost. The merge passes `-c core.attributesFile=scripts/lib/adr-index.gitattributes`, which merges `docs/adr/README.md` with git's `union` driver ([ADR-0105](../adr/0105-factory-adr-index-union-merge.md)): two PRs that each appended an index row merge cleanly instead of stopping on a conflict. It passes it only when a preview merge of the index (`git merge-file --diff3` on temporary copies) conflicts on index rows alone. When both sides also changed another line of the README, such as the intro or a re-padded table's header, union would keep both wordings, so the README conflicts as it used to and the watch agent settles it (`adrIndexUnion: false` in merge-main's result). When both sides' rows were in number order, merge-main sorts the merged rows and amends the merge commit (`adrIndexReordered` in its result).
  - **Clean merge.** Bash pushes it, with no Claude run and no attempt spent. A clean merge that leaves a migration-order error (`migrationErrors` in the `merge-main` result) isn't pushed: the watch agent gets it, like an ADR clash, and renumbers the PR's migrations on top of the merge. It only gets that far when the migration renumber gate couldn't rename them mechanically (see "A PR whose migrations main moved past"). An `up-to-date` result made no merge, so it waits for GitHub as before, whatever the order check says, and the red CI reaches the fix loop on a later tick.
  - **Conflicts, two ADRs sharing a number, or an ADR the index lists twice.** The watch agent resolves them, renumbering the PR's own ADR, and commits the merge without pushing. The union driver keeps both versions of an index row both sides edited (a status change on each side), so merge-main reports such an ADR in `adrIndexDuplicates` and bash counts it as an ADR clash. A conflicted `pnpm-lock.yaml` is regenerated with `pnpm install`, never hand-edited. Bash then checks the commit with `merge-check`: merge committed with nothing left uncommitted, main in `HEAD`, no conflict markers, no ADR clash, no ADR listed twice in the index and no migration-order error in `HEAD`. Only then does bash push it, so a failed resolution never reaches the PR. A verified resolution spends no attempt.
  - **Any other ending.** Bash rolls the worktree back (`merge-abort --to <pre-merge head>`, which also removes untracked leftovers) and spends one attempt. A conflict where main rewrote the code the plan changes, or a lockfile `pnpm install` can't produce, ends in **Blocked** with a PR comment.
- The card then goes through CI, review and In Test again, and needs a fresh **Approved** drag.

The `--watch` log says what happened: `merged origin/main into PR #<n>'s branch: <status> (conflicted: …; ADR clashes: N)`, where N counts both ADR file clashes and ADRs the index lists twice, followed by `pushed the merge`, `conflict pass merged main`, or the reason it rolled back. A resolution the agent made is pushed by bash and logged as `push of <sha12> accepted`. The PR page can take a few seconds to show it, which is expected ([ADR-0076](../adr/0076-factory-watch-effort-and-retry-budget.md)). `the resolution never reached the PR` now means the push itself failed: look for the git error just above it. To resolve a conflict by hand instead, merge `main` into `factory/issue-<n>` and push. The next tick sees a mergeable PR and carries on.

**Fewer ADR clashes to begin with ([ADR-0105](../adr/0105-factory-adr-index-union-merge.md)).** When the approved plan mentions `docs/adr` or the word ADR in any case, `build_implement_bundle` runs `node scripts/lib/adr-allocate.mjs next-adr --root <repo>`, with `--own-pr <n>` on a revision. It fetches `main`, lists the numbered ADR files the open PRs add or rename (the same per-PR files sweep and 60-second budget as the migration versions below) and puts `adr: {mainNewest, next, own, claimed}` in the bundle. `next` is one past the highest number `main`, any other open PR or the card's own PR uses; the implementer names its new ADR with it. If the lookup fails, the log says `couldn't pick an ADR number for the implement bundle`, the field is `null`, and the implementer takes the number after the highest on `main`. If the bundle can't be rebuilt with the field, the log says `couldn't add the ADR number to the implement bundle` and the bundle goes ahead without it (the migration versions are added in a rebuild of their own). Two runs that start before either PR is open can still take the same number; the conflict pass above renumbers one. To see what it would pick, run the same command in `drafto-factory`.

### A PR that is behind main (self-healing)

On 2026-11-09 #794 reached In Test with PR #802 behind `main`. It had branched five minutes before #801 bumped desktop to 0.4.5, and App Store Connect had already closed the 0.4.4 train, so the desktop pre-merge beta failed all three attempts (`The train version '0.4.4' is closed for new build submissions`). Only `--release` ever updated a behind branch, and that runs after you approve.

Now `--watch` brings an In Review PR up to date before it hands the card to you ([ADR-0070](../adr/0070-factory-in-test-frees-slot-and-updates-behind-prs.md)):

- **When.** As the last check before Testing or In Test. By then required CI is green, the code review has run, the CodeRabbit lane has decided and the hosted-config gate has passed, so no update is spent while the card waits on any of them. It asks GitHub's compare API how far `main` is ahead of the head (`behind_by`), rather than `mergeStateStatus`, which reads `UNKNOWN` right after `main` moves.
- **How.** It calls update-branch with `expected_head_sha` pinned to the head it read. That is a merge commit: the factory never force-pushes, so it never rebases. No issue comment is posted. It records the commit it updated (`branchUpdatedFrom`), and so does `--release` when it updates. The card keeps its slot: a later resume fast-forwards the worktree to the merge. It won't update a branch whose worktree, or kept local branch, holds commits the PR lacks, for example a fix whose push never landed. It logs `worktree has commits the PR lacks; not updating the branch`, and the card goes on as it stands. Push or drop those commits by hand. If the budget can't be read or recorded, it doesn't update either (`counting it as spent` / `couldn't record a branch update`).
- **What re-runs.** CI, on the merged head. The code review doesn't, and neither does CodeRabbit if it had decided the old commit. The merge commit inherits both, because the PR's own change hasn't moved: `<sha12> only merges main into the reviewed <sha12>; carried its code review and CodeRabbit coverage over`. Only a merge GitHub committed itself (`web-flow`, `Merge branch 'main' into …`) on top of the recorded commit inherits them. A push on top of it, a conflict resolution committed locally, or any other new head is reviewed as usual. The card goes on to In Test on a later tick.
- **Bound.** Each attempt counts toward `FACTORY_MAX_BRANCH_UPDATES` (default `3`), stored per issue as `branchUpdates`. It resets when `--implement` moves the card to In Review and when the card reaches In Test. Once that is spent, the card goes on as it stands, and `--release` updates it at merge time.
- **When the update fails.** If the head moved or mergeability is unknown (update-branch rejects a conflict GitHub hasn't flagged yet), the card holds for a tick. For anything else, it logs a WARNING and goes on.
- **Not covered.** A card already in In Test, or in Testing, isn't updated when `main` moves, because that would change the commit you're testing. A revision that changes code passes back through In Review and gets updated there. A no-op or declined revision returns to In Test on the head you already saw. `--release` updates the branch before the merge.

Log lines: `PR #<n> was <k> commit(s) behind main; updated the branch`, `… carried its code review … over`, `… branch update(s) are spent; going on as it stands`, `update-branch for PR #<n> didn't apply (…); rechecking next tick`. To grant a fresh budget, run `node scripts/lib/state-cli.mjs factory:set-issue-field <n> branchUpdates "" --state-file logs/factory-state.json` in `drafto-factory`.

### A PR whose migrations main moved past (self-healing)

PRs #802 and #829 were open at the same time, and both added migration `20261111000001`. Once #829 merged, #802 would have gone red on the order check. `--release` would have handed it back to In Review, and it would have taken an LLM fix pass, a fresh review and a second Approved drag, all for a rename. `--release` also merged a PR whose `mergeStateStatus` read `UNKNOWN`, which it does right after `main` moves.

Now the factory renames such a PR's migrations itself ([ADR-0077](../adr/0077-factory-renumbers-migrations-mechanically.md)):

- **When.** Only for a PR whose `gh pr diff --name-only` lists a `supabase/migrations/*.sql` file.
  - `--release` checks it after the `migration-approved` and conflict gates and before the CI gate, when the compare API says `main` is ahead of the head, a required check is failing, or the compare fails. A head that already holds `main` and isn't red is left alone.
  - `--watch` checks it when an In Review PR is behind `main` (before the update-branch), and at the fix loop's entry when CI is red or the PR conflicts. That is before the conflict pass merges `main` and before any attempt is spent.
  - `--implement` checks it right after a run opens or updates the PR, once the parity post-check passes (`implement_migration_claim_check`, [ADR-0079](../adr/0079-factory-allocates-migration-versions.md)). This is the only call that passes the gate's `claimed` mode (`--move-off-claimed 1`, plus `--new-since <PR head before the run>`, or `--new-since all` for a brand-new PR). In that mode it also renames a migration whose version an open PR **with a lower number** already adds, and a migration the run itself added whose version **any** open PR adds. A migration that was already on the PR never moves for a newer PR. The comment then says `was already used by open PR #<n>`, with `and this implement run added it` for the second kind. It renames on the head bash read after the run (`POST_HEAD_OID` on a revision) and plans with the bundle's `migrations.claimed` (`--claimed-json`), so it reads neither the head nor the open PRs again; a bundle without claims makes precheck sweep them. It doesn't read or spend `migrationRenumbers`: it runs once per implement run, and the merge-time renumbers keep the whole cap. A rename that needs a person or an error only logs `migration version post-check on PR #<n> ended '<result>'; going on`, with no manual comment, and the card goes on to In Review. Main hasn't moved, so nothing is red, and the `--release`/`--watch` checks above catch the clash once the other PR merges.
- **What it does.** `node scripts/lib/migration-renumber.mjs precheck` plans the rename with the order check on the files the merge would hold, skipping versions other open PRs use. It reads each open PR's files with `gh api --paginate repos/…/pulls/<n>/files`. A PR it can't read is skipped and logged (`couldn't list PR #<n>'s files`), so its versions aren't avoided this time. When the plan is fixable, `apply` takes precheck's list instead of reading the open PRs again, and:
  - builds commit R on the PR head, as `Drafto factory`, in `$REPO_ROOT` with no worktree. R renames the migrations and rewrites the references the PR itself added to them;
  - checks R with `verify` and pushes it to `factory/issue-<n>` without force.

  Then the gate records `renumberFrom`, `renumberTo`, `renumberMap` and `migrationRenumbers`, waits until GitHub shows R as the PR head (up to 5 reads, 2 seconds apart), and calls update-branch on R, so GitHub merges `main` in. If GitHub still shows the old head, it skips the update (`GitHub doesn't show it as the PR head yet, so a later tick updates the branch`): the head is R either way. It never spends `attempts`, `branchUpdates` or `ciRerun`.

- **The comment.** One per R (`<!-- drafto-factory-migration-renumber:<sha12> -->`): the old → new table and the dev repair (`supabase migration repair --status reverted <old>`, then `--status applied <new>`), needed only if dev applied the old version. See [`migrations.md`](./migrations.md#when-the-factory-renumbers-a-prs-migrations) for the case where the old version is also one of `main`'s. Prod needs nothing: it is pushed only from `main`, after the merge.
- **Approval carry-over.** In Approved the card **stays in Approved** and merges once CI is green on the merged head. In `--watch`, R and GitHub's merge onto R inherit the code review and CodeRabbit coverage of the head R renamed: `<sha12> only merges main into the migration renumber of the reviewed <sha12>; carried its code review … over`. They inherit it only when `verify` passes again. If it fails (`migration renumber <sha12> failed its check`), the head is reviewed as usual.
- **Left to the fix loop.** It renames nothing and posts one comment per head (`<!-- drafto-factory-migration-renumber-manual:<sha12> -->`) when:
  - a version isn't 14 digits, or the PR renames a migration `main` already has;
  - the PR's migrations touch an object that one of `main`'s newer migrations also touches. Renumbering changes which definition runs last;
  - a line the PR added names a bare version that may mean another migration.

  The card isn't held. It goes on as before ADR-0077: the plain update-branch, then the fix loop's "Migration order" recipe on the red CI. In Approved the CI gate hands it back to In Review, and it needs approval again. Check the rename before you approve, especially for an object overlap. To rename by hand instead, use the `git mv` lines `pnpm migration:check` prints and push; the new head goes through the gate again.

- **Cap.** At most `FACTORY_MAX_MIGRATION_RENUMBERS` (default `3`) merge-time renumbers per card, stored as `migrationRenumbers` and never reset by the factory. The implement post-check's renames don't count. Past it, or when the count can't be read, the gate renames nothing and posts one comment per head (`<!-- drafto-factory-migration-renumber-cap:<sha12> -->`), and the card goes on to the fix loop as above. To grant more, run `node scripts/lib/state-cli.mjs factory:set-issue-field <n> migrationRenumbers "" --state-file logs/factory-state.json` in `drafto-factory`.
- **Errors.** A failed lookup, precheck or push (`migration renumber of PR #<n> didn't land (rejected: …)`) holds an Approved card for the tick (`holding in Approved, retrying next tick`). It holds at most `FACTORY_MAX_MIGRATION_RENUMBER_ERRORS` (default `3`) ticks per head, counted in `renumberErrors` as `<head sha>:<count>`; a new head starts again at zero. Then it posts one comment per head (`<!-- drafto-factory-migration-renumber-error:<sha12> -->`) and the card goes on to the CI gate as before ADR-0077. If it can't read or record the count, the card goes on too. To let it hold again on the same head, run `node scripts/lib/state-cli.mjs factory:set-issue-field <n> renumberErrors "" --state-file logs/factory-state.json` in `drafto-factory`. In `--watch` an error runs the old path instead: the plain update-branch, or the fix or conflict pass. A push the remote rejected because the branch moved gives the count back.
- **The BEHIND step.** For every PR, `--release` updates the branch when the compare API says `main` is ahead of the head, as well as on `BEHIND`. It waits while `mergeStateStatus` reads `UNKNOWN` (`GitHub still computing?); waiting`). It reuses the compare it read before the renumber gate.

**Fewer clashes to begin with ([ADR-0079](../adr/0079-factory-allocates-migration-versions.md)).** For a card whose spec says schema changes, `build_implement_bundle` runs `node scripts/lib/migration-renumber.mjs next-version --root <repo>`, with `--own-pr <n>` on a revision. That fetches `main`, lists the files the open PRs add or rename into `supabase/migrations/`, and puts `migrations: {mainNewest, ownNewest, versions, claimed}` in the bundle. `versions` are five versions in order, each after `main`'s newest, after the newest migration the card's own PR adds and after today's `000000`, and none another open PR uses. The implementer names its new migrations with them, in order. `claimed` leaves out claims at or below `main`'s newest. If the lookup fails, the log says `couldn't pick a migration version for the implement bundle`, the field is `null`, and the implementer falls back to the date rule. If the bundle can't be rebuilt with the field, the log says `couldn't add the migration versions to the implement bundle` and the first bundle goes ahead. The post-check above still catches a clash. To see what it would pick, run the same command in `drafto-factory`. A factory session never runs `pnpm migration:check`'s open-PR warning: the factory exports `DRAFTO_UNATTENDED`, which its claude runs inherit.

Log lines: `renumbered PR #<n>'s migrations (<old> -> <new>) in <sha12> and updated the branch` (at implement usually `… update-branch didn't apply`, because the PR isn't behind), `PR #<n>'s migrations need a person to renumber them: <reason>`, `needs another migration renumber …, but <k> of <max> are spent; leaving it to the fix loop`, `migration renumber gate errored <k> time(s) on PR #<n> at <sha12>; going on to the CI gate`, and in the conflict pass `leaves <k> migration-order error(s) (…); handing the merge to the agent`.

### Who holds a worktree slot

There are two slots (`SLOT_COUNT` in `scripts/lib/factory-state.mjs`). A card holds one only while the factory is working on it: In Progress, In Review and Testing. The `--watch` cleanup sweep reads each slot holder's column on the factory board from its issue (`gh issue view --json state,projectItems`). Once the card is anywhere else, or its issue is closed, the sweep frees the slot and removes the worktree but keeps the branch. That includes In Test, where nothing uses the worktree ([ADR-0070](../adr/0070-factory-in-test-frees-slot-and-updates-behind-prs.md)). The sweep reads the column, never the `status:*` label, because a card you drag by hand keeps the label of the column it left. A plan you approve by dragging it out of Plan Review still says `status:plan-review` in In Progress. If the column can't be read, the sweep frees only a closed issue's slot that tick (`couldn't read its column on the Drafto Factory board; leaving slot for next tick`). That happens when the token lacks `project` scope, when the issue has no card on that board, or when the board was renamed. A slot holder dragged off the board therefore keeps its slot until its issue closes, or you run `factory:slot-release`.

- **Coming back.** A revision from In Test, or a hand-back to In Review, takes a free slot and rebuilds its worktree from the PR branch. That costs one seed plus `pnpm install`. `--implement` takes cards in this order: those already holding a slot, then those with an open PR, then fresh ones. `--watch` runs before `--implement`, so returning work gets a freed slot first. It can still wait for one of the two cards already working to finish.
- **No-op and declined revisions** free their slot as soon as they're back in In Test, so the next card in the same sweep can use it.
- **A refused slot claim defers the card (#466).** `--implement` and `--watch` both claim a slot through `slot_acquire`, which reads `factory:slot-acquire`'s JSON: the CLI exits 0 even when it refuses (`ok:false`, `reason: "slot-occupied"`), which it does when the slot's recorded pid is alive. `factory-agent-loop.sh` runs the modes one after another under one mutex, so this only comes up when you run a mode by hand alongside the loop, or with a detached implement run (`implement-lane.mjs _supervise`, [ADR-0085](../adr/0085-detached-implement-runs.md)). The card waits for a later tick when another issue holds the slot (`slot <n> is held by #<m> (pid <p>); deferring to a later tick`), or when its own slot is held by its detached implement run (`held by its own running implement`) or by another `factory-agent.sh` process (`held by another running factory-agent.sh for this issue`). Any other live pid on the card's own slot was reused since, so the claim takes the slot back with `--force true` (`which isn't working on it; taking it over`). Before this, a refused claim went unnoticed: `--implement` went on as if it held the slot, and `--watch` ignored the answer (`|| true`).
- **Held by a detached implement run ([ADR-0085](../adr/0085-detached-implement-runs.md)).** With `FACTORY_IMPLEMENT_DETACHED=1`, a started run's supervisor takes over its card's slot (`factory:slot-status` shows the supervisor's pid), and its worktree is `git worktree lock`ed until the run is collected. The slot stays with the card after collection, as it did after a synchronous run. The cleanup sweep, and every other slot release, stops the run first (SIGTERM, then SIGKILL a minute later) and keeps the slot and worktree while anything of it is alive: `keeping slot + worktree for #<n> while its detached implement run may still be alive`. A run stopped that way is not collected; its uncommitted work is snapshotted with the worktree as usual.
- **Held by the hosted-config gate.** An In Review card the hosted-config gate holds for you (see "Hosted Supabase config gate") frees its slot on the first tick of the hold: `waiting on the hosted config; freeing its worktree slot meanwhile`. A tick held only for a transient error keeps the slot. The hold waits on you, so it can last days, and only a fix pass needs the worktree. A card whose worktree holds commits the PR lacks keeps its slot. The CodeRabbit lane's hold is bounded, and a card there keeps its slot.

### A worktree behind its PR branch, with uncommitted leftovers

When a worktree is resumed, `worktree-cli.mjs add --fetch` fast-forwards it to the PR branch if someone else pushed meanwhile: "Update branch" on GitHub, the behind-main update, `--release`, or you. Uncommitted leftovers used to block that. The resume threw, `--watch` released the slot without spending an attempt, and the card retried silently every tick. Typical leftovers are an unfrozen install's `pnpm-lock.yaml`, a fix pass cut off mid-edit, or a hand edit. Now they are set aside first, never deleted ([ADR-0070](../adr/0070-factory-in-test-frees-slot-and-updates-behind-prs.md)). They are snapshotted, new files included, under `refs/factory-leftovers/factory/issue-<n>/<sha12>-<ms>`, and the worktree is reset and fast-forwarded. The log names the ref: `the worktree was behind the PR with uncommitted leftovers; set them aside at <ref>`.

A worktree the factory removes takes the same snapshot first: `kept the removed worktree's uncommitted changes at <ref>`. That happens when the card reaches In Test, when the hosted-config gate holds it, or when it is blocked. So an edit you make in `worktrees/factory-issue-<n>` while a card waits on you isn't lost. If the snapshot fails, the worktree is left in place (`WARNING: … worktree not removed`).

Run these in the factory checkout:

```bash
git for-each-ref refs/factory-leftovers
git -C worktrees/factory-issue-<n> stash apply <ref>
git update-ref -d <ref>
```

The first lists the snapshots, the second restores one into the worktree, and the third drops one. Nothing prunes them.

A worktree that has **diverged** from the PR branch (commits on both sides), or has a merge in progress, still fails the resume with `reconcile … by hand`. Push or drop the local commits, or finish or abort the merge, in `worktrees/factory-issue-<n>`.

## Driving a card from an interactive session

A card can be driven from an interactive Claude Code session instead of the factory, and handed back in any column but Planning (a card in Planning goes back to Ready). Handing a card past a human gate needs that gate's approval logged first. Run `/drive-issue <n>` in Claude Code; it does every step below. The manual is [interactive-driving.md](../features/interactive-driving.md), the decision [ADR-0091](../adr/0091-interactive-issue-driving.md). #861 (PR #877) was the hand-driven prototype.

What matters on the factory side:

1. **The claim is the `driver:interactive` label.** `node scripts/drive-issue.mjs claim <n>` adds it, and from the next tick on every factory mode skips the card (`card_opted_out`, the same skip as `factory-pause`). Before claiming a card the factory may be working, check on the Mac mini:
   - **A tick already running.** The label is read when a tick starts, so a running tick can still change the card. Wait for it to end (`pgrep -fl factory-agent.sh` shows none running).
   - **A detached implement run** ([Detached implement runs](#detached-implement-runs)) isn't stopped by the label. Once it ends, the label holds its result back uncollected, and the run keeps its slot and worktree lock. If `node scripts/lib/implement-lane.mjs status --issue <n>` lists a run, live or ended, and the session is taking over, stop and release it as "Stopping a run" there describes: from the factory checkout, between ticks, with `node scripts/lib/implement-lane.mjs kill --issue <n> --finish 1 --outcome stopped --repo-root "$PWD"`.

   `claim` refuses a card in Planning, In Progress, In Review, Testing or Approved without `--force` for exactly these reasons, and refuses a card another session already claimed unless `--resume` is passed.

2. **The session leaves the factory's artifacts.** It uses branch `factory/issue-<n>` and the PR marker. The plan comment has the planner's marker and structure. The scenario ends with the three scenario markers (the full SHA). Moves set Status and the `status:*` label together (`drive-issue.mjs move`). Its log comments carry `<!-- drafto-factory-session:… -->`, so they never read as your feedback.
3. **Pre-merge betas** built in the session run with `DRAFTO_INTEST_ISSUE=<n>`, as the factory's do. The lanes skip the release tag and post the `drafto-factory-intest-build:<platform>:<build>` marker that scenario preflights check. An In-Test scenario under `apps/desktop/e2e/in-test/scenarios/` that writes to production is started by a person, not by the session ([macOS In-Test automation](./macos-in-test-automation.md#who-starts-a-run)).
4. **Handing back:** `node scripts/drive-issue.mjs release <n> --to <Column> --note "…"`. It checks the column fits (In Progress and later need the plan comment, and In Review and later need an open PR on `factory/issue-<n>`). It adds the PR marker if missing, logs what the factory does next, then removes the label. It withdraws the log entry if the label can't come off. Push everything first: a branch with commits the PR lacks makes `worktree-cli add` fail as diverged, and the implement stage spends an attempt on it each tick.
5. **Merging from the session:** `drive-issue.mjs gates <n> --log` runs the `--release` checks in the same order before `/merge`. For a head the CodeRabbit bot skipped, `/merge` runs the CLI review first ([Reviewing a hand-made PR with the CLI](#reviewing-a-hand-made-pr-with-the-cli)). The post-merge beta then runs from `main`, either the primary checkout after `git pull && pnpm install` or a fresh worktree of `origin/main`, and tags `desktop@<version>+<build>`.

## Rollback drills

The factory's blast radius is bounded by:

1. **Pre-merge.** Worst case, a PR is opened with bad code. Closing the PR (and removing its `factory/issue-<n>` branch) reverts to zero side effects. For a salvageable PR sitting in In Test, prefer the **In Test iteration loop** — comment the change you want and the factory revises the same PR in place — over closing and re-filing.
2. **Post-merge but pre-release.** Vercel auto-deploys main → prod on merge. If the factory merged something bad, follow the standard web rollback: `vercel rollback <previous-deployment-id>` from the Vercel dashboard. The web app is back in <60 s.
3. **Post-merge and post-beta-dispatch (Phase D only).** TestFlight / Play internal builds are pre-authorised and reversible — the next build supersedes the bad one. No store-public users are affected (production app-store submissions stay manual; see CLAUDE.md "Release Authorization").
4. **Schema migration.** The migration gate refuses to merge a PR with `supabase/migrations/**` files unless `migration-approved` is on the PR, and the label comes off if the SQL changes after it was added. If a bad migration _did_ land, follow [`docs/operations/migrations.md`](./migrations.md) → "Rolling back a migration".

Practice drill (do once per month while the factory is active):

- File a trivial test issue ("test: bump footer copyright year"), drag through to Released.
- Verify Vercel rollback works for that exact commit before declaring the drill green.

## On-call response — `factory-failure` issue appears

The factory's `cleanup()` trap files a `factory-failure`-labelled GitHub issue when a run errors out, and the toolchain health check files one when a host tool breaks (see "Automatic toolchain pause"). `nightly-audit.sh` does **not** sweep these, and GitHub does not notify Jakub about issues filed with his own token, so check the label by hand. Toolchain faults also arrive by email. When you see one:

1. **Read the issue body.** Sanitised log tail is included (timestamps only — no bundle PII, same regex pattern as `support-agent.sh`).
2. **Check `logs/factory-*.log` on the Mac mini** for the full context.
3. **Common causes** (in approximate order of frequency):
   - Network blip during `gh` call (transient — usually resolves on the next tick).
   - Broken host toolchain: git failing on an unaccepted Xcode license after an Xcode update, missing Command Line Tools, or a binary gone from `PATH`. The toolchain health check pauses the factory and emails the fix; see "Automatic toolchain pause".
   - Worktree slot leaked (a previous run died without releasing it). `node scripts/lib/state-cli.mjs factory:slot-status` shows each slot's PID + issue; if the PID is dead, `node scripts/lib/state-cli.mjs factory:slot-release <slot>` then `node scripts/lib/worktree-cli.mjs remove --issue <n> --force`. (`--watch`'s cleanup sweep also auto-releases slots whose board card has left the active In Progress/In Review/Testing columns — e.g. reached In Test, merged, Blocked, or closed; see "Who holds a worktree slot". Since ADR-0033 that sweep removes the worktree but **keeps** the local branch whenever a PR still points at it, so a card dragged back to In Progress resumes on its own commits.)
   - Disk full under `worktrees/` — the factory now refuses to start an implement when free space is below `FACTORY_MIN_FREE_DISK_GB` (it parks the card in Blocked with a `disk-low` comment), so a mid-build ENOSPC should be rare. Reclaim space via `git worktree prune` (and `node scripts/lib/worktree-cli.mjs list` to see the factory's worktrees); see "Worktree installs & disk" for the full reclamation runbook.
   - Claude wall-time cap hit on every retry (the prompt or context bundle is too large). Inspect the bundle in the log; truncate prior PR threads if needed. (A Claude _session usage_ limit is handled separately — the factory auto-pauses until reset instead of failing; see "Automatic pause on a Claude session limit".)
4. **Close the failure issue** once resolved. The trap doesn't auto-close; that's intentional so the issue is visible until acknowledged.

If the same failure mode files >3 issues in 24h, pause the factory globally (`factory:pause`) and open a regular bug to fix the root cause.

## Recovering a card whose feedback was falsely consumed

Applies to cards worked before [ADR-0033](../adr/0033-factory-branch-safety-and-implement-verification.md). Symptom: an open PR, a reporter comment asking for a change, and a factory log line saying "revision pushed" — but the PR head never moved and `--watch` keeps re-presenting the same preview.

The feedback high-water mark was advanced past the comment, so no future tick will read it. Rewind it, clear the retry counter, and make sure the branch is present:

```bash
# 1. The comment's own createdAt, minus a second, from:
#    gh issue view <n> --json comments --jq '.comments[] | "\(.createdAt) \(.author.login)"'
node scripts/lib/state-cli.mjs factory:set-issue-field <n> lastFeedbackAt "<iso-just-before-the-comment>"
node scripts/lib/state-cli.mjs factory:reset-attempts <n>

# 2. Restore the local branch if the old sweep deleted it. --fetch now does this
#    automatically on the next tick, but doing it by hand is instant and safe.
git fetch origin factory/issue-<n>
git branch factory/issue-<n> origin/factory/issue-<n> 2>/dev/null || true
```

Then drag the card to **In Progress**. The next `--implement` tick re-reads the comment, resumes on the PR's own commits, and — if it still fails to push — now stops instead of claiming success.

To find stray branches and stale remote-tracking refs left by the old behaviour:

```bash
git fetch --prune origin                       # --release deletes remote branches without pruning
git branch --list 'factory/issue-*'
gh pr list --state open --json headRefName --jq '.[].headRefName'
node scripts/lib/worktree-cli.mjs list
```

Delete any local `factory/issue-*` that has no open PR and no worktree. A branch backing an open PR is now kept deliberately — don't prune those.

## Coexistence with `nightly-support.sh` Phase 3

Phase 3 (existing midnight implementation pass) and the factory's `--implement` mode could operate on overlapping issue sets. **Revised 2026-06-21: Phase 3 is no longer deprecated** — it stays running unchanged across all factory phases, and the factory is kept off its queue by a factory-side guard. The coexistence model is:

| Factory phase | Phase 3 status                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A             | Phase 3 keeps running. Factory only `--plan`s; no overlap.                                                                                                                                     |
| B             | Phase 3 keeps running. Factory `--implement`s only `status:ready` cards set by humans; Phase 3 still picks up `support`-labelled issues without `status:*`.                                    |
| C             | Phase 3 keeps running, **unchanged (no cutover)**. The factory may now implement mobile/desktop, but its `--implement` queue skips `support`-labelled issues, so the two tracks stay disjoint. |
| D             | Phase 3 keeps running, **unchanged (not removed)**.                                                                                                                                            |

Collision avoidance is **factory-side**: the `--implement` queue excludes `support`-labelled issues (and `--release` skips them too), so the factory never claims an issue Phase 3 owns. To hand a support issue to the factory deliberately, a human removes the `support` label — the factory then sees it as an ordinary board card. (Belt-and-braces: if both ever target the same issue, the factory's worktree-slot lock blocks Phase 3's attempt and Phase 3 logs "issue #N already has a factory worktree".)

**Shared beta build roots.** The nightly's Phase 4 ships merged support fixes from the factory's beta build roots, under the root lock described in [Pre-merge beta dispatch](#pre-merge-beta-dispatch-in-test). In the factory log, "beta build root … is in use by pid N" at night usually means the nightly is building there. The In Test card retries on a later tick. The nightly does the same in reverse and retries on the next night. See [support-agent.md → Stage 2 releases](../features/support-agent.md#stage-2-releases-nightly-beta-dispatch).

## Plan size and the oversize label

Every plan has a **Size** section and ends with `<!-- drafto-factory-plan-size:<class>:<estLines> -->` ([ADR-0083](../adr/0083-planner-size-estimate-and-oversize-label.md); what you see on the issue is in [dark-factory.md](../features/dark-factory.md#plan-size-and-the-factory-oversize-label)). After a `planned` or `replanned` run (and a first-plan `noop`), `plan_size_label` reads the marker from the OWNER plan comment (`scripts/lib/plan-size.mjs`) and compares it with the board item's labels. The replan sweep also does this on every tick for every Plan Review card, from the plan it already reads, so a failed edit is retried on the next tick. At or above the threshold it adds `factory-oversize`, and below it removes the label again. A plan with no marker leaves the label alone. The plan's **Proposed split** is advice for you. The factory files it as sub-cards only when you comment `/split` (next section).

**The oversize hold** ([ADR-0103](../adr/0103-factory-oversize-hold.md)). In `--implement`, right after `find_prior_pr` and before a slot or worktree is spent, `oversize_hold` re-reads the approved plan's marker. It holds the card when the estimate is at least `FACTORY_PLAN_OVERSIZE_LINES`, neither the board item nor the issue has `oversize-approved`, and the card hasn't started: no prior PR (open or closed), no slot assigned to the issue, no implement resume record, no `implementSessionId` in its state, and no `factory/issue-<n>` branch on origin (work an interactive session pushed without a PR). `lastImplementAt` doesn't count, since the Phase A stub writes it. If `find_prior_pr` fails, the card waits a tick (`couldn't look up its PR; deferring`) and never reaches the hold. The hold still lists the PRs again itself before it sends a card back. It doesn't use `attempts`, which `--plan` shares: a failed replan followed by a `noop` one leaves it above 0 on a card that has never been implemented. A held card gets one 🏭 comment marked `<!-- drafto-factory-oversize-hold:<planCommentId>:<estLines> -->` and moves to **Plan Review**. The comment goes first and the move only once it is posted, so either failure retries on the next tick without a duplicate. A replan that changes the estimate gets a new comment; the same estimate never gets a second. The `ls-remote` is capped at `FACTORY_GH_TIMEOUT_SEC`, like a `gh` call. If `factory-state.json` can't be read, or the PR list or the `ls-remote` fails or times out, the card waits a tick rather than bounce or start (`couldn't read …`, `couldn't list its PRs …` or `couldn't check origin … for the oversize hold; deferring`). A dry run logs `DRY-RUN: would hold #<n>`. To release a card: comment `/split` (once ADR-0104 ships; until then it starts a replan), or add `oversize-approved` and drag it to **In Progress**, or replan it under the threshold and drag it to **In Progress**. The override isn't voided when the plan changes.

| Var                           | Default | Purpose                                                                                                                                                                                                  |
| ----------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_PLAN_OVERSIZE_LINES` | `1500`  | The estimated added lines at which a card gets `factory-oversize`. `0` turns the label and the hold off. A bad value (not an integer from 0 to 9,999,999 without a leading zero) warns and means `1500`. |
| `FACTORY_OVERSIZE_HOLD`       | `1`     | `1` holds an unstarted card whose approved plan is oversize in Plan Review until it is split or has `oversize-approved`. `0` turns the hold off. A bad value (not `0` or `1`) warns and means `1`.       |

**One-time setup.** Create the labels with `scripts/setup-factory-labels.sh` on the Mac mini (idempotent; it upserts every factory label). Until then, the plan log shows `the repo has no factory-oversize label … (run scripts/setup-factory-labels.sh)` once per day, and nothing is labelled. The hold doesn't need `factory-oversize`, but an operator can't add `oversize-approved` to an issue until the script has created it, so run it as soon as the hold ships.

## `/split`: filing a plan's Proposed split

An OWNER comment whose whole body is `/split` makes the `--plan` replan sweep file the plan's **Proposed split** as sub-cards instead of replanning ([ADR-0104](../adr/0104-factory-split-command.md); what you see on the issue is in [dark-factory.md](../features/dark-factory.md#splitting-a-card-with-split)). The sweep checks for it right after `plan_size_label`, before the replan logic.

- **Finding the directive.** `split_trigger_ids` takes the directives newer than the plan that pass `owner_comments_since` (OWNER plus the support-forward gate), that no OWNER comment acks with `<!-- drafto-factory-split-ack:<id> -->`, and that the plan body doesn't ack with a `replan-ack` marker (a `/split` the planner already took as feedback, with `FACTORY_SPLIT=0` at the time, never splits later). `split_drop_directives` keeps every directive out of the replan's trigger list.
- **The splitter run.** `split_write_cards` runs `scripts/factory-split-prompt.md` through `run-claude.mjs` with `--tools ""`, at `FACTORY_PLAN_EFFORT` on `${FACTORY_MODEL:-opus[1m]}`, capped like a plan run. The log line is `Invoking claude for #<n> (split, …)`.
  - **Checks.** `factory-split.mjs parse` checks the output, and `spec_missing_section` checks every card.
  - **Results.** Cards that pass are saved to `logs/factory/split/issue-<n>/plan-<planCommentId>.json` (mode 600), with the plan body's sha256 beside them in `plan-<planCommentId>.sha256`. Anything else posts one "Split not filed" comment with the ack. For a failed splitter run (an API error, the time cap) the comment says the plan isn't the problem and a new `/split` comment is enough.
  - **A replan in between.** A replan edits the plan comment in place and keeps its id. When the hash no longer matches and `splitChildren` records no sub-card for this plan yet, the saved cards are deleted and the splitter runs again (log: `the plan changed since its sub-cards were saved`). Once a sub-card is filed, the split finishes from the saved cards.
- **Filing.** `split_file_children` files the cards in order and records each number in `splitChildren` (`<planCommentId>:<total>:<n1>,<n2>…`). Before each create it lists the 50 newest issues and reuses an open OWNER issue that carries that card's `drafto-factory-split-child:<parent>:<planCommentId>:<i>` marker. A closed one is a sub-card of an earlier split of the same plan comment, so it is never reused.
- **Finishing.** `split_link_children` links the sub-issues (best effort). `split_finish` then:
  - runs `factory-project.mjs ensure-item` for each sub-card and moves the first one to Ready;
  - labels the parent `factory-split`;
  - posts the split comment (`drafto-factory-split:<planCommentId>` plus the acks), listing each sub-card's board column;
  - marks the split done (`splitChildren` becomes `done:<planCommentId>:<n1>,<n2>…`) and deletes the saved cards, so a later `/split` of the same plan comment starts afresh;
  - calls `split_park_parent`, which moves the parent to Backlog and strips its `status:*` label.
- **Resuming.** Any failure before the comment leaves the directive unacked, so the next tick resumes from the saved cards and `splitChildren`, without a Claude run. A Plan Review card that carries `factory-split` and its split comment is parked again without a replan.

| Var             | Default | Purpose                                                                                                                                     |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_SPLIT` | `1`     | `0` turns `/split` off: the comment is then ordinary replan feedback. A directive a split already answered never is. A bad value means `1`. |

**Recovering by hand.**

- **To split a split card again.** Close its sub-cards, remove the `factory-split` label, drag the card to Plan Review, and comment what the split should change (the planner revises the plan), then `/split`. A finished split leaves nothing behind that the new one reuses.
- **To restart a split that stopped part-way** (after closing the sub-cards it filed):
  1. Retire the record: `node scripts/lib/state-cli.mjs factory:set-issue-field <n> splitChildren reset` (any value that doesn't start with the plan comment's id; the setter refuses an empty one).
  2. Delete `logs/factory/split/issue-<n>/`.
  3. Comment `/split` again.
- **A first sub-card left in Backlog.** The board's "Item added to project" workflow can race the move to Ready and leave the first sub-card in Backlog. Drag it to Ready.

**One-time setup.** Run `scripts/setup-factory-labels.sh` to create `factory-split`. Until then the parent is parked without the label, and the log says to run the script.

## Claude effort & timeouts

The factory runs `--implement` at **ultracode** effort (xhigh reasoning + dynamic multi-agent workflow orchestration), except a **revision** run (a card with an existing factory PR, open or closed, and new owner feedback), which runs at **xhigh** ([ADR-0101](../adr/0101-factory-pins-model-and-revision-effort.md)). It runs `--watch` fix passes and every **read-only** stage at **xhigh**: `--plan` and replan, the `/split` splitter, the code review, the scenario writer, the browser runner and the verification shell lane. Effort is passed to `claude` via `--effort`; if the Workflows feature is disabled on the account, ultracode degrades safely to plain xhigh (no error). ultracode multiplies token usage on the shared subscription, so dial `FACTORY_EFFORT` down if it pressures rate limits.

`--watch` moved from ultracode to xhigh with [ADR-0076](../adr/0076-factory-watch-effort-and-retry-budget.md). At ultracode, a fix pass on #797 finished its fix, then started a review workflow and waited on it until the 1800s cap killed it with nothing committed. All values are env knobs on the launchd plist's `EnvironmentVariables`:

| Var                                    | Default     | Purpose                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_EFFORT`                       | `ultracode` | `--effort` for `--implement`, except revision runs. Set `xhigh`/`high`/… to cut cost.                                                                                                                                                                                                                               |
| `FACTORY_REVISION_EFFORT`              | `xhigh`     | `--effort` for an `--implement` revision run: the card has a factory PR and new owner feedback ([ADR-0101](../adr/0101-factory-pins-model-and-revision-effort.md)). `ultracode` restores the old behaviour, Workflows included: the run-time facts pass `effort` to the prompt. The log line shows it as `effort=`. |
| `FACTORY_WATCH_EFFORT`                 | `xhigh`     | `--effort` for `--watch` fix passes: CI fixes, review-thread fixes and conflict passes. Independent of `FACTORY_EFFORT`: to cut cost, lower both.                                                                                                                                                                   |
| `FACTORY_PLAN_EFFORT`                  | `xhigh`     | `--effort` for every read-only stage: `--plan` / replan, code review, scenario writer, browser runner (all kinds) and the verification shell lane.                                                                                                                                                                  |
| `FACTORY_MODEL`                        | `opus[1m]`  | `--model` for every factory Claude call, the detached implement run and the verification shell lane, unless a stage knob below names another ([ADR-0101](../adr/0101-factory-pins-model-and-revision-effort.md)). An invalid value warns and falls back to `opus[1m]`.                                              |
| `FACTORY_BROWSER_MODEL`                | empty       | `--model` for the browser runner, all kinds. Empty means `FACTORY_MODEL`; an invalid value warns and falls back to empty (`FACTORY_MODEL`).                                                                                                                                                                         |
| `FACTORY_INTEST_MODEL`                 | empty       | `--model` for the scenario writer (In Test and Testing). Same values and fallback as `FACTORY_BROWSER_MODEL`; see the model note below.                                                                                                                                                                             |
| `FACTORY_MAX_ATTEMPTS`                 | `10`        | Retry budget per card, shared by `--plan`, `--implement` and `--watch`. Spent → the card goes to Blocked. Was 5 until ADR-0076; an invalid value falls back to 10.                                                                                                                                                  |
| `FACTORY_PLAN_TIMEOUT_SEC`             | `360`       | Wall-clock cap per `--plan`/replan Claude call (was 180; xhigh planning thinks longer).                                                                                                                                                                                                                             |
| `FACTORY_IMPLEMENT_TIMEOUT_SEC`        | `2700`      | Wall-clock cap per `--implement` Claude call (was 1800; ultracode workflows run longer).                                                                                                                                                                                                                            |
| `FACTORY_WATCH_TIMEOUT_SEC`            | `1800`      | Wall-clock cap per `--watch` fix Claude call (was 900).                                                                                                                                                                                                                                                             |
| `FACTORY_REVIEW_TIMEOUT_SEC`           | `900`       | Wall-clock cap per code-review Claude call (read-only; runs once per PR head SHA).                                                                                                                                                                                                                                  |
| `FACTORY_BG_WAIT_CEILING_MS`           | `0`         | How long `claude -p` waits for background workflows/subagents after its last turn (0 = no ceiling).                                                                                                                                                                                                                 |
| `FACTORY_IMPLEMENT_RESUME`             | `1`         | Resume a timed-out (or `action=incomplete`) implement session on the next attempt, once ([ADR-0084](../adr/0084-factory-implement-deadline-and-resume.md)). `0` = always start fresh; the deadline facts stay.                                                                                                      |
| `FACTORY_IMPLEMENT_SOFT_MARGIN_MIN`    | `15`        | Minutes before the implement cap that the agent is told to wrap up (`softDeadlineAt`). Clamped to the cap minus 5.                                                                                                                                                                                                  |
| `FACTORY_IMPLEMENT_RESUME_MAX_AGE_MIN` | `360`       | A resumable session older than this runs fresh instead.                                                                                                                                                                                                                                                             |
| `FACTORY_IMPLEMENT_TERM_GRACE_SEC`     | `30`        | Seconds between SIGTERM and SIGKILL when an implement run hits its cap, so claude can write the interrupted tool call to its transcript (other calls: 5).                                                                                                                                                           |
| `FACTORY_IMPLEMENT_DETACHED`           | `0`         | `1` runs each `--implement` claude call detached, so the tick goes on to the other modes; a later tick collects it ([ADR-0085](../adr/0085-detached-implement-runs.md)). `0` runs it in the foreground. Collection runs either way.                                                                                 |
| `FACTORY_IMPLEMENT_MAX_RUNNING`        | `1`         | How many detached implement runs at once: `1` or `2` (each needs its own slot).                                                                                                                                                                                                                                     |
| `FACTORY_IMPLEMENT_KILL_GRACE_SEC`     | `300`       | How long past its cap a detached run may take to end before its supervisor kills it (`hardKillAt`).                                                                                                                                                                                                                 |

> **Background-task wait.** `claude -p` normally kills background tasks 600s after its final turn and exits 0. At ultracode that cut implement runs off mid-workflow with no summary line, burning an attempt each time (#623 was Blocked after four). The factory exports `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` from `FACTORY_BG_WAIT_CEILING_MS` (default `0`, wait indefinitely); the per-stage wall caps above still bound every call. A log line `Background tasks still running after …s; terminating` means the ceiling is set too low. A non-zero ceiling only applies on a `claude` CLI that has the ceiling feature (CodeRabbit on #637 put it at 2.1.182+; the Mac mini runs 2.1.270, whose termination log names the variable). An older CLI ignores the variable, waits without a ceiling and never prints that log line, so check `claude --version` before relying on a non-zero value.

### Resuming a timed-out implement

An `--implement` run gets a Claude session id and a **Run-time facts** block with its deadlines (`softDeadlineAt` = cap − `FACTORY_IMPLEMENT_SOFT_MARGIN_MIN`, `hardDeadlineAt` = cap). When a fresh run hits the cap, or stops itself with `action=incomplete` at the soft deadline, the factory records the session (`recorded resumable session <id>` in the implement log). The attempt is spent, and the slot and worktree stay. The next tick resumes that session with `claude --resume <id>` and `scripts/factory-implement-resume-prompt.md`, or logs `fresh session <id> (no resume: <reason>)`. It resumes only if:

- the worktree was reused as it was: not recreated, fast-forwarded or snapshotted;
- its HEAD hasn't moved, and its uncommitted files are exactly as the stopped run left them (a digest of `git status`, `git diff HEAD` and the untracked files);
- the approved plan and the feedback being answered are the same, text included: an edit to either starts fresh;
- your comments (not the factory's own) are exactly as they were in the stopped run's snapshot: none added, edited or deleted;
- the PR isn't closed or merged;
- the transcript exists;
- the record is younger than `FACTORY_IMPLEMENT_RESUME_MAX_AGE_MIN`.

A run the session limit stops is recorded too, resumed or not, and spends no attempt; the run after the reset resumes it. Every implement start clears the record, so a timeout chain resumes at most once. A resumed run's `action=implemented` is checked against the PR head before the chain's first run, so what the predecessor pushed before the cap counts; its noop and declined checks use the PR head at its own start. A resume that ends within 3 minutes without the model answering spends no attempt, and the next tick runs fresh.

To see a card's resume record and the session id of its latest run:

```bash
node scripts/lib/state-cli.mjs factory:get-issue <n> | jq '{implementSessionId, implementResumeSession, implementResumeHead, implementResumeTreeDigest, implementResumeKey, implementResumeAt}'
```

To stop the next run from resuming, so it runs fresh:

```bash
node scripts/lib/state-cli.mjs factory:implement-resume-clear <n>
```

To find a session's transcript:

```bash
ls ~/.claude/projects/*/<session-id>.jsonl
```

A stopped run's unpushed `chore(wip)` commits plus a push to the PR branch leave the worktree diverged (`worktree add failed … has diverged`). Each such tick spends an attempt, so the card ends in Blocked; merge or rebase `factory/issue-<n>` by hand, reset the attempts and drag it back.

To turn resuming off, set `FACTORY_IMPLEMENT_RESUME=0` in the plist. The deadline facts and the prompt's Time budget stay. See [ADR-0084](../adr/0084-factory-implement-deadline-and-resume.md).

#### Resume drill

To rehearse a resume by hand, on a scratch card:

1. Unload the job, so a 5-minute tick can't take the card or reset the checkout between your two runs:

   ```bash
   launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist
   ```

2. Put a scratch card in **In Progress** with an approved plan. `--implement` takes every In Progress card, not only this one, and would run each under the drill's short cap. So put the `factory-pause` label on every other In Progress card for the drill; `--implement` skips a paused card. Note which of them already had the label, so step 8 leaves those paused.

   The scratch card also needs a worktree slot. `node scripts/lib/state-cli.mjs factory:slot-status` shows who holds the two. Cards in In Review and Testing keep theirs, a paused card keeps its own, and a detached run keeps its card's even with the job unloaded. If both are held by other cards, the run only logs `Issue #<n>: both worktree slots busy; deferring to a later tick`. Don't release a slot another card is using. Stop the drill as step 8 does: park the scratch card, remove `factory-pause` only from the cards you added it to, then reload the job. Run the drill another time, when a slot is free.

3. Run the implement stage once with a short cap and let it stop. Hitting the cap and stopping itself with `action=incomplete` at the soft deadline are both recorded as resumable, so either counts. `FACTORY_AUTOPULL=0` is read only by the loop wrapper (`scripts/factory-agent-loop.sh`); it is kept so pasting the command into the wrapper doesn't reset the tree. Don't export `FACTORY_IMPLEMENT_DETACHED`, so both runs stay in the foreground.

   ```bash
   FACTORY_AUTOPULL=0 FACTORY_IMPLEMENT_TIMEOUT_SEC=<short> bash scripts/factory-agent.sh --implement --phase C
   ```

   If you scrub the environment with `env -i …` to mimic launchd, keep `USER`, `LOGNAME` and `TMPDIR`. Without them `claude` can't read its keychain login: it exits 1 within seconds with `Not logged in · Please run /login` in the implement log, and the run spends an attempt.

4. In the day's implement log, `logs/factory/factory-agent-implement-<YYYY-MM-DD>.log`, find `Issue #<n>: recorded resumable session <id>` from the first run (without it, the drill already failed). Note the transcript's size before the second run: `ls -l ~/.claude/projects/*/<id>.jsonl`.
5. Run the same command again. Change nothing in between: the resume conditions above all have to hold.
6. In the same log, check for `Issue #<n>: resume session <id>` from the second run, with the same `<id>`. A `fresh session <id> (no resume: <reason>)` line means the drill failed, and the reason says why.
7. Check that the second run appended to the same transcript: `ls -l ~/.claude/projects/*/<id>.jsonl` still shows one file, and it is larger than the size you noted in step 4.
8. Move the scratch card to **Blocked** or **Done** (or Backlog): no mode reads those columns. Closing the issue too is fine. Closing it alone isn't enough: `--implement` picks cards by column, not by issue state. Ready, Planning, Plan Review, In Progress, In Review, Testing, In Test or Approved gets the card worked again: Ready is re-planned, and Approved merges its PR. Remove `factory-pause` from the cards you added it to in step 2, and leave it on the ones that already had it. Only then reload the job, so its first tick can't take the scratch card:

   ```bash
   launchctl load ~/Library/LaunchAgents/eu.drafto.factory.plist
   ```

### Detached implement runs

With `FACTORY_IMPLEMENT_DETACHED=1` ([ADR-0085](../adr/0085-detached-implement-runs.md)), `--implement` prepares a card as before (slot, worktree, install, resume decision), then starts the claude call detached and goes on: `started detached implement run <runId> (pid <p>, slot <s>, cap 2700s until <iso>, …); a later tick collects it`. The other modes keep their 5-minute cadence while it runs. The next `--implement` ticks report it (`detached implement run <runId> is running`) and skip the card. Once it has ended, one collects it (`collecting detached implement run <runId> (exit <code>, …)`) and the usual implement lines follow. `--watch` and `--release` leave a card alone while a run holds it, until it is collected.

Each run has a directory, `logs/factory/implement/<issue>-<runId>/`: `meta.json`, `input.md` (the claude input), `stdout.txt`, `stderr.txt` (copied into the implement log at collection), `supervisor.log`, `exit.json`, `collected.json`, and `leftover.json` when the supervisor couldn't confirm that everything the run started is gone (below). They are reaped 30 days after the ledger lets go of them.

**Status.** What the ledger holds, and whether each run is alive:

```bash
node scripts/lib/implement-lane.mjs status | jq
node scripts/lib/state-cli.mjs factory:implement-status | jq
```

States: `starting` (not attached yet), `running`, `draining` (ended, but something it started still runs), `overdue` (past `hardKillAt`), `done`, `lost` (died with no `exit.json`, with a reboot since its last heartbeat), `unattached` (the tick died mid-start), `rollback` (a start that couldn't confirm its supervisor gone), `unreadable` (run files of another format), `unverified` (nothing proves everything the run started is gone: the supervisor couldn't read the process table, or died without `exit.json` and no reboot since). The next tick stops `draining`, `overdue` and live `rollback` runs, collects the ended ones, and drops dead `unattached`, `rollback` and `unreadable` runs unread; see the attempt rule below. An `unverified` run keeps its card held and its worktree locked until you clear it (below).

**Stopping a run.** This stops it and drops it from the ledger without collecting its result. Run it on the Mac mini from the factory checkout, while no tick is running:

```bash
cd /Volumes/DraftoFactory/drafto-factory
node scripts/lib/state-cli.mjs factory:pause        # ticks exit early from now on
pgrep -fl factory-agent.sh                          # wait until this prints nothing
node scripts/lib/implement-lane.mjs kill --issue <n> --finish 1 --outcome stopped --repo-root "$PWD"
node scripts/lib/state-cli.mjs factory:resume
```

- **`--repo-root` is required in practice.** Without it, `finish` skips `git worktree unlock` (`unlockWorktree` returns early with no repo root) but still drops the run from the ledger. The command then reports success and leaves the worktree locked. The factory passes its own checkout the same way.
- **Pause first.** `finish` loads the factory state, unlocks the worktree, then saves the state, and a tick that starts in between can load and save the same file, so one of the two saves overwrites the other. The global pause, and waiting for the running tick to end, keeps the two apart.

It sends SIGTERM to the run's process groups (the supervisor's, and claude's own below it), waits a minute, then SIGKILL. With `ok:false` and `state:"alive"` something survived even that; with `state:"unknown"` `ps` failed. **`leftover.json`.** When claude has ended, the supervisor stops any process group the run left behind (a test runner that left claude's group and ignored SIGTERM), retrying a few times. If `ps` keeps failing, or a group survives even SIGKILL, it writes those groups' identities (pgid and start time) to `leftover.json`. Until they are gone, `status` keeps the run alive (`draining`), `kill` goes on stopping them, and `finish` refuses, so the worktree stays locked and the card held. A `leftover.json` that can't be read reads as `unreadable`, and the run is never dropped on its own: look at the processes yourself (`ps -o pid,pgid,lstart,command -g <pgid>`), then clear the run (below) and run `kill --issue <n> --finish 1 --repo-root "$PWD"` again, as above.

**Clearing a run by hand.** For an `unverified` run, or an unreadable `leftover.json`, check the processes yourself first: `ps -axo pid,ppid,pgid,lstart,command | grep -E '<sessionId>|<runId>'`, and the groups in `leftover.json` if there is one. Then record that nothing is left:

```bash
node scripts/lib/implement-lane.mjs clear --issue <n> --confirm 1 --note "checked ps"
```

It writes `cleared.json` in the run dir. It refuses while anything the factory can see of the run is still alive. The next `--implement` tick then collects or drops the run as usual.

**`unlockPending`.** `finish` drops a run only once git lists its worktree unlocked. If the unlock doesn't take, or the worktree list can't be read, the run stays in the ledger marked `unlockPending` (`status` shows it), the card stays held, and the next tick tries again. If it persists, look at `git worktree list --porcelain` in the factory checkout.

**A locked worktree no run owns.** A start, and `worktree-cli add`, refuse a worktree that is already `git worktree lock`ed: `worktree is locked (implement run <runId>)`, or `the detached implement run failed to start (worktree-locked)`. Check `implement-lane.mjs status` first; if no run holds the card and nothing runs in the worktree, `git worktree unlock <path>`.

Don't `kill -9` the supervisor by hand: claude leads a process group of its own and would be left running. Dragging the card out of In Progress, In Review and Testing, to any other column (or closing it), does the same stop on the next `--watch` sweep, which then frees the slot. Moving it between those three columns doesn't stop the run.

**Resuming by hand.** The run's session id is in `status` (`sessionId`) and in `implementSessionId` on the card's record. First add the `factory-pause` label to the card, whichever of In Progress, In Review or Testing it is in: the factory works every card in those columns, and without the label it can start its own implement run or a `--watch` fix pass in the same worktree while you work there. An interactive `claude --resume` is never counted as the run, so nothing else makes the factory wait. Then continue the session only once `status` no longer lists the card (the run was collected, or stopped with `--finish 1`). Remove `factory-pause` when you are done:

```bash
gh issue edit <n> --repo JakubAnderwald/drafto --add-label factory-pause
node scripts/lib/implement-lane.mjs status --issue <n> | jq '.runs'   # must print []
cd <worktree>
claude --resume <sessionId>
# done: let the factory have the card again
gh issue edit <n> --repo JakubAnderwald/drafto --remove-label factory-pause
```

**Collection re-reads the card.** An ended run is handed to the usual result handling only while its card is open, in In Progress, In Review or Testing, without `factory-pause`. With `factory-pause` set the result waits, and the run keeps its place in the ledger (and its share of `FACTORY_IMPLEMENT_MAX_RUNNING`) until the label goes or you stop it. A card that moved anywhere else has its run dropped unread. **Attempts**, the one rule: a run dropped `unreadable` (corrupt run files, or another `formatVersion`) spends the card's attempt, and so does a start that failed with an error, so a fault that repeats still sends the card to Blocked. A run dropped `unattached` (the tick died mid-start), a refused start (no room, a race) and a run stopped by you or by a drag spend none. An interrupted run (a reboot, a SIGKILL before its deadline) spends none unless it was already a resume. The feedback mark a collected run sets is the run's end, not the collecting tick's time.

**A pause doesn't stop a run.** `factory:pause`, the session-limit pause and the toolchain pause end every tick at its start, so nothing is collected meanwhile, but a run in flight keeps going to its end or its cap. Stop it as above if needed.

**Switching it off, and reverting.** Set `FACTORY_IMPLEMENT_DETACHED=0` in the plist and reload: new runs go back to the foreground, and runs already started are still collected, whatever the knob. Before reverting the code, drain: wait until `implement-lane.mjs status` shows no runs (or stop them as above). Code without this module would leave a live run's ledger entry and slot in place, with nothing to collect them.

**Rollout.** Merge with the knob at `0` and run a day: the logs should read as before. Then set `FACTORY_IMPLEMENT_DETACHED=1` in the plist and reload. Check that ticks keep their 5-minute cadence while a run is in flight (`--release` and `--watch` lines for other cards keep appearing), and that collection moves cards on to In Review. Rollback is the knob back to `0`.

> **Rollout precondition.** The loop self-updates the repo each tick but **not** the `claude` CLI. The Mac mini's `claude` must accept `--effort` — verify with `claude --effort ultracode -p 'reply with OK'` (must exit 0 and print `OK`). An older CLI would fail every Claude call and Block cards within `FACTORY_MAX_ATTEMPTS` ticks. Rollback needs no code redeploy: set `FACTORY_EFFORT` / `FACTORY_REVISION_EFFORT` / `FACTORY_WATCH_EFFORT` / `FACTORY_PLAN_EFFORT` to a base level (or lower the timeouts) in the plist. Since [ADR-0101](../adr/0101-factory-pins-model-and-revision-effort.md) every call also passes `--model "$FACTORY_MODEL"` (`opus[1m]` by default), so the CLI must accept that model both with and without setting sources: `claude --model 'opus[1m]' --effort ultracode --no-chrome --strict-mcp-config -p 'reply OK'` and `claude --setting-sources "" --model 'opus[1m]' --effort xhigh -p 'reply OK'` must both exit 0. Quote the name: unquoted, `opus[1m]` is a shell glob.

> **Trying another model ([ADR-0080](../adr/0080-factory-model-knobs-browser-runner-scenario-writer.md), [ADR-0101](../adr/0101-factory-pins-model-and-revision-effort.md)).** `FACTORY_MODEL` (`opus[1m]`) sets every stage; the two stage knobs ship empty, which means `FACTORY_MODEL`. A knob takes an alias (`opus`, `sonnet`, `haiku`, `fable`) or a full `claude-…` name, optionally with `[1m]`. The pattern accepts any well-formed `claude-…` name, so a typo passes validation and then fails every call of that stage at the CLI: the scenario writer posts its fallback comment, and the browser runner records `error` and spends the attempt. Before setting a knob, check the model on the Mac mini at the stages' effort: `claude --model claude-sonnet-5-5 --effort xhigh -p 'reply with OK'` must exit 0 and print `OK`. Then set the knob in the plist's `EnvironmentVariables`, `launchctl unload` and `load` the plist, and read the next runs' `Invoking …` log lines, which name the model. A stage that shows `FACTORY_MODEL`'s value has an empty or rejected knob; a rejected value's warning is in the launchd log (`logs/launchd-factory-*.log` in the primary checkout), not the factory log. To revert, empty the knob and reload.

## Worktree installs & disk

The factory implements each card in a throwaway git worktree that needs its own `node_modules`. The pnpm store and every factory checkout now share one volume, `/Volumes/DraftoFactory` ([ADR-0060](../adr/0060-dedicated-factory-build-volume.md)), so installs clone from the store. Before that, the store was on the external drive and the checkouts were on the internal disk. A cold `pnpm install` then couldn't clone or hardlink and cross-device-copied ~2000 packages. On #451 this ran **3.5+ hours** and silently held the implement lock, starving every other card. Two mitigations are built in:

- **Clonefile seed.** Before installing, `seed_worktree_node_modules` clones the main checkout's `node_modules` (repo root + `apps/*` + `packages/*`) into the worktree with APFS `cp -c` (O(1), copy-on-write, ~0 bytes). The subsequent install is a fast **offline reconcile** (`pnpm install --frozen-lockfile --offline`), falling back to frozen-online then unfrozen-online for genuine lockfile drift. A cold install now takes seconds.
- **Bounded install + disk guard.** Every install is wrapped by `run-with-timeout.mjs` and capped at `FACTORY_INSTALL_TIMEOUT_SEC`. Before starting, the factory checks free space on both the build volume and the internal disk behind `$HOME` (TMPDIR, Claude transcripts, simulators). It parks the card in **Blocked** with a `disk-low` comment if the fuller of the two is below `FACTORY_MIN_FREE_DISK_GB`. In Test betas and the verify lane use the same check.

> **Do not delete the beta build roots** (`drafto-beta-mobile`, `drafto-beta-desktop`) when reclaiming space. They live outside `<repoRoot>/worktrees/` and carry no `factory/issue-*` branch, so `worktree-cli.mjs list` never reports them — but a broad `rm -rf` throws away their warm `node_modules`, Pods and native build caches, so the next lane pays for a full install and cold build. They are not small. On the internal disk, the mobile root held 6.8 GB that no other checkout shared: every install drifts its `node_modules` away from the seed, and `android/app/build` alone was 1.9 GB. Prune the **build artefacts** instead:
>
> ```bash
> rm -rf /Volumes/DraftoFactory/drafto-beta-desktop/apps/desktop/macos/build
> rm -rf /Volumes/DraftoFactory/drafto-beta-mobile/apps/mobile/ios/build
> rm -rf /Volumes/DraftoFactory/drafto-beta-mobile/apps/mobile/android/.gradle
> ```
>
> You don't need to delete the desktop root's `Pods` after a native dependency change either. `ensure_beta_build_root` deletes it, with `macos/build`, once it no longer matches the checked-out `Podfile.lock` (see [Pre-merge beta dispatch](#pre-merge-beta-dispatch-in-test)).

**Env knobs** (set in the launchd plist's `EnvironmentVariables`, alongside `FACTORY_PHASE`):

| Var                           | Default | Purpose                                                           |
| ----------------------------- | ------- | ----------------------------------------------------------------- |
| `FACTORY_INSTALL_TIMEOUT_SEC` | `600`   | Wall-clock cap per worktree `pnpm install`.                       |
| `FACTORY_GH_TIMEOUT_SEC`      | `120`   | Wall-clock cap per factory `gh` call (1–99999).                   |
| `FACTORY_MIN_FREE_DISK_GB`    | `3`     | Free-disk floor below which a card is Blocked instead of started. |

**Reclaiming disk:**

Run `git worktree prune` only while `/Volumes/DraftoFactory` is mounted. Without the volume it treats every worktree on it as deleted and drops the registrations of the factory checkout, both build roots and every card worktree.

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

The pnpm store sits on the same volume as the factory's checkouts, so installs clone from it even without the seed. The seed remains a cheap safety net. Interactive worktrees in `~/code` still install across volumes.

## Related

- [`docs/features/dark-factory.md`](../features/dark-factory.md) — operator manual.
- [ADR-0026](../adr/0026-dark-factory-pipeline.md) — decision record.
- [ADR-0035](../adr/0035-factory-code-review-gate.md) / [ADR-0036](../adr/0036-factory-coderabbit-cli-gap-fill.md) — review-thread merge gate and the CodeRabbit CLI gap-fill lane.
- [ADR-0051](../adr/0051-factory-browser-runner.md) / [ADR-0096](../adr/0096-factory-test-run-screenshots-on-github.md) — the browser runner, and its screenshots on GitHub.
- [`docs/operations/migrations.md`](./migrations.md) — migration safety + rollback workflow.
- [`docs/operations/builds-and-releases.md`](./builds-and-releases.md) — release commands, beta lanes.
