# 0067 — Desktop moves to react-native-macos 0.83

- **Status**: Accepted
- **Date**: 2026-11-02
- **Authors**: Jakub Anderwald, Claude

Supersedes [ADR-0027](./0027-desktop-react-version-locked-to-react-native-macos.md) and [ADR-0063](./0063-desktop-native-runtime-patches.md).

## Context

The macOS app only built from a "fossil": the primary checkout's `node_modules`, installed before the monorepo moved to React 19.2 and never reinstalled. [#558](https://github.com/JakubAnderwald/drafto/issues/558) is what happens on any other checkout:

- The build expected a hand-placed `react-native` 0.81.6 fork under `apps/desktop/node_modules/react-native`. A fresh `pnpm install` doesn't create it.
- The Podfile called `react_native_post_install(installer)` with no path, so `REACT_NATIVE_PATH` defaulted to `${PODS_ROOT}/../../node_modules/react-native`, that missing directory.
- `build_mac_app` failed in seconds at the Hermes "Replace Hermes for the right configuration" phase: `with-environment.sh: No such file or directory`.
- A fresh checkout also had no `macos/.xcode.env.local`, so nothing set `NODE_BINARY`.

Worktrees, CI and the factory's beta dispatch could not build desktop. Copying the fork by hand got builds out, but that is what made them non-reproducible.

[ADR-0027](./0027-desktop-react-version-locked-to-react-native-macos.md) found why the fork couldn't be pinned in config. React must be one shared instance across the monorepo. react-native-macos (rnm) 0.81 needs React 19.1, and mobile needs 19.2. Every attempt to split React per app gave a crashing or blank app. ADR-0027 deferred the fix to rnm 0.83.

rnm 0.83.0 has shipped. It peers `react` `^19.2.0` and `react-native` `0.83.10` exactly. That is the same React and the same `react-native` mobile uses.

[ADR-0063](./0063-desktop-native-runtime-patches.md) existed only because the fossil could not take a `pnpm patch`. It fixed the nil-`reactTag` keyboard crash with a runtime swizzle, `DraftoKeyboardEventGuard.mm`. A clean install can apply patches, so that reason is gone.

## Decision

**1. Bump desktop to rnm 0.83.0.**

- `react-native-macos` is pinned exactly to `0.83.0`, so every native change is a visible diff.
- `react-native` and `@react-native/{babel-preset,metro-config,typescript-config}` move to `0.83.10`, mobile's version. There is one hoisted copy and no nested one.
- React stays the single hoisted 19.2.8 set by the root `pnpm.overrides`.
- `react-native-url-polyfill` is removed. Nothing imported it. `src/lib/url-polyfill.ts` stays.
- `react-native-screens` is pinned to `~4.24.0`, the version the fossil shipped. 4.26.0's Android-only `StackHeaderConfigAndroidNativeComponent` spec fails RN 0.83.10's codegen during `pod install` (`setToolbarMenuElementOptions must be of type React.ElementRef<>`). Dependabot already ignores screens minors.

**2. Point the build at rnm, not a per-app `react-native`.** The Podfile calls `react_native_post_install(installer, '../../../node_modules/react-native-macos')`. `REACT_NATIVE_PATH` in the Pods project and `Drafto.xcodeproj` becomes `${PODS_ROOT}/../../../../node_modules/react-native-macos`. rnm ships `with-environment.sh` and the Hermes scripts itself.

**3. Guard the install: what is installed must match what is declared.**

- The Fastfile `build_and_submit` lane runs a dependency preflight before `cocoapods`. It aborts with "run `pnpm install`" unless the installed `node_modules/react-native-macos` equals the version in `apps/desktop/package.json` and `node_modules/react` is 19.2.x.
- `assertDesktopDeps(root)` in `scripts/lib/dispatch-release.mjs` checks the same thing before the factory spawns a desktop lane. It replaces `assertDesktopFossil()` and keeps its refusal plumbing, so a refusal is still reported on the issue.
- A stale checkout (the old fossil, or a `git pull` with no install) now fails loudly instead of shipping a mixed graph.

**4. Derive `NODE_BINARY`.** Before `cocoapods`, the lane rewrites `macos/.xcode.env.local` from `node -p process.execPath` when the file is missing or its `NODE_BINARY` isn't executable.

**5. Desktop installs like mobile.** Any checkout builds desktop after a plain install: `pnpm install` → `bash scripts/worktree-bootstrap.sh` → `cd apps/desktop && bundle install` → `pnpm release:beta`. The factory's desktop build root seeds from its checkout and runs `pnpm install`, the same as the mobile root. The fossil is retired; see [`desktop-build-fossil.md`](../operations/desktop-build-fossil.md).

**6. Rules from here on.**

- **Native fixes to rnm go in `patches/`,** registered in the root `pnpm.patchedDependencies` under a range key that covers the exact pin. The first is `patches/react-native-macos@0.83.0.patch` under `react-native-macos@~0.83.0`. It touches only `React/Views/RCTView.m`: `-handleKeyboardEvent:` returns `NO` when `self.reactTag` is nil. It replaces `DraftoKeyboardEventGuard.mm`, which is deleted with its 4 `project.pbxproj` entries.
- **rnm releases arrive in their own Dependabot group, with `react-native` and desktop's `@react-native/*` tooling.** rnm peers one exact `react-native`, and desktop pins `react-native` and its tooling (`babel-preset`, `metro-config`, `typescript-config`) to that peer. `scripts/__tests__/desktop-native-build-config.test.mjs` fails when they disagree. They share a `react-native` group listed before `minor-and-patch`, which also excludes them, and rnm has no ignore entry. A `react-native` patch that rnm doesn't peer yet keeps the group's PR red until an rnm release does, so mobile's `react-native` patches wait for rnm too. Mobile's `@react-native/jest-preset` isn't tied to that peer and stays in `minor-and-patch`. A patch release reapplies the patch, or fails `pnpm install` if the hunk no longer applies. A minor release leaves the patch key matching nothing: `pnpm install` rejects the unused patch when it re-resolves, and `scripts/__tests__/desktop-native-build-config.test.mjs` fails in CI either way, because the key no longer covers the pin. That is the prompt to re-make it. A minor also peers a new `react-native` minor, and Dependabot ignores `react-native` and `@react-native/*` minors, so its PR carries rnm alone. `react-native` (both apps) and desktop's tooling are raised to the peer by hand in that PR, and mobile's `react-native` minor waits for an Expo SDK that supports it. CI doesn't build macOS, so each group PR that moves rnm or `react-native` is merged only after a TestFlight build that opens a note. This is the release tracking ADR-0027's decision 5 asked for.
- **The CLI core and `cli-platform-ios` share one version.** `@react-native-community/cli` and `@react-native-community/cli-platform-ios` are exact-pinned together (18.0.0) and move in one commit. `use_native_modules!` runs the core CLI's `config`, which builds the macOS config through `cli-platform-ios`. Dependabot ignores their semver-major updates, so a major moves deliberately, with rnm.
- **macOS has no `tentap` pod.** tentap 1.1.0's `TenTapKeyboard` TurboModule lives in an iOS-only pod. rnm's autolinking skips a pod whose podspec doesn't support macOS, so `TurboModuleRegistry.get('TenTapKeyboard')` returns `null` and tentap uses its JS keyboard driver. A `tentap` pod in desktop's `Podfile.lock` means the platform filter changed.

**7. Rollback snapshot.** The primary checkout's first post-merge `pnpm install` destroys the fossil. Before it, take a clonefile snapshot (`cp -c -R`) of the fossil's `node_modules` trees. Keep it until a post-merge TestFlight build opens a note. Rollback is: revert the PR, then restore the snapshot. The fossil's `node_modules` record an older pnpm store, so a non-interactive install there needs `--config.confirm-modules-purge=false`; the factory's `run_pnpm_install` passes it. `drafto-beta-desktop` is not a backup, because the factory reinstalls it on its first post-merge build. Keep `FACTORY_INTEST_BETA_DESKTOP` off until that build opens a note.

## Consequences

- **Positive**: desktop builds from any checkout after `pnpm install`, like mobile. Worktrees, the factory and a fresh clone need no hand-copied `node_modules`.
- **Positive**: desktop rejoins the shared React 19.2 and `react-native` 0.83.10. There is one dependency graph to reason about.
- **Positive**: native fixes are reviewable patch files, scoped to a version range. `pnpm install` fails loudly once one stops applying. The runtime swizzle and its private-selector binding are gone.
- **Positive**: rnm releases show up in their own group PR, with any `react-native` and tooling patch they peer, and none of them can break the weekly group. An rnm minor still needs `react-native` and the tooling raised by hand.
- **Negative**: the runtime is the real risk. The #558 failure mode was "compiles green, crashes in Hermes/JSI". Only a TestFlight build that opens a note proves a build. CI still doesn't build macOS.
- **Negative**: desktop-only native modules (`react-native-keychain`, `react-native-fs`, `react-native-document-picker-macos`, `react-native-webview`, `react-native-screens`) have no RN 0.83 track record here.
- **Negative**: tentap 1.1.0 reaches macOS in the same build. An editor regression has two suspects.
- **Negative**: the primary checkout is a one-way door. The snapshot is the only way back.
- **Neutral**: the keyboard patch covers only the keyboard path. Paper `RCTView`'s focus events still build from a nil tag. `RNCWebViewImpl` never takes first responder, so no crash is known there.
- **Negative**: mobile's `react-native` patches wait for an rnm release that peers them, because there is one hoisted `react-native`.
- **Neutral**: a Dependabot rnm PR can look mergeable on green CI. Its comment, this ADR and the release gotchas say it needs a TestFlight build first.

## Alternatives Considered

- **Pin or materialise the 0.81 fork in config** (pnpm `overrides` or alias, `.npmrc`, a `postinstall`, a bootstrap copy). This is what #558 first asked for. Rejected: [ADR-0027](./0027-desktop-react-version-locked-to-react-native-macos.md) records that React can't be split per app, and every such attempt gave a crashing or blank app.
- **Fix the keyboard crash with a Podfile `gsub` on `RCTView.m`.** Rejected: a `gsub` silently matches nothing when upstream changes. A patch file fails `pnpm install` loudly.
- **Keep the `DraftoKeyboardEventGuard.mm` swizzle.** Rejected: [ADR-0063](./0063-desktop-native-runtime-patches.md) existed only because the fossil couldn't take a patch. The swizzle is less visible and binds to an RN method by name.
- **Keep ignoring rnm minors in Dependabot.** Rejected: ADR-0027 allowed that only while #558 was open. A group PR of its own keeps the tracking signal without letting rnm break the weekly group.
- **A standalone Dependabot PR for rnm alone, with `react-native` and the tooling left in `minor-and-patch`.** Rejected: an rnm patch release that peers a newer `react-native` patch fails the peer check because `react-native` stays behind, and a `react-native` patch in the weekly group fails it from the other side and holds up every package in that group.
