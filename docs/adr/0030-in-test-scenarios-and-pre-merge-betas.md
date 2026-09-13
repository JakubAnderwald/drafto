# 0030 — In Test Scenarios and Pre-Merge Beta Builds

- **Status**: Accepted
- **Date**: 2026-07-30
- **Authors**: Jakub (with Claude)

## Context

**In Test** is one of the factory's two human gates: a card sits there until a
person tests the change and drags it to **Approved** (ADR-0026). The gate only
works if the human can actually test the thing.

Issue #463 (PR #591 — "reset local WatermelonDB on sign-out") showed it couldn't:

- The PR touched only `apps/mobile/**` and `apps/desktop/**` — **zero web
  files** — yet the In Test comment was a hardcoded _"CI is green and the Vercel
  preview is live"_ with a web preview link. That preview exercised none of the
  change. The comment body was platform-blind by construction.
- **No native build existed.** Beta dispatch was gated to `PHASE == "D"` _and_
  ran only post-merge in `--release`. The factory runs at Phase C, so nothing
  reached TestFlight or the Play internal track. The only way to test was to
  build the branch by hand — which the comment didn't explain either.
- **No test scenario.** The In Test hand-off was pure bash with no Claude
  invocation, so the reporter got a status line and was left to derive a test
  plan from the diff.

The advance also _required_ a Vercel preview URL before it would move a card to
In Test — a gate that is meaningful for a web change and meaningless for a
native one.

Two further constraints shaped the fix. First, the **desktop fossil**
(ADR-0027): `react-native-macos@0.81` needs React 19.1.x, the monorepo declares
19.2.x, and a desktop build from a 19.2 checkout compiles green and crashes at
runtime. Verified on the Mac mini: the primary checkout has React **19.1.4**, the
factory's own checkout **19.2.6** — so the existing Phase-D desktop lane, which
built from `${repoRoot}/apps/desktop`, would have shipped a broken app the moment
Phase D was switched on. Second, the fossil checkout **is the operator's working
tree**, and it is permanently dirty: the desktop Fastlane lane itself mutates
`Info.plist` and `project.pbxproj` on every run. Anything that "checks out the PR
branch there and restores afterwards" is therefore a non-starter.

## Decision

**1. Every card reaching In Test gets a Claude-written manual test scenario.** A
new read-only stage (`scripts/factory-intest-prompt.md`, `factory_intest` bundle)
receives the issue, the approved plan and the **actual PR diff**, and posts the
In Test comment itself: numbered steps per platform, each with an expected
result, opening with a reproduction of the original bug so the fix is observable,
plus what failure looks like and what is only covered by unit tests. It is never
phase-gated — a card that reaches In Test always gets one.

**2. Platforms come from the diff, not the issue.** `derive-platforms` over the
changed files decides which sections the scenario has and what the comment
mentions. The issue's "Affected platforms" checkboxes are a claim that can be
stale. The Vercel preview is required — and mentioned — **only** when
`apps/web` is touched.

**3. Beta builds are dispatched pre-merge, from the PR head**, for the native
platforms the diff touched, behind a **separate opt-in**
(`FACTORY_INTEST_BETA`), with desktop behind a second knob
(`FACTORY_INTEST_BETA_DESKTOP`). The Phase-D post-merge lane is unchanged.

**4. Builds run in dedicated, disposable roots** — `drafto-beta-mobile` and
`drafto-beta-desktop` — detached at the PR head SHA, with `node_modules`
clonefile-seeded (`cp -c -R`, O(1) space). The copy is faithful because the repo
is `node-linker=hoisted`, so packages are real directories rather than store
symlinks; the only symlinks in the tree are the ~130 relative ones under `.bin/`
(e.g. `../is-docker/cli.js`), which keep resolving inside the copied tree. The
desktop root is seeded from the fossil and **never installed into**.

**5. The fossil rule is narrowed to its actual invariant.** From _"only the
primary checkout"_ to _"only a checkout whose hoisted `node_modules/react` is
19.1.x"_, enforced at dispatch time by `assertDesktopFossil()`. A stray
`pnpm install` in a build root now fails loudly instead of silently producing a
crashing app.

**6. Idempotency is SHA-keyed, not marker-keyed.** `intestCommentSha` and
`intestBetaSha` in `logs/factory-state.json`: silent within a SHA, re-armed by
new commits, so an In Test → feedback → In Test round trip yields a fresh
scenario and a fresh build.

**7. Failure degrades, never escalates.** The card transitions to In Test
_before_ the scenario stage runs. Every failure path falls back to a
deterministic platform-aware comment, and none of them bumps the retry budget —
this stage is commentary, not code, and a green card must not be marched toward
Blocked because a comment couldn't be written.

## Revision (2026-08-06, after the first live runs)

The first real runs on #463 exposed one mistake repeated across the dispatch path: **it recorded success for work it had not confirmed, and keyed retries off that record.** Three instances, all now closed:

- A dispatch blocked by a transient condition was never retried, because dispatch was nested inside the scenario hand-off and the scenario's SHA had already been recorded. Freeing disk changed nothing. **Dispatch and scenario are now evaluated independently, each on its own key.**
- A lane's output was discarded, so a lane that died on startup looked identical to one building for 40 minutes. **Lanes now write to `logs/factory/beta-lane-<lane>-<issue>-<sha12>-a<attempt>.log`** (`release-<sha12>` in place of issue+sha for the post-merge lane).
- The dispatcher returned before the OS could report a failed start, so an unstartable lane still counted as dispatched. **`dispatchLanes` is now async and returns `failed[]` separately; only a confirmed start suppresses a retry.**

Three further properties follow from the same principle:

- **Retry state is per lane.** `intestBetaLanes` is the set of lanes _confirmed started_ for `intestBetaSha`; a healthy sibling no longer hides a failed lane. Previously a mobile success suppressed a desktop retry entirely.
- **Lane artefacts are scoped per dispatch ATTEMPT** (`beta-lane-<lane>-<issue>-<sha12>-a<attempt>.log`). Keying on the lane alone let two In Test cards clobber each other and let the post-merge `--release` lane write the file a pre-merge card was waiting on; keying on the commit alone still let a _retry_ share artefacts with the attempt it replaced — and since a lane is declared stale by timeout rather than by proof of death, that predecessor may still be alive and writing.
- **Outcomes are tracked, not assumed.** Each lane's shell wrapper writes its exit code to `<log>.exit`; the sweep reads it and, on a non-zero code, drops the lane from the confirmed set (re-arming a retry) and says so on the issue once. Without this, a lane that fails at minute 20 is indistinguishable from one that shipped — which is exactly how #463's iOS lane failed on an Apple `HTTP 500` with nobody told. A wrapper killed outright never writes the file at all, so a lane whose log has been silent for `FACTORY_LANE_STALE_MIN` (or which left no artefacts at all, judged against `intestBetaAt`) is declared dead rather than suppressed forever. Retries are capped at `FACTORY_LANE_MAX_ATTEMPTS` per commit, so a deterministically-broken lane stops rather than rebuilding every five minutes; the cap resets on a new commit.

  This applies to **pre-merge** lanes only. The post-merge `--release` lane writes an `.exit` too, but nothing reads it — there is no retry loop after a merge, and the Fastlane post-hook already reports the outcome. The file is kept purely for diagnosis.

## Revision (2026-08-07, first lanes the factory ran unaided)

With outcome tracking live, the factory dispatched its own lanes for the first time — and both failed instantly. The mechanism worked exactly as intended: the traceless-lane check re-armed the very lane that had vanished the day before, and the new per-lane log named the cause in one line. What it exposed was that **the factory had never successfully run a Fastlane lane at all**; the earlier "silent death" was this, unlogged. Two environment defects, neither in the dispatch logic:

- **`bundle` resolved to system Ruby 2.6.** The launchd `PATH` carried no `~/.rbenv/shims`, so every lane died on `Could not find 'bundler'`. Operator-side fix; the failure is now visible in the lane log instead of being invisible.
- **The build inherited `umask 077`.** `factory-agent.sh` sets it so its token-bearing logs stay owner-only, but it reached the build: xcodebuild emitted a mode-700 `.app`, `productbuild` copied those modes into the pkg, and App Store Connect rejected all three attempts with **ITMS-90255**. **The lane wrapper now sets `umask 022`, and `ensure_beta_build_root` normalises the checkout with a `go+rX` pass that prunes the seeded credentials rather than widening and restoring them** — the build's own output and the resources it copies in are separate halves of the same problem, and the checked-out fonts/assets were mode 600 too. Normalising the _inputs_ rather than chmod-ing the signed `.app` keeps the fix clear of the code signature.

This class of bug is invisible to a manual test: an interactive shell runs at umask 022, so building by hand — the exact thing done to validate build 48 — cannot reproduce it. The macOS lane had genuinely never been exercised under the environment it actually runs in.

One reporting gap surfaced with it: **a failure comment is never retracted.** #463 carried "the `mobile` beta build failed" as the last word on the issue while a working build sat on TestFlight, because a later success said nothing. A lane that succeeds after having announced a failure for the same commit now posts a one-time retraction.

Also settled: **the clonefile fossil replica is validated.** macOS build 48 was built from `/Users/jakub/code/drafto-beta-desktop`, uploaded to TestFlight, installed, and opens a note — the runtime proof this ADR said a green compile could not provide. `apps/desktop/scripts/verify-testflight-build.sh` is now in the repo and launches the app rather than only inspecting its bundle, so the hard-crash case is caught automatically; a blank screen still needs a human, and the script says so.

## Consequences

- **Positive**: the In Test gate is usable for native changes for the first time.
  The reporter gets steps rather than a diff. The latent Phase-D bug that would
  have shipped a crashing macOS build is fixed, and the fossil invariant is now
  machine-checked rather than documented-only. Pre-merge betas are also the
  natural way to accumulate the runbook's C→D evidence.
- **Negative**: TestFlight and the Play internal track now carry builds of code
  that may never merge. Accepted — beta channels are pre-authorised and
  self-superseding per CLAUDE.md "Release Authorization", and every such build's
  release notes begin `PRE-MERGE TEST BUILD — issue #N / PR #M (sha)`. Each In
  Test revision also consumes a build number (bounded by the SHA-keyed guard).
  The scenario stage adds one Claude call per card (read-only effort tier).
- **Negative**: the clonefile replica is _believed_ fossil-faithful but only a
  TestFlight build that opens a note proves it. Mitigated by shipping desktop
  dispatch **off**, behind its own knob, plus the runtime React assertion.
- **Neutral**: two new persistent build roots on the Mac mini. `node_modules`
  costs ~0 bytes (clonefile) but native build artefacts accumulate; the existing
  `FACTORY_MIN_FREE_DISK_GB` guard skips dispatch when space is short, and the
  runbook says to prune artefacts rather than the roots.

## Alternatives Considered

- **Build in the primary checkout behind a clean-tree guard, restoring
  afterwards.** Rejected: the tree is permanently dirty and the desktop lane
  dirties it further, so the guard would never pass; and a detached 20-40 minute
  build has no reliable point at which to restore. It would also leave the
  operator's checkout on a factory branch for the duration.
- **Build in the issue's own worktree.** Rejected: the next `--watch` tick may
  `pnpm install` and let Claude edit files there, and the cleanup sweep removes
  it as soon as the card leaves In Test — both mid-build. A fixed root also keeps
  `ios/Pods` and the Gradle cache warm.
- **Promote the factory to Phase D to get pre-merge betas.** Rejected: it would
  also switch on post-merge auto-dispatch and bypass the documented C→D
  promotion criteria. A separate knob keeps the blast radius to what was asked
  for.
- **Have the planner or the implementer write the scenario.** Cheaper (no extra
  Claude call) but wrong-timed: the planner writes before implementation and can
  drift, and the implementer's PR "Test plan" is CI-command-shaped rather than a
  human scenario. The In Test stage sees the final diff, after CI fixes.
- **A monotonic issue marker for beta idempotency** (as the post-merge lane
  uses). Rejected: right for one merge, wrong for In Test, where iteration must
  produce a build of the new code.
- **Extending `comment-released-issues.mjs`** for the build notice. Rejected:
  both of its premises (walk merged commits since the last tag; intersect with
  `support`-labelled issues) are false pre-merge.
