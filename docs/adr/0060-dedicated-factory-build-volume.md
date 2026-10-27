# 0060 — A Dedicated ASCII Build Volume for the Factory

- **Status**: Accepted
- **Date**: 2026-10-27
- **Authors**: Jakub Anderwald, Claude

## Context

The Mac mini's internal disk (228 GB) was 90% full, with 21 GB free. The factory's `FACTORY_MIN_FREE_DISK_GB=15` guard blocks cards and skips In Test betas below 15 GB. The external Crucial X9 Pro holds one encrypted APFS volume, `Zewnętrzny`, which carries the operator's own data plus the pnpm store, the desktop beta root, Gradle home, Xcode DerivedData and the Android SDK. Its container had 604 GB unallocated.

The automation's checkouts were split across the two disks. Sizes are APFS private bytes, i.e. not shared with a clone (`du` over-counts clones):

| On the internal disk                                                 | Private size |
| -------------------------------------------------------------------- | ------------ |
| Factory checkout `~/code/drafto-factory` (node_modules, logs)        | ~1.5 GB      |
| Its card worktrees `worktrees/factory-issue-*`                       | 2.2 GB each  |
| Mobile beta root `~/code/drafto-beta-mobile`                         | 6.8 GB       |
| Nightly Dependabot worktrees `~/code/drafto-dependabot-<n>` (a leak) | 3.5 GB each  |

Each piece had a reason to stay internal:

- **The mobile root** can't live on `Zewnętrzny`. React Native 0.83's CocoaPods scripts build file URLs with `URI::File.build`, which rejects the "ę" ([ADR-0042](./0042-nightly-support-runner-owns-beta-dispatch.md), 2026-10-10 update). ADR-0042 rejected renaming `Zewnętrzny`, because IDrive, a Google Drive mirror, symlinks and other tools key on its path.
- **The factory checkout and its worktrees** sat on a different volume from the pnpm store. The card worktrees are seeded from the checkout by APFS clone and then reconciled against the store. Every package that had drifted from the seed was copied across volumes onto the internal disk, which is why one worktree held 2.2 GB of its own. A cold install crossing volumes is what took 3.5 hours on #451.
- **The nightly's session worktrees** were never seeded. Each one copied about 2.8 GB from the store. They were also removed only for an item processed that same night, but a finished item usually drops out of the queue first: closed PRs aren't listed, and PRs labeled `needs-review` or carrying the nightly's marker are skipped. `drafto-dependabot-746` outlived its closed PR.

## Decision

Add a second APFS volume, **`DraftoFactory`**, to the X9 Pro's existing container: encrypted, case-insensitive, auto-unlocked from the login keychain. It shares the container's free space, so it needs no fixed size and no repartitioning. Its name is ASCII on purpose. **Every path the automation owns moves onto it:**

```
/Volumes/DraftoFactory/
  pnpm-store/              store-dir in ~/.npmrc (was /Volumes/Zewnętrzny/pnpm-store)
  drafto-factory/          the factory checkout; worktrees/ and logs/ inside it
  drafto-beta-mobile/      mobile beta root (+ .lock)
  drafto-beta-desktop/     desktop beta root, a replica of the fossil (+ .lock)
  worktrees/               nightly drafto-dependabot-<n> / drafto-support-<n>
```

Code changes:

- **`scripts/lib/beta-build-root.sh`.** `BETA_BUILDS_VOLUME_DIR` defaults to `/Volumes/DraftoFactory`, and while it is mounted (present and writable: a stale, root-owned mount point doesn't count) both roots default to it. The mobile root follows the volume again, and the non-ASCII refusal stays as a backstop.
- **Free-disk guard.** `free_disk_gb` in `factory-agent.sh` and the verify lane's start gate now report the fuller of `$REPO_ROOT`'s volume and `$HOME`'s. With the checkout off the internal disk, measuring `$REPO_ROOT` alone would stop protecting the internal disk, where TMPDIR, Claude transcripts and simulators still live.
- **`scripts/nightly-support.sh`.**
  - Session worktrees go to `<volume>/worktrees` while the volume is mounted, else `~/code` (`SUPPORT_WORKTREE_PARENT` overrides both).
  - `session_worktree_path` reuses a registered worktree for the same item from either parent. If that worktree's directory is gone (its volume isn't mounted), the item is skipped until a later night, because git still has its branch checked out there.
  - `sweep_session_worktrees` runs before the no-items exit and Phase 2. It removes every `drafto-dependabot-<n>` whose PR is merged or closed and every `drafto-support-<n>` whose issue is closed, whether or not the item is in tonight's queue. Every removal, the sweep's and the existing post-session ones, now keeps and logs a worktree with uncommitted changes (new files included) or with commits on no remote-tracking ref: an issue closed by hand, or a PR merged mid-session, may still hold an unfinished fix. The one exception is `next dev`'s generated `apps/web/AGENTS.md` and `apps/web/CLAUDE.md`, which every session that runs the web E2E suite leaves behind. Nothing prunes remote-tracking refs, so a fix `/push` pushed before its squash-merge still counts as pushed.

The launchd plist runs the factory from `/Volumes/DraftoFactory/drafto-factory` and pins both roots there. It skips the tick unless both `/Volumes/DraftoFactory/drafto-factory` and `/Volumes/Zewnętrzny/Developer` exist: Gradle, DerivedData and the Android SDK stay on `Zewnętrzny`, shared with interactive work. The launchd stdout/stderr logs stay on the internal disk, so the "not mounted" line can always be written.

## Consequences

- **Positive**:
  - About 16 GB comes back on the internal disk immediately, about 20 GB once the remaining leaked Dependabot worktree's PR closes.
  - No future factory or nightly checkout lands there.
  - Every factory path is ASCII. The mobile root is no longer the one exception, and the dormant Phase-D mobile lane (which builds in `$REPO_ROOT`) stays buildable.
  - The store, the factory checkout and every worktree share one volume. Seeds and installs are APFS clones: fast, and almost no extra space.
  - Because the factory checkout lives on the same volume as everything it registers, a `git worktree prune` run from the factory can't see a build root as missing while it runs.
- **Negative**:
  - The automation now depends on two external volumes being mounted. If `DraftoFactory` stays locked after a reboot, the factory skips every tick and the nightly's Phase 4 retries the next night.
  - `git worktree prune` from the primary checkout while the volume is unmounted would drop the registrations of everything on it. The runbook says so, and the nightly sweep never prunes.
  - Other pnpm projects on the Mac mini still record the old store in `node_modules/.modules.yaml`. Each needs one reinstall (`ERR_PNPM_UNEXPECTED_STORE`). The primary checkout is the fossil and is never reinstalled.
  - The desktop root had to be re-created from the fossil, a full copy across volumes. A re-created replica must be proven by a TestFlight build that opens a note, so the old root is kept until one does.
  - Ruby's `getcwd()` once hung for 5 hours on the external volume (2026-10-09, cause unknown). `bundle check` has been capped since, and the mobile root is now external again.
- **Neutral**:
  - Interactive worktrees in `~/code` still install across volumes, as before.
  - The free-disk guard's threshold now applies to both volumes. The external one has hundreds of GB, so in practice it guards the internal disk.

## Update 2026-10-27: the toolchain moved too

The same day, the build toolchain followed the checkouts onto `DraftoFactory`: Gradle home, Xcode `DerivedData` / `Archives` / `iOS DeviceSupport`, the CocoaPods cache, the Android SDK and the AVDs (about 43 GB, all of it already off the internal disk). They are reached through the same home-directory symlinks as before, now pointing into `/Volumes/DraftoFactory/{Developer,Android,android-avd}`, so every other project on the Mac mini, kindle-decryptor's emulator included, finds them unchanged. The factory now depends on one volume: the plist's gate checks only `/Volumes/DraftoFactory/drafto-factory`, and `Zewnętrzny` holds nothing the automation uses. A side effect is that IDrive, which keys its backup set by path, no longer backs up these caches, nor the Xcode archives. Every archive's build is also in App Store Connect.

A correction to the layout above: the store location is set in pnpm's global config (`~/Library/Preferences/pnpm/rc`, via `pnpm config set store-dir … --location=global`), not in `~/.npmrc`.

## Alternatives Considered

- **Rename `Zewnętrzny` to an ASCII name.** Rejected in ADR-0042: IDrive would re-upload about 310 GB, and too many tools store the path.
- **Factory checkouts on `Zewnętrzny`, plus a small ASCII volume for the mobile root only.** This was the first plan. Rejected:
  - It needs two build volumes.
  - A non-ASCII `$REPO_ROOT` breaks the Phase-D mobile lane and needs its own guard.
  - Claude's transcript folder name for a path with "ę" depends on Unicode normalisation, which the session-limit lookup would have to match.
  - The mobile root would still install across volumes.
- **Symlink `~/code/drafto-factory` or its `worktrees/` onto the external drive.** Rejected. CocoaPods and Ruby resolve the real path, so the iOS limit stays. The session-limit lookup also derives its transcript folder from the logical working-directory path, so it would quietly stop matching.
- **Only fix the Dependabot leak.** That reclaims 7 GB once, but leaves the factory's and the mobile root's 12 GB on the internal disk and the cross-volume installs in place.
