# ⚠️ macOS desktop build — do NOT reinstall main's `node_modules`

**Status:** the working macOS desktop build is a **fossil**. `apps/desktop` only builds and runs
correctly from the `node_modules` already present in the primary checkout (`/Users/jakub/code/drafto`),
which was installed months ago and **must not be reinstalled**. This is resolved for good by upgrading
desktop to `react-native-macos@0.83` (React 19.2) once it ships — see
[ADR-0027](../adr/0027-desktop-react-version-locked-to-react-native-macos.md) and
[#558](https://github.com/JakubAnderwald/drafto/issues/558).

## Why

`react-native-macos@0.81.6` requires **React 19.1.x** and crashes at runtime on React **19.2.x**. The
monorepo's _declared_ versions have since drifted forward (React 19.2.6, newer native modules — via
Dependabot) because mobile's `react-native@0.86` needs React 19.2. Main's `node_modules` was never
reinstalled, so it kept the working React-19.1.x set. A clean `pnpm install` pulls the current
versions → **crashing / blank build** (crash on note-open, then crash on launch, then empty screen as
each layer is pinned). Full analysis: [#558](https://github.com/JakubAnderwald/drafto/issues/558).

## The rule

- **Do NOT run `pnpm install` in `/Users/jakub/code/drafto`** (the primary checkout) until desktop is
  upgraded to `react-native-macos@0.83`. It overwrites the working set and destroys the only shippable
  desktop build.
- Build desktop releases from that checkout's existing `node_modules`:
  `cd apps/desktop && pnpm release:beta`.
- The factory's automated desktop builds (clean checkout) are currently **broken** for the same
  reason — ship desktop manually from the primary checkout until the rnm 0.83 upgrade lands.

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

Mobile and web use React `19.2.6` and newer native modules — that is correct and unaffected. Only the
macOS desktop app is pinned to this older, `react-native-macos`-compatible set.
