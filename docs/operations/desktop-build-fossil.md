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

## One-time step: the primary checkout

The primary checkout's first post-merge `pnpm install` destroys the fossil. Before running it,
take a clonefile snapshot of the fossil's `node_modules` trees:

```bash
cd /Users/jakub/code/drafto
cp -c -R node_modules ../drafto-fossil-snapshot-node_modules
cp -c -R apps/desktop/node_modules ../drafto-fossil-snapshot-desktop-node_modules
```

Then install. The fossil's `node_modules` record the old store (`/Volumes/Zewnętrzny/pnpm-store`),
so pnpm asks to remove them first. Answer yes, or in a session without a TTY run
`pnpm install --config.confirm-modules-purge=false`, which otherwise aborts with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.

Keep the snapshot until a post-merge TestFlight build opens a note. To roll back, revert the
ADR-0067 PR and restore the snapshot. `drafto-beta-desktop` is not a backup: the factory
reinstalls it on its first post-merge build, purging its old `node_modules` without a prompt
(`run_pnpm_install` passes the same flag).

Until that TestFlight build has opened a note, keep the factory's macOS lane off: set
`FACTORY_INTEST_BETA_DESKTOP=0` in the factory plist before merging, and turn it back on after the
validation in [`factory-runbook.md`](./factory-runbook.md#pre-merge-beta-dispatch-in-test).
