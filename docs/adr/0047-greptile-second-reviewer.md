# 0047 — Greptile as a Second PR Reviewer (Free OSS Plan)

- **Status**: Accepted
- **Date**: 2026-10-12
- **Authors**: Jakub Anderwald

## Context

[ADR-0035](./0035-factory-code-review-gate.md) made review threads the merge gate,
and [ADR-0036](./0036-factory-coderabbit-cli-gap-fill.md) filled the commits
CodeRabbit's PR bot skips with the CodeRabbit CLI. Apart from the factory's own
Claude review, both lean on one vendor, and that vendor's free OSS bot often does
not review at all:

- **Rate limits.** OSS PR reviews are capped at 1–10 per developer per hour,
  scaled by stars; ADR-0035 sampled 34 PRs and 10 were rate-limited.
- **Auto-pause.** `.coderabbit.yaml` sets `auto_pause_after_reviewed_commits: 2`,
  so every fix commit after the second goes unreviewed by the bot.
- **The star threshold.** Under 10 stars the bot skips the repository outright
  ("does not receive automatic reviews"), as it did for PRs #610–#620 while the
  repository sat under the threshold.

The CLI lane narrows those gaps but cannot close them (a 3/hr allowance, a hold
cap, a per-card run cap), and it runs the same engine as the bot. The factory's
own review stage is Claude reading code Claude wrote. ADR-0036's spike found the
CLI and the bot agreed on only about 3 of 8 findings on the same commit, so even
two passes of one vendor see different things. A reviewer built on a different
model and a different index of the repository would catch different things again.

**Greptile** is an AI code reviewer that runs as a GitHub App: it indexes the
repository, then posts a PR summary comment and inline review comments. Greptile
offers a free plan for open-source projects, by application. The paid plan (Pro)
is $30 per seat per month plus $1 per review beyond its included allowance.

The forces:

- **Cost discipline.** `CLAUDE.md` requires free or already-paid tiers. Drafto is
  GPL-3.0 and its repository is public, which is what the OSS plan is for.
- **Volume.** About 15–25 PRs a month, roughly a third of them Dependabot. With
  Dependabot excluded and one review per PR, that is about 10–17 reviews a month.
  Every completed review counts against the plan, re-reviews included.
- **Scope (issue #647).** Its "Out of scope" rules out making Greptile a
  required status check.

## Decision

**Greptile reviews drafto PRs as a second, optional reviewer: once per PR, on the
free OSS plan only, through its GitHub App and a committed `greptile.json`. Its
findings are ordinary review threads, and the factory waits a bounded time for
its review but never requires it.**

- **Free OSS plan only.** The Greptile account has no payment method, so nothing
  can bill. Upgrading to Pro, or any paid plan, needs explicit sign-off from the
  user. If the OSS application is rejected, or the plan lapses, stop and report;
  there is no fallback to Pro.
- **Operator prerequisite, not factory work.** The operator applies to the OSS
  program. Only once the plan is confirmed does the operator install the Greptile
  GitHub App, on `JakubAnderwald/drafto` only (not "All repositories"). Until
  then `greptile.json` is inert and the factory's hold is off.
- **No workflow and no key.** There is no GitHub Actions workflow and no Greptile
  API key: the App does the reviewing, `greptile.json` at the repo root
  configures it. Nothing new goes into repository secrets or the launchd plist
  beyond two optional knobs.
- **What Greptile receives.** The App indexes the whole public repository and
  reads PR diffs, titles, descriptions, review threads and comments. All of it is
  already public on GitHub. No app-user data (notes, accounts) and no secrets:
  the env files are gitignored, and nothing is sent from the Mac mini.
- **The repo config** (`greptile.json`):
  - **Review on PR open only.** `triggerOnUpdates: false`, so the `--watch` fix
    pushes do not spend reviews. A re-review happens only when someone comments
    `@greptileai` on the PR, which the factory never posts.
  - **Skip Dependabot.** `excludeAuthors: ["dependabot[bot]"]`. Dependency bumps
    are a third of the volume and the least likely to benefit.
  - **No commit status.** `statusCheck: false`, so nothing can be made a required
    context by accident, and no Greptile status shows up in the In Test
    advisory-checks list.
  - **Ignore what nobody reviews by hand.** `ignorePatterns` covers lockfiles,
    native project and build directories, and generated paths.
  - **Logic and syntax comments only.** `commentTypes: ["logic", "syntax"]`;
    Prettier and ESLint own style.
  - **House rules as context.** `customContext` points at `CLAUDE.md`,
    `docs/features/design-system.md` and `apps/desktop/CLAUDE.md`, and states the
    SOLID rule, the design-token rule and the `apps/mobile/src/db/` ↔
    `apps/desktop/src/db/` mirror rule.
  - The keys are pinned by `scripts/__tests__/greptile-config.test.mjs`.
- **Threads need no factory change.** A Greptile inline comment is a review
  thread like any other. `fetch_review_threads()` reads every unresolved thread
  whatever its author, so the ADR-0035 fix loop answers and resolves Greptile's
  threads, and `--release` refuses to merge while one is open
  (`required_conversation_resolution`).
- **A bounded hold in `--watch`.** `greptile_gate` runs on a converged In Review
  card right after the CodeRabbit lane's `cr_lane_gate`, only with
  `FACTORY_GREPTILE_GATE=1` (default `0`). It holds the card until Greptile has
  reviewed the PR, for at most `FACTORY_GREPTILE_HOLD_MAX_MIN` (default 30,
  valid 1..1440, anything else falls back to 30), so its threads reach the fix
  loop before a tester sees the card.
  - **One review per PR, not per commit.** Fix commits never get one, so waiting
    per head SHA would only ever expire.
  - **Counted from when the PR opened** (`created_at`), not from convergence. It
    runs alongside the CodeRabbit hold rather than after it, and a revision round
    long after the PR opened never waits again.
  - **Reviewed** means a submitted, non-pending review with a body from the App,
    or an App issue comment carrying the "Greptile Summary" / "Greptile Overview"
    heading.
  - **Stateless.** `scripts/lib/greptile-gate.mjs` reads the PR, its reviews and
    its issue comments over REST, plus the clock. It never reads or writes
    `logs/factory-state.json`. The decisions are pure, in
    `scripts/lib/greptile-review.mjs`.
  - **Fails open.** A crash or unusable output promotes with "Greptile review
    status of PR #N unknown (gate error)". Reviews that cannot be read hold inside
    the window, then promote with "… unknown (its reviews could not be read)". A
    missing or garbage PR opening time promotes at once rather than holding
    without a bound. A dry run never holds.
  - **Threads re-read before promoting on a review.** The tick reads the open
    threads early; a Greptile review can land in the seconds before the gate's
    own read. Before promoting on `greptile-reviewed`, the gate reads the threads
    once more and holds for the fix loop if any are open. A failed re-read
    promotes (fail open).
  - **The In Test note.** A card promoted without a Greptile review carries
    "Greptile did not review PR #N (no review within M min of the PR opening)".
    It travels as its own bundle field, `greptileNote`, and its own ℹ️ line in the
    fallback comment, never inside the advisory-checks text. When the In Test
    sweep re-writes a scenario, the note is rebuilt live by asking GitHub again,
    so a review that landed since clears it; one still absent inside the window
    reads "Greptile has not reviewed PR #N yet".
- **Only the App releases the hold.** GraphQL reports a bot's login without the
  `[bot]` suffix, so `greptile-apps` there could be an ordinary user account. The
  gate trusts only a REST user of type `Bot` named `greptile-apps[bot]`, the same
  rule `coderabbit-review.mjs` applies to CodeRabbit.
- **Not a required check.** A required context would hard-block every PR
  Greptile skips: every Dependabot PR (excluded by config), every PR after the
  quota runs out, and every PR while the plan is not active or the App is not
  installed. The hold gives the same "wait for the review" benefit with a bound
  on it.
- **Not CodeRabbit coverage.** `classifyBotCoverage`, `runCoverage` and the CLI
  lane's free pass stay CodeRabbit-only. A Greptile review never stops the CLI
  lane reviewing a commit the bot skipped, and a fix pass driven by Greptile
  threads spends a normal attempt (`FACTORY_MAX_ATTEMPTS`).
- **Privacy.** Judged not to trigger the Privacy Policy Maintenance rule in
  `CLAUDE.md`: Greptile receives only public repository content, the same footing
  as CodeRabbit, which is not a listed processor either. The one edge is
  `support`-labelled PRs, which link issues quoting reporters' messages; those
  issues are already public on GitHub, and the policy already names GitHub for
  them. If that reading changes (the repository goes private, Greptile is pointed
  at non-public data, or support PRs start carrying anything not already public),
  add Greptile to the processor table in `apps/web/src/app/privacy/page.tsx` and
  `docs/features/privacy-policy.md` in the same PR, which means the card is no
  longer infra-only.
- **Off by default, and the switch is the kill switch.** `FACTORY_GREPTILE_GATE=0`
  stops the wait at once and leaves nothing to clean up. Stopping the reviews
  themselves means removing the repository from the App's installation or pausing
  reviews in the Greptile dashboard. Deleting `greptile.json` does not stop them:
  Greptile falls back to its defaults, which review Dependabot PRs and every push.

## Consequences

- **Positive**: every non-Dependabot PR, factory or hand-made, gets a second
  review from an independent model for no money and no Claude tokens, including
  PRs the CodeRabbit bot rate-limited or skipped. The fix loop, the thread gate
  and `--release` are unchanged; Greptile's findings are just more threads. When
  Greptile is silent, the In Test hand-off says so instead of that being
  invisible.
- **Negative**:
  - A thread Greptile posts after the card reached In Test (a review slower than
    the hold window, the gate off, or a summary comment that lands ahead of its
    inline review) makes `--release` refuse the merge and move an Approved card
    back to In Review: one extra round trip and a re-approval.
  - CodeRabbit, the CodeRabbit CLI, Greptile and the factory's Claude review can
    raise the same finding; each duplicate costs another reply and resolve, and
    possibly a fix pass.
  - Each Greptile-driven fix pass spends a retry attempt, so a noisy review can
    push a card towards `FACTORY_MAX_ATTEMPTS` and Blocked.
  - With the gate on, a card that converges quickly can wait up to
    `FACTORY_GREPTILE_HOLD_MAX_MIN` (30 min) from the PR opening. A card whose CI
    and Claude review take longer than that has an expired window by the time it
    converges and does not wait at all; either way the hold overlaps the
    CodeRabbit one rather than adding to it.
  - Greptile's PR summary is a conversation comment. Like CodeRabbit's walkthrough
    it cannot be resolved, so it reaches every fix pass as context. It cannot
    start a fix pass on its own.
  - The `greptile.json` keys were written from Greptile's documented schema and
    are pinned by `scripts/__tests__/greptile-config.test.mjs`, but the test can
    only pin what we wrote: a misnamed key is silently ignored by Greptile. Verify
    them against docs.greptile.com at go-live.
  - Two vendors' review quality and quotas to keep an eye on instead of one.
- **Neutral**: go-live is an operator sequence, not a merge:
  1. the OSS plan is confirmed;
  2. the App is installed on this repository;
  3. `node scripts/lib/greptile-gate.mjs gate --pr <n>` reports
     `greptile-reviewed` on a PR Greptile actually reviewed;
  4. only then is `FACTORY_GREPTILE_GATE=1` set in
     `~/Library/LaunchAgents/eu.drafto.factory.plist` and the job reloaded.

  Nothing new is stored in `factory-state.json`.

## Alternatives Considered

**CodeRabbit only (the status quo).** No new vendor and nothing to configure.
Rejected: a single vendor whose free bot frequently skips commits, with the CLI
lane as the only backstop, and that backstop runs the same engine.

**Greptile Pro.** $30 per seat per month plus $1 per review beyond the included
allowance; no application and no OSS-plan risk. Rejected on cost: the repository
runs on free tiers, and the OSS plan covers it.

**A required status check.** Strongest guarantee that Greptile reviewed every
PR. Rejected: it hard-blocks every PR Greptile skips (Dependabot, an exhausted
quota, a lapsed plan or an uninstalled App), and the issue's "Out of scope" rules
it out. The bounded hold gets the useful part.

**A GitHub Actions workflow calling the Greptile API.** Rejected: out of scope,
it needs an API key stored as a secret in a public repository whose autonomous
agent writes workflow files, and the App already does the reviewing.

**Counting Greptile as review coverage.** It would let a Greptile review stand in
for a CodeRabbit one and spare the CLI lane a run. Rejected: coverage is the
signal the CLI lane uses to decide whether CodeRabbit read a commit, and Greptile
reviews only the PR's first commit, so it cannot say anything about the fix
commits the lane exists for. Keeping the two apart also keeps the CLI free pass
from being granted to findings it was not designed for.
