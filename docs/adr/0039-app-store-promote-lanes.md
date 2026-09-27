# 0039 — App Store Submission Promotes an Existing TestFlight Build

- **Status**: Accepted
- **Date**: 2026-09-27
- **Authors**: Jakub Anderwald (via the dark factory, issue #625)

## Context

Drafto's iOS and macOS apps were ready to leave TestFlight for the public App
Store and Mac App Store. The only Apple submission path in the repo was
`fastlane ios production` / `fastlane mac production` — lanes that **rebuild from
source** and then `upload_to_app_store`. That shape has four problems for a
first public release.

**The reviewed binary is not the tested binary.** `release:prod:ios` runs
`expo prebuild --clean` → CocoaPods → `gym`, producing an IPA no tester has ever
launched. A beta cycle that proves a build good is worth nothing if the build
Apple reviews is a different one. The macOS side is worse: per
[ADR-0027](./0027-desktop-react-version-locked-to-react-native-macos.md) a
desktop build from any checkout carrying React 19.2 **compiles fine and crashes
at runtime**, so "rebuild to submit" re-runs the single most dangerous build in
the repo at the highest-stakes moment.

**`deliver` had to guess the platform.** App Store Connect app `6760675784`
serves both iOS and macOS under bundle id `eu.drafto.mobile`. Neither lane passed
`app_version:` or `platform:`, so a submission could attach itself to the other
platform's version.

**Submissions stalled on the questionnaire.** Neither lane sent
`submission_information`, so every upload left the IDFA, export-compliance and
content-rights questions unanswered — each one a manual blocker before Apple
will accept the submission.

**The pipeline announced releases that had not happened.** Both lanes called
`comment_released_issues` on the App Store path, and
`scripts/comment-released-issues.mjs` posts the literal text
`Now live in <track>.` to every support issue the release closed. An App Store
upload is not a release: the build still has to pass App Review and then be
released by hand. Customers would have been emailed about an update they could
not install.

Separately, the dark factory's beta-only guard had a hole waiting for whatever
lane came next: `PROD_DENYLIST` in `scripts/lib/dispatch-release.mjs` matched
`/release:prod\b/i`, which does **not** match `release:promote` — there is no
`d` in "promote".

## Decision

**Submit an existing build; never rebuild to submit.** Each Fastfile gains a
`promote` lane that calls
`upload_to_app_store(skip_binary_upload: true, skip_metadata: true, skip_screenshots: true, …)`
against a build already in App Store Connect:

- `apps/mobile/fastlane/Fastfile` → `fastlane ios promote`
  (`pnpm release:promote:ios`), `platform: "ios"`.
- `apps/desktop/fastlane/Fastfile` → `fastlane mac promote`
  (`pnpm release:promote`), `platform: "osx"`.

The build number defaults to the newest build of the version in that app's
`package.json` (`latest_testflight_build_number`, filtered by version, platform
and `app_identifier`) and can be pinned with `build_number:`. Options
`submit:` (default `true`), `phased_release:` (default `true`) and
`automatic_release:` (default `false`) map onto `deliver`. Every App Store upload
— `promote` and the retained rebuild lanes — now passes explicit `app_version:`,
`platform:`, `app_identifier:` and a shared `APPSTORE_SUBMISSION_INFORMATION`
constant (no IDFA, exempt encryption, no third-party content). Note what
`deliver` does with that last one: it reads the hash inside
`Deliver::SubmitForReview`, which `Runner#run` reaches only when
`submit_for_review` is true. The answers therefore reach App Store Connect on a
lane that submits — `promote`, or `production submit:true` — and an upload-only
`production` run still leaves the three questions for the manual submit. The same
is true of `build_number`: `promote submit:false` resolves and validates a build
but attaches nothing, because `select_build` is only called from the submission
path.

Three further consequences of that decision:

1. **`promote` never compiles anything**, so the desktop fossil rule
   ([ADR-0027](./0027-desktop-react-version-locked-to-react-native-macos.md),
   `docs/operations/desktop-build-fossil.md`) does not apply to it: `mac promote`
   is safe from any checkout with the Ruby gems installed. This is stated in the
   lane's own `desc` and enforced by a test that fails if a build step
   (`build_mac_app`, CocoaPods, Metro, `gym`, Gradle) ever appears in a promote
   lane body.
2. **No "now live" notice on an App Store destination.** `comment_released_issues`
   and `comment_intest_build` now run only for TestFlight. The notice the
   customer already received when the build reached TestFlight is the honest one;
   the next truthful moment is approval + Release This Version, which no lane
   observes.
3. **The rebuild lanes stay** as the hotfix path, with the same explicit
   platform/version and submission answers, and accept `submit:true`.

**The factory must never invoke `promote`.** `PROD_DENYLIST` gains
`/release:promote\b/i` and `/fastlane\s+\w+\s+promote\b/i`, tested against all
four spellings. Phase-D auto-dispatch stays beta-only; putting the app in front
of App Review remains a human act, consistent with CLAUDE.md "Release
Authorization".

## Consequences

- **Positive**: the binary Apple reviews is byte-for-byte the one testers
  approved. macOS submission no longer requires a build at all, removing the
  fossil-checkout constraint and the React-19.2 crash risk from the release
  step. A submitting lane answers the IDFA / encryption / content-rights
  questionnaire itself, so the submission does not stall on it.
  Customers are never told an update is live before it is. The factory cannot
  submit to App Review even by accident.
- **Negative**: `promote` submits _whatever is in App Store Connect_, so the
  operator must know which build that is — hence the version-scoped default, the
  hard `UI.user_error!` when no build exists, and the refusal to submit a build
  that is not yet `VALID`. The processing-state check reaches for
  `Spaceship::ConnectAPI` directly, which is a slightly less stable surface than
  a fastlane action; a lookup failure therefore only warns, and only a
  definitive non-`VALID` answer blocks. Store metadata and screenshots stay
  manual (`skip_metadata` / `skip_screenshots`), so the version page is whatever
  App Store Connect holds — `fastlane deliver` metadata directories and
  `snapshot` are a possible follow-up.
- **Neutral**: two lanes per Apple platform instead of one, and the two Fastfiles
  each carry their own copy of the helpers (`option_bool`,
  `resolve_promote_build_number`, `assert_build_processed`). They have always
  duplicated helpers rather than sharing a library; the mirror is asserted by
  tests in `scripts/__tests__/post-release-notes-select.test.mjs`.

## Alternatives Considered

- **Keep only the rebuild lanes and submit from App Store Connect by hand.**
  Rejected: it leaves the IDFA / export-compliance answers manual on every
  submission, still ships a binary nobody tested, and still needs a fossil
  desktop build to produce that binary.
- **Add `submit_for_review: true` to the existing `production` lanes.** Rejected
  for the same reason — the problem is _which_ binary is reviewed, not whether
  the lane presses submit.
- **Manage store metadata and screenshots as code** (`deliver` metadata
  directories + `snapshot`). Attractive, but screenshot generation needs booted
  simulators signed into a production account, and it is orthogonal to getting
  the submission path right. Deferred to its own issue.
- **Let the factory dispatch `promote` at Phase D once a card is Approved.**
  Rejected outright. Approval on the kanban board means "merge and ship a beta";
  a public App Store submission is a different, irreversible-in-practice act
  (Apple keeps rejection history, and an approved build can be released to
  everyone). It stays a human decision — which is why the guard is a code
  invariant with tests, not a convention.
