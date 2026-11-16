# 0081 — Reuse Pre-Merge Betas Across PR Heads

- **Status**: Accepted
- **Date**: 2026-11-16
- **Authors**: Jakub Anderwald, with Claude Code

## Context

[ADR 0030](./0030-in-test-scenarios-and-pre-merge-betas.md) builds a pre-merge beta for every native lane the PR touches, keyed on the PR head. Every new head rebuilds every such lane, because the lanes come from the **whole** PR diff (`derivePlatforms`), not from what changed since the last build. A head whose only change is docs, a migration rename or a web fix still rebuilds iOS, Android and macOS: about 20–40 minutes of the Mac mini each, a new TestFlight / Play build number for the tester to find, and a new "build N uploaded" comment.

#794 (PR #802) got 12 builds over 5 heads. The analysis that led to this ADR assumed some of those heads changed nothing native. Replaying the rule below over them (see Consequences) shows they all did, but the cost is real for any card whose later heads are docs, web or migration-only.

## Decision

1. **A lane keeps its last successful beta when nothing it builds from changed.** For each lane that passes the existing gate (`intest_beta_gate`), `intest_beta_reuse_decide` looks at `intestBetaBuilt`, the commit of the lane's last successful pre-merge build. It reuses that build when:
   - `gh api repos/…/compare/<built>...<head>` says `ahead` or `identical`, so the head contains the build's commit (merges from main are in the tree diff, so they count; a rebase reads `diverged` and rebuilds);
   - the compare lists fewer than 300 files (the API's cap, so the list is complete);
   - `laneNeedsRebuild(files, lane)` in `dispatch-release.mjs` finds none of the files, a rename's old path included, among the lane's inputs.
2. **The rule is a conservative allowlist.** A lane is reused only if every changed file is in `docs/`, a `*.md` file, `supabase/`, `apps/web/`, `.github/`, `.claude/`, `scripts/` other than the root scripts the Fastfiles run (`FASTLANE_SCRIPT_INPUTS`, with what they import; a test recomputes it from the Fastfiles), or the other lane's app. Everything else rebuilds: root files (`pnpm-lock.yaml`, `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `patches/`, `app.json`, `index.js`, …), `packages/shared/`, the lane's own app (tests included) and any path the rule doesn't know. `derivePlatforms` ignores root files when it picks lanes, but they change binaries. `supabase/config.toml` rebuilds too, although it isn't in any binary: a head that changes it must reach the hosted-config gate ([ADR 0065](./0065-factory-hosted-config-gate.md)), and only a dispatch does.
3. **The decision is made once per head.** It runs inside `intest_dispatch_betas` when the head differs from `intestBetaSha`. When it compared anything, it moves `intestBetaSha` to the head, clears the previous head's `intestBetaLanes` and `intestBetaAttempts` (a new head drops them anyway) and writes `intestBetaReused` (`mobile:<built-sha40>,…`). Later ticks see the same head and read the decision back, so the compare API is called at most once per head and build commit (both lanes share one call when they were built at the same commit). A reused lane is never dispatched for that head and isn't in `intestBetaLanes`, which still means "confirmed started for this commit".
4. **What counts as a successful build.** `intest_check_lane_outcomes` writes the head into `intestBetaBuilt` when a lane's `.exit` reads 0. The decision also accepts a lane of the previous head whose `.exit` reads 0 but which no outcome check saw before the head moved. A failed build, an in-flight one, an API error, a non-`ahead` status or too many files all fall back to today's rebuild. Adopting an in-flight build is left as a follow-up.
5. **Outcome checks skip reused lanes.** There is no log for them at this head, so `intest_check_lane_outcomes` would otherwise call them killed and rebuild them. A reused lane is never in `intestBetaLanes`, so the skip only guards a hand-edited or half-written record, and it never applies to a lane with an attempt on record for the head. The decision writes `intestBetaSha` last, after the fields it keys, so a write cut short never files the old head's lanes under the new one.
6. **The tester is told which build to keep.** `betaDispatch` gains `reused: [{id, fromSha, builds: [{platform, build}]}]`. `intest_reused_builds` fills `builds` from the lane's own notices (`comment-intest-build.mjs`): an OWNER comment with `drafto-factory-intest-build:<platform>:<n>` whose body carries ``@ `<fromSha12>` ``, the latest per platform. The scenario prompt, the bash fallback comment and the verification report all say "No mobile change since Android build 152 / iOS build 147 (`9248da9a0c63`); keep testing that build." (or "No macOS change since build 80 …"). Without a number they name the commit and point at the earlier comment. For mobile the same three add the Android caveat, because Play's internal track serves only its newest upload: "Android: Play's internal track serves only its newest upload, so check that the installed build number is 152. If Play shows a newer build, this card's Android build is no longer installable from Play; test iOS from TestFlight and ask in a comment for the Android build." TestFlight keeps older builds, so iOS and macOS get no caveat. `reusedBetaNote` / `reusedAndroidCaveat` in `factory-bundle.mjs` and the jq in `intest_fallback_comment` produce the same words, and a test pins them equal.
7. **Kill switch.** `FACTORY_INTEST_BETA_REUSE` (default `1`). `0` ignores `intestBetaReused` and rebuilds every lane for every head, as before; the next dispatch clears the stale value. A value other than `0` or `1` turns reuse off with a warning.

## Consequences

- **Positive**:
  - A card whose later heads change only docs, web, migrations or factory scripts keeps its native builds: no 20–40 minute rebuild per lane, no new build number for the tester to chase, and the build root stays free for other cards.
  - The decision costs one compare call per head and build commit, not one per tick.
  - Reuse is visible: the factory log says `beta lane mobile reused from <sha12>`, and the In Test comment and the verification report name the build.
- **Negative**:
  - The allowlist is deliberately narrow, so many heads still rebuild. Replaying it over #802's five built heads reuses nothing: each transition touched a native input. 9248da9a0c63 → 9859c88addb1 brought `.npmrc` and `pnpm-workspace.yaml` in from main; the next three changed `packages/shared/` or the lane's own app; 2edc84cc3a90 → 6e093f6e6d18 brought root `package.json` and both Fastfiles. Even the migration-rename commit (`0d7832c18c39`) edited `packages/shared/src/constants.ts`.
  - Google Play's internal track serves only its latest release. If another card uploads after the reused Android build, a tester can't install the reused one from Play any more. TestFlight keeps older builds installable. The same already happens between a build and its test today. So every reused mobile line carries an Android caveat (decision 6): check the installed build number, and if Play shows a newer one, test iOS and ask for the Android build in a comment.
  - `intestBetaSha` can now move to a head before any lane started for it. Every reader keys on `intestBetaLanes` for "started", so the retry stays armed.
- **Neutral**:
  - A lane that a gate skips (knob off, low disk, Phase B) is not evaluated, so it reads as skipped, as before.
  - An operator who wants a reused lane rebuilt clears `intestBetaReused` with `factory:set-issue-field`; the same head won't be decided again.

## Alternatives Considered

1. **Derive lanes from the diff since the last built head (`derivePlatforms` on the delta).** Rejected. `derivePlatforms` ignores root files and patches, which change binaries, and it would miss a lane whose last build failed.
2. **Compare consecutive heads instead of the built commit.** Rejected. A head that was never built (the card skipped In Test, or a dispatch was held) would hide the changes before it.
3. **A denylist of native paths.** Rejected. A new root file or package would silently reuse a stale binary. An allowlist fails safe: an unknown path rebuilds.
4. **Adopt an in-flight build for the new head.** Deferred. It would need the build's outcome to be read under the new head's key, and a failure then to re-arm the new head. The previous head's finished build is adopted, which covers the common race.
5. **Cache the decision per tick only.** Rejected. A held dispatch (busy build root, hosted-config gate) would call the compare API every five minutes until it cleared.

## Related

- [ADR 0030: In Test Scenarios and Pre-Merge Beta Builds](./0030-in-test-scenarios-and-pre-merge-betas.md)
- [ADR 0067: Desktop moves to react-native-macos 0.83](./0067-desktop-moves-to-react-native-macos-0-83.md)
- [ADR 0026: Dark Factory Unattended Development Pipeline](./0026-dark-factory-pipeline.md)
