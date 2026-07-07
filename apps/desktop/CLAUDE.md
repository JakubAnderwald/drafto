# Desktop (macOS) app — read before any build or release

## ⚠️ The desktop build is a FOSSIL — do not reinstall, do not build from a worktree

`react-native-macos@0.81` (the macOS RN fork this app uses) requires **React 19.1.x**. The monorepo's
_declared_ React is **19.2.6** — mobile's `react-native@0.86` needs it, and React must be a single
shared instance across the monorepo ([ADR-0027], [#558]). The **only** working desktop build is the
**fossil `node_modules` in the primary checkout** (`/Users/jakub/code/drafto`), installed before the
React bump and **never reinstalled**.

A clean `pnpm install` — **including any fresh git worktree** — pulls React **19.2.6**, which the 0.81
fork cannot run: the app **compiles green but crashes at runtime** (Hermes `EXC_BAD_ACCESS`, blank
screen, crash-on-note-open). **A green native build is NOT proof it works — only a TestFlight build
that opens a note is.**

## Rules

- **NEVER** run `pnpm install` in the primary checkout (`/Users/jakub/code/drafto`) — it overwrites
  the fossil and destroys the only shippable desktop build.
- **NEVER** build or release the desktop app from a worktree, a fresh install, or CI — all of them
  resolve React 19.2 and produce the crashing build.
- Build/ship desktop **only** from the primary checkout's existing fossil `node_modules`:

  ```bash
  cd /Users/jakub/code/drafto     # primary checkout — the fossil (React 19.1.4)
  git pull                        # source only — NEVER `pnpm install`
  cd apps/desktop && pnpm release:beta
  ```

- Doing desktop **code / unit-test / typecheck** work in a worktree is fine (JS tooling runs there);
  just never treat a worktree's native build as shippable, and route the actual release through the
  fossil.

## Why not just fix it?

React cannot be split per-app (multiple React instances break hooks/Context — the empty-screen
failure in [#558]), and we will not drag mobile/web back to React 19.1. The real fix is a one-line
bump to `react-native-macos@0.83` (React 19.2) **once it ships**. Until then, the fossil stands.

Full detail: [`../../docs/operations/desktop-build-fossil.md`](../../docs/operations/desktop-build-fossil.md)
· [ADR-0027](../../docs/adr/0027-desktop-react-version-locked-to-react-native-macos.md).

[ADR-0027]: ../../docs/adr/0027-desktop-react-version-locked-to-react-native-macos.md
[#558]: https://github.com/JakubAnderwald/drafto/issues/558
