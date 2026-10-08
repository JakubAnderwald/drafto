# 0042 — Nightly Support Runner Owns Beta Dispatch

- **Status**: Accepted
- **Date**: 2026-10-08
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

Stage 2 of the support pipeline, `scripts/nightly-support.sh` (launchd, 00:03, primary checkout), fixes allowlisted support issues by running one `claude -p --dangerously-skip-permissions` session per issue. Until now that session's prompt also told it to merge the PR, poll main CI, run the Fastlane beta lanes for Android, iOS and macOS, and comment the results. Phase 4 of the script was a no-op ("builds run locally in Phase 3").

On issue #658 (PR #661, merged 2026-10-05 22:25 UTC) the session started every lane as a **background** Bash task, said "The builds are running in the background. I'll report when they finish." and ended its turn. `claude -p` then exited and killed the lanes about 4 s into `bundleRelease` / CocoaPods. The fix never shipped, no "Now live" notice was posted, and the reporter was never told. Three more problems made it worse:

- The script exits early ("No items to process") when no Dependabot PR or support issue is open, so nothing ever retried the release.
- The session invented its own worktree path (`/Users/jakub/code/drafto-fix-658`) and never removed it.
- The session ran in the primary checkout, which holds the macOS desktop **fossil** `node_modules` ([ADR-0027](./0027-desktop-react-version-locked-to-react-native-macos.md)). Nothing stopped it from running `pnpm install` or `git checkout` there.

A language model is a poor place to put a 20–40 minute build. It cannot reliably wait for one, its turn can end at any time, and its "the build is running" is not evidence that a build shipped.

## Decision

The **bash runner**, not the LLM session, ships the beta builds for merged support fixes.

1. **The session stops at the merge.** The Phase 3 prompt now ends at the squash-merge. It forbids every Fastlane lane, `pnpm release:*` script, and background task that must outlive the session. It puts the work in a fixed worktree, `$HOME/code/drafto-support-<n>` on `fix/support-<n>`, which the runner removes once the issue is closed. It also forbids `pnpm install`, `git checkout`, `pull`, `reset` and edits in the primary checkout. Every `claude -p` call (support and Dependabot) now runs through `scripts/lib/run-claude.mjs` with a wall-clock cap, and `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` is exported so a session waits for its own background work instead of having it killed after 600 s.
2. **Phase 4 ships.** `scripts/lib/support-release.mjs pending` lists the `support` issues closed as _completed_ in the last 14 days whose merged closing PR touched `apps/mobile`, `apps/desktop` or `packages/shared` (mapped by `derivePlatforms`). It leaves out the platforms already announced since the issue's latest close and those that have failed three times for that close. A reopened issue that is fixed again gets a fresh budget. A GitHub error on one issue skips only that issue for the night. A fix that leaves the window unshipped gets `needs-manual-intervention` and one operator comment (`pending --flag-expired`), so a fix that only ever hit "not tonight" outcomes can't drop out silently. If anything is pending, the runner:
   - waits up to 45 min for main's required checks on `origin/main`'s head (`support-release.mjs main-ci`, exit 0 green / 1 failed / 2 timed out / 3 could not check). Anything but green means retry next night, and no attempt is spent;
   - prepares the **factory's** shared build roots with `ensure_beta_build_root`, now in `scripts/lib/beta-build-root.sh`, which both schedulers source. A root another process holds is skipped until the next night;
   - dispatches each lane separately through `dispatch-release.mjs dispatch --release-issues <csv>`. Mobile runs `release:beta:all` (Play internal and TestFlight) from the mobile root. macOS runs `release:beta` from the fossil replica, behind `assertDesktopFossil`. Each lane announces only its own lane's issues;
   - **waits** for each lane's `<log>.exit`, polling every 60 s. A lane is killed (its whole process group) when its log is silent for 120 min or it has run for 180 min;
   - settles each issue and platform (`support-release.mjs settle`). The attempt counts as **ok** when the Fastlane hook posted `<!-- now-live:<platform>:… -->` on the issue, and as **failed** otherwise, even when the lane exited 0. After 3 failures the issue gets `needs-manual-intervention` and an operator comment, without the progress marker, naming the lane log.
3. **The root lock is taken early.** `ensure_beta_build_root` now writes `<root>.lock` with the caller's pid, atomically (temp file + `ln`), before it touches the root. A stale lock is reaped with a guarded compare-and-delete, so two callers that both saw the same dead pid can't both win. Every failure path drops the lock. `claim_beta_build_root` hands it to the lane's pid as before, and the new `release_beta_build_root` drops a lock its caller no longer needs. Without this, the factory's `--watch` and the nightly could both pass the stale-lock check during the minutes a root takes to prepare, and reset it under each other.
4. **The announcement is the existing Fastlane hook.** `comment-released-issues.mjs` now unions `$DRAFTO_RELEASE_ISSUES` (from `--release-issues`) with its tag-range `Closes #N` walk. That walk can miss a fix: `mobile@` is shared by the `+ios.` and `+android.` tags, and `-v:refname` sorts the iOS tag first. The hook now announces each platform once per fix: a notice for **any** build of that platform, posted since the issue's latest close, suppresses a new one. The support agent forwards that notice to the reporter as before.
5. **Retry state** lives in `logs/support-release-state.json` (`issues[n].releaseAttempts[platform] = {failures, lastAttemptAt, lastResult}`), written by the nightly and by `state-cli.mjs record-release-attempt` / `reset-release-attempts`. It is deliberately **not** `support-state.json`. `support-agent.sh` rewrites that file every minute through non-transactional load-mutate-save calls, so a second writer could drop one of its cursor updates and re-send a customer email.
6. **The early exit also checks for pending releases.** The script exits early only when there is no Dependabot PR, no support issue **and** no pending release, so a failed build is retried on the next night.

Beta channels only. `dispatch-release.mjs` never builds anything but `release:beta:all` / `release:beta`, and its `assertBetaOnly` denylist refuses production and App Review lanes. CLAUDE.md pre-authorizes beta builds. The factory's `--release` keeps skipping `support`-labelled issues, so the nightly is their only shipper.

## Consequences

- **Positive**: A merged support fix reaches TestFlight and Play internal without a human, and the reporter is told when it does. A failed build is retried on later nights, up to a bounded budget, and then lands loudly in front of the operator. A session can no longer kill the build it started. The two schedulers can no longer reset a shared build root under each other.
- **Positive**: `beta-build-root.sh` is the one place that knows how a build root is prepared, locked and released. The factory and the nightly can no longer drift apart on it.
- **Negative**: The nightly run gets longer: up to 45 min waiting for CI plus up to 3 h of lanes after Phase 3. It runs overnight, so this is acceptable.
- **Negative**: The mobile lane always builds both Android and iOS (`release:beta:all`), even when only one of them still needs the fix. The extra beta build is harmless, and the hook does not re-announce.
- **Negative**: Once any Android build has announced a fix, a later Android **production** release no longer posts its own "Now live in Google Play" for it. That matches the Apple promote lanes, which never announce.
- **Negative**: The shared lock serialises lanes that build in the same root, not store uploads in general. The factory's Phase-D post-merge mobile lane builds from the factory checkout, so it could race the nightly for the same Android version code or iOS build number. Phase D is dormant (the factory runs at Phase C). Before enabling it, move that lane into the shared mobile build root.
- **Neutral**: Phase 4 is skipped while the external build volume is not mounted, unless the roots are set explicitly. The factory skips its whole tick in that case too. The default roots are re-derived right before Phase 4 prepares them, so they always match the factory's.
- **Neutral**: The nightly runs from the primary checkout, so it only picks up this change after a `git pull` there. Never `pnpm install` there.

## Alternatives Considered

- **Keep the LLM running the builds, with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`.** This would have saved #658's lanes. It still leaves a 40-minute build, its retries, and the question of whether it shipped to a model that can end its turn, misreport an outcome or skip a platform. Rejected. The wait ceiling is still exported, as defence in depth for the session's own work.
- **Separate support build roots.** This would avoid sharing the factory's roots, but it doubles the disk use on the build volume, needs a second fossil replica (which must be validated with a TestFlight build, [ADR-0030](./0030-in-test-scenarios-and-pre-merge-betas.md)), and still has to coordinate signing and version numbers with the factory's lanes. Rejected in favour of sharing the roots behind a stronger lock.
- **Let the factory ship support fixes (Phase D post-merge dispatch).** The factory is at Phase C, so post-merge dispatch is not active. `--release` deliberately skips `support` issues, and the nightly merges these PRs itself, outside the board. Turning on Phase D for this alone would widen its blast radius to every factory merge. Rejected for now. It is the natural home if the two pipelines merge.
