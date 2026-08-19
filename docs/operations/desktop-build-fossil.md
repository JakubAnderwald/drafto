# ⚠️ macOS desktop build — do NOT reinstall main's `node_modules`

**Status:** the working macOS desktop build is a **fossil**. `apps/desktop` only builds and runs
correctly from the `node_modules` already present in the build machine's primary checkout
(`/Users/jakub/code/drafto` on the current release machine), which was installed months ago and
**must not be reinstalled**. This is resolved for good by upgrading
desktop to `react-native-macos@0.83` (React 19.2) once it ships — see
[ADR-0027](../adr/0027-desktop-react-version-locked-to-react-native-macos.md) and
[#558](https://github.com/JakubAnderwald/drafto/issues/558).

## Why

`react-native-macos@0.81.6` requires **React 19.1.x** and crashes at runtime on React **19.2.x**. The
monorepo's _declared_ versions have since drifted forward (React 19.2.x, newer native modules — via
Dependabot) because mobile's `react-native@0.86` needs React 19.2. Main's `node_modules` was never
reinstalled, so it kept the working React-19.1.x set. A clean `pnpm install` pulls the current
versions → **crashing / blank build** (crash on note-open, then crash on launch, then empty screen as
each layer is pinned). Full analysis: [#558](https://github.com/JakubAnderwald/drafto/issues/558).

## The rule

The invariant is about the **installed React version**, not about one blessed directory:

> Build macOS **only** from a checkout whose hoisted `node_modules/react` is **19.1.x** — the
> primary checkout, or a clonefile replica of it. Never from a fresh install, a worktree
> install, or CI.

- **Do NOT run `pnpm install` in the build machine's primary checkout**
  (`/Users/jakub/code/drafto` on the current release machine) until desktop is upgraded to
  `react-native-macos@0.83`. It overwrites the working set and destroys the only shippable
  desktop build.
- Build desktop releases from that checkout's existing `node_modules`:
  `cd apps/desktop && pnpm release:beta`.
- **Nor in `/Users/jakub/code/drafto-beta-desktop`** — the factory's desktop build root. Its
  `node_modules` is a byte-faithful APFS clonefile copy of the fossil (the repo is
  `node-linker=hoisted`, so packages are real directories rather than store symlinks — the only
  symlinks are the relative ones under `.bin/`, which keep resolving inside the copy, so the clone is
  faithful and costs ~0 bytes). The
  factory hard-resets that worktree's _source_ to the commit under test but never reinstalls its
  dependencies. Installing there recreates the 19.2 breakage.
- **Enforced in code.** `assertDesktopFossil()` in `scripts/lib/dispatch-release.mjs` reads the
  build root's `node_modules/react/package.json` and refuses to spawn the lane unless it is
  19.1.x. This is the enforcement point for the rule above — it turns a silently-crashing build
  into a loud refusal, reported on the issue. Bump `DESKTOP_REACT_RANGE` there (and ADR-0027)
  when `react-native-macos` moves.
- The factory previously built desktop from its own checkout, which is a normal install carrying
  React 19.2 — that produced a compiling, crashing app and is fixed (ADR-0030). It now builds
  from the fossil-derived root above.

Reminder: **a green compile is not proof.** Only a TestFlight build that opens and renders a
note validates a desktop build root — including after re-cloning the replica.

## The known-good version set (build 34 / build 40)

If the fossil is ever lost, this is the working set to reconstruct:

| package                                       | working version |
| --------------------------------------------- | --------------- |
| `react`                                       | `19.1.4`        |
| `react-native` (`apps/desktop/node_modules/`) | `0.81.6`        |
| `react-native-macos`                          | `0.81.6`        |
| `react-native-safe-area-context`              | `5.7.0`         |
| `react-native-svg`                            | `15.15.4`       |
| `@react-native-async-storage/async-storage`   | `3.0.2`         |
| `react-native-screens`                        | `4.24.0`        |

Mobile and web use React `19.2.x` and newer native modules — that is correct and unaffected. Only the
macOS desktop app is pinned to this older, `react-native-macos`-compatible set.
