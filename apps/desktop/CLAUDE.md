# Desktop (macOS) app — read before any build or release

## Desktop builds like mobile: from any checkout, after `pnpm install`

The desktop app runs `react-native-macos@0.83` on the monorepo's single React 19.2 and
`react-native` 0.83, the same versions mobile uses ([ADR-0067]). A plain `pnpm install` gives one
consistent dependency graph, so desktop builds from any checkout: a worktree, the primary checkout,
or the factory's build root.

The old "fossil" rule is retired. The primary checkout is no longer special: install there like
anywhere else. [ADR-0027] records why it existed (#558).

**A green native build is still not proof it works. Only a TestFlight build that opens a note is.**
A React/JSI mismatch compiles cleanly and then crashes at launch.

## Build and release

```bash
pnpm install                         # at the repo root
bash scripts/worktree-bootstrap.sh   # copies apps/desktop/.env and .env.production
cd apps/desktop && bundle install
pnpm release:beta
```

The Fastfile's `build_and_submit` checks two things before CocoaPods runs:

- **Dependency preflight.** The installed `node_modules/react-native-macos` must equal the version
  `apps/desktop/package.json` declares, and `node_modules/react` must be 19.2.x. Otherwise the lane
  stops and tells you to run `pnpm install` at the repo root. This catches a `git pull` with no
  install after it. `assertDesktopDeps()` in `scripts/lib/dispatch-release.mjs` runs the same check
  before the factory spawns a desktop lane.
- **`NODE_BINARY`.** If `macos/.xcode.env.local` is missing, or its `NODE_BINARY` is not an
  executable file, the lane rewrites it from `node -p process.execPath`.

## Rules

- `react-native-macos` is pinned to an exact version, so every native change is a visible diff.
  `react-native` and the `@react-native/*` tooling match the version rnm peers, which is mobile's.
- A native module's codegen spec must parse with rnm's `@react-native/codegen` (0.83). That is why
  `react-native-screens` is pinned to `~4.24.0`: 4.26's Android-only spec fails `pod install` with
  `setToolbarMenuElementOptions must be of type React.ElementRef<>`.
- A native bug in React Native goes in a `pnpm patch` under `patches/`, registered in the root
  `package.json`'s `pnpm.patchedDependencies` under a range key that covers the exact pinned version
  (`react-native-macos@~0.83.0`). Never patch it at runtime from `macos/Drafto-macOS/`.
- `@react-native-community/cli` and `@react-native-community/cli-platform-ios` move together, never
  one alone. `use_native_modules!` runs the core's `config`, which builds the macOS config through
  `cli-platform-ios`. A split version is an untested combination.
- Each `react-native-macos` release arrives as its own Dependabot PR. Before it merges, the patch
  must be re-made (minor) or still apply (patch), and a TestFlight build must open a note. CI does
  not build macOS.
- macOS has no `tentap` pod: its podspec is iOS-only, so autolinking skips it and tentap uses its
  JS keyboard driver. If a `tentap` pod appears in `macos/Podfile.lock`, the platform filter changed.

Full detail: [ADR-0067] · [`../../docs/operations/builds-and-releases.md`](../../docs/operations/builds-and-releases.md).

[ADR-0027]: ../../docs/adr/0027-desktop-react-version-locked-to-react-native-macos.md
[ADR-0067]: ../../docs/adr/0067-desktop-moves-to-react-native-macos-0-83.md
