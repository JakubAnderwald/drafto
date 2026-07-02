# 0027 — Desktop's React version is locked to react-native-macos; defer reproducibility to rnm 0.83

- **Status**: Accepted
- **Date**: 2026-07-02
- **Authors**: Jakub Anderwald

## Context

The macOS desktop app builds on **`react-native-macos`** — Microsoft's macOS fork of React Native.
The fork is actively maintained but **trails upstream React Native by a few versions**: its latest
stable is `0.81.8` (shipped 2026-06-26) with `0.83` in progress, while mobile is on
`react-native@0.86`.

The version lag matters because each React Native release pins a specific **React** major/minor:

| React Native  | requires React |
| ------------- | -------------- |
| 0.81, 0.82    | 19.1.x         |
| **0.83**–0.86 | **19.2.x**     |

RN 0.83 is the boundary where React moved 19.1 → 19.2. Desktop is on rnm **0.81** (React 19.1);
mobile is on RN **0.86** (React 19.2, currently pinned to 19.2.6; RN 0.86 peers `^19.2.3`).

**React must be a single shared instance across the monorepo.** This was established the hard way
(issue #558): forcing a per-app React split makes pnpm nest a separate React copy under each
consuming package, and multiple React instances — even at the same version — break Context/hook
identity and render the tree empty with no error. A Metro-level dedup could not reliably collapse
them; only a single, uniform React works.

Combining those two facts: **desktop's rnm 0.81 caps the shared React at 19.1**, which conflicts with
mobile's RN 0.86 (needs 19.2). Today the working desktop build exists only as a "fossil" `node_modules`
(React 19.1.4) that was installed before Dependabot bumped the declarations forward and never
reinstalled; a clean `pnpm install` pulls React 19.2 and produces a crashing/blank desktop build. See
`docs/operations/desktop-build-fossil.md`.

## Decision

1. **Do not force a monorepo-wide React downgrade** to 19.1.4. It would make desktop reproducible but
   drag mobile/web back a React version (RN 0.86 genuinely needs React 19.2). Mobile and web stay
   current (React 19.2 + RN 0.86).
2. **Do not pin/materialise the desktop "fossil island"** in version control. Reproducing the old set
   package-by-package is fragile and, because React can't be split, cannot be made to work cleanly
   (the failed #558 investigation).
3. **Interim:** ship desktop from the primary checkout's fossil `node_modules` (the documented
   build-from-main workaround). Desktop clean-install reproducibility (#558) is **deferred**, not lost.
4. **Real fix — adopt `react-native-macos@0.83`** (a fork of RN 0.83 → React 19.2) **when it is
   published.** Bumping `apps/desktop` to it lets desktop run React 19.2, rejoin the shared React,
   and a clean install works for all platforms — closing #558 with a one-line version bump.
5. **Establish an upgrade cadence:** track rnm releases and keep desktop within ~1–2 versions of
   upstream so it never lags far enough to fossilise again. Do **not** freeze the rnm/React pair from
   Dependabot permanently; instead upgrade the pair deliberately, together, verified by a TestFlight
   build that opens a note.
6. **Do not migrate off `react-native-macos`.** It is maintained; a migration (Tauri/Electron over the
   web app, or native) is a fallback to revisit only if the lag becomes untenable.

## Consequences

- **Positive**: Mobile and web stay on the current stack (React 19.2, RN 0.86). No risky migration.
  The fix path is concrete and cheap — a version bump to rnm 0.83 when it ships. No monorepo-wide
  dependency surgery lands now.
- **Negative**: Desktop clean-install reproducibility (#558) is deferred until rnm 0.83. Until then,
  desktop must be built from the primary checkout's `node_modules`, which must not be reinstalled
  (see the fossil doc). Someone has to watch for the rnm 0.83 release.
- **Neutral**: The desktop app intentionally lags a React Native (and React) version behind mobile
  until rnm catches up — inherent to using an out-of-tree fork.

## Alternatives Considered

- **Uniform React 19.1.4 monorepo-wide + revert mobile RN to 0.83.2.** Proven to make desktop
  reproducible (macOS build 42 launches and opens notes), but freezes mobile/web on the old React too.
  Rejected: sacrifices mobile currency for a problem that rnm 0.83 resolves on its own.
- **Pin/materialise the fossil island** (React 19.1.4 scoped + native-module pins + Metro React-dedup).
  Rejected: the React split produces multiple React instances (empty screen); not cleanly fixable —
  this is the failed core of the #558 investigation.
- **Migrate the desktop app off `react-native-macos`** (Tauri/Electron over the web app, or native).
  Rejected as premature: rnm is maintained and about to close the gap; kept as a fallback.
