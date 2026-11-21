# macOS desktop build fossil (retired)

**Status:** retired by [ADR-0067](../adr/0067-desktop-moves-to-react-native-macos-0-83.md)
([#558](https://github.com/JakubAnderwald/drafto/issues/558)). Desktop now builds from any
checkout after a plain `pnpm install`, like mobile. This page stays so links from older ADRs and
docs still resolve.

## What the fossil was

`react-native-macos` 0.81 needed React 19.1, but the monorepo moved to React 19.2 for mobile, and
React must be one shared instance ([ADR-0027](../adr/0027-desktop-react-version-locked-to-react-native-macos.md)).
The only working desktop `node_modules` was the primary checkout's (`/Users/jakub/code/drafto`),
installed before the React bump and never reinstalled. It carried React 19.1.4 and a hand-placed
`react-native` 0.81.6 fork under `apps/desktop/node_modules/react-native`.

A fresh install couldn't reproduce it, so desktop shipped only from that checkout or from the
factory's clonefile replica, `/Volumes/DraftoFactory/drafto-beta-desktop`. Anywhere else the build
failed at the Hermes phase (`with-environment.sh: No such file`), or compiled and then crashed.

## What replaced it

Desktop is on `react-native-macos` 0.83.0, which uses React 19.2 and `react-native` 0.83.10, the
same as mobile. The build reads `react-native-macos` directly, so it no longer needs a per-app
`react-native`. Build from any checkout:

```bash
pnpm install
bash scripts/worktree-bootstrap.sh
cd apps/desktop && bundle install
pnpm release:beta
```

- The Fastfile's `build_and_submit` lane runs a dependency preflight before CocoaPods. It refuses
  to build unless the installed `react-native-macos` matches `apps/desktop/package.json` and React
  is 19.2.x. If it fails, run `pnpm install`.
- The same lane writes `NODE_BINARY` into `macos/.xcode.env.local` when the file is missing or
  stale.
- The factory checks the same invariant with `assertDesktopDeps()` in
  `scripts/lib/dispatch-release.mjs`, and its desktop build root now installs like the mobile one.
- Native fixes to `react-native-macos` go in `patches/` as a `pnpm patch`. See ADR-0067.

A green compile is still not proof. Only a TestFlight build that opens a note validates a desktop
build.

## One-time step: the primary checkout (done)

This step no longer applies. It asked for a clonefile snapshot of the fossil's `node_modules`
before the primary checkout's first post-ADR-0067 `pnpm install`, and for the factory's macOS
lane to stay off (`FACTORY_INTEST_BETA_DESKTOP=0`) until a post-merge TestFlight build opened a
note. As found on 2026-11-21:

- The primary checkout's `node_modules` had already been reinstalled: react-native-macos 0.83.0,
  on the standard pnpm store rather than the fossil's `/Volumes/Zewnętrzny/pnpm-store`. No
  snapshot was kept.
- Post-merge desktop betas `desktop@0.4.6+94` and `desktop@0.4.6+97` were built on rnm 0.83, and
  the pre-merge build 96 opened notes in the #861 In-Test run.

So the validation is done. If `FACTORY_INTEST_BETA_DESKTOP=0` is still set in the factory plist,
turn it back on ([`factory-runbook.md`](./factory-runbook.md#pre-merge-beta-dispatch-in-test)).

The old primary checkout also kept a `apps/desktop/macos/Pods` cache from rnm 0.81, which made
CocoaPods refuse the first post-merge build there ("could not find compatible versions for pod
hermes-engine"). The Fastfile now clears such a cache before CocoaPods (`clear_stale_pods_cache!`).
