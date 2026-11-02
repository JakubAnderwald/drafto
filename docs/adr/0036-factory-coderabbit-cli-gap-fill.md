# 0036 — Factory CodeRabbit CLI Gap-Fill Review Lane

- **Status**: Accepted
- **Date**: 2026-09-12
- **Authors**: Jakub Anderwald

## Context

[ADR-0035](./0035-factory-code-review-gate.md) made review threads the merge gate
and, for the first time, brought CodeRabbit's inline findings into the factory's
fix loop. But CodeRabbit is only an adversarial reader when it actually reviews,
and on this repo it frequently doesn't.

`JakubAnderwald/drafto` is a **public** repo with 14 stars, so CodeRabbit serves
it on the free **OSS** tier. Per the vendor's
[rate-limit table](https://docs.coderabbit.ai/management/plans#rate-limits), OSS
PR reviews are allowed **1–10 per developer per hour, scaled by star count** — at
14 stars we sit near the bottom — and that pool is shared with every interactive
PR the same developer opens. The observed gaps:

- **Rate limiting.** PR #627 got "Review limit reached … You've used all free OSS
  reviews for now". ADR-0035 sampled 34 PRs; 10 were rate-limited.
- **The star threshold.** PRs #610–#620 got "This repository does not receive
  automatic reviews because it has fewer than 10 stars".
- **Auto-pause.** `.coderabbit.yaml` sets `auto_pause_after_reviewed_commits: 2`
  (to stop the `--watch` fix loop draining the hourly allowance on one PR), so
  every fix commit after the second goes unreviewed.

The **CodeRabbit CLI** has its own allowance: **3 reviews per developer per
hour**, listed separately from PR reviews, on both OSS and Free. It reviews a
local git diff, so it can run on the Mac mini with zero Claude tokens.

A spike on the Mac mini (CLI 0.7.6, Free plan, no seat assigned, usage billing
inactive) established the facts this design depends on:

- **Quality.** A review of PR #621 at `0b5bfe5` (32 files, +3.5k lines) took
  **7.5 minutes** and produced 8 findings: 1 major, 2 minor, 5 trivial. The PR bot
  had posted 8 inline findings on the same commit: 4 major, 2 minor, 1 trivial,
  1 security. Overlap was about **3 of 8**. The CLI is a lighter reviewer — it
  missed 3 of the 4 majors and has no security review — but it found a real major
  (an `@/` alias violation) and a plausible real bug the bot did not.
- **Separate allowance.** `coderabbit usage` reported the same "Your reviews"
  count before and after, so a CLI run does not consume the PR-review allowance.
- **Rate limit shape.** The fourth run inside an hour exited 1 with an
  `{"type":"error","errorType":"rate_limit",…,"metadata":{"waitTime":"50 minutes",…}}`
  event ("You've used all 3 included reviews").
- **No concurrency.** Two CLI runs started together: one failed with
  `errorType:"connection"` ("WebSocket subscription completed unexpectedly").
- **Auth is a file** (`~/.coderabbit/auth.json`, 0600), not the Keychain, so it
  works from a launchd job and under a stripped `env -i` environment.
- **Findings carry no line field.** The line only appears in prose
  ("In @path at line 1, …", "around lines 204 - 211, …").
- **The commit status is not a coverage signal.** The `CodeRabbit` status read
  SUCCESS on #627, which was rate-limited. The bot's own comments are the signal:
  a non-empty review body saying `between <base> and <head>`, or its edited-in-place
  summary comment carrying that range with no `rate limited` / `skip review` /
  `review in progress` marker. (The rate-limited summary on #627 still names the
  head in its `between` range, so markers must win. Empty-body bot reviews on a
  head are thread replies, not reviews, so `commit_id` is not a signal either.)

One operational finding from the rollout: `brew install coderabbit` upgraded
Homebrew's `node` from 23 to 26 as a side effect. Node 25+ no longer bundles
corepack, so `/opt/homebrew/bin/pnpm` became a dangling symlink — which would have
failed the factory's next `pnpm install`. The fix was
`npm i -g corepack && corepack enable pnpm` (after removing the dangling
`pnpm`/`pnpx`/`yarn`/`yarnpkg` links).

## Decision

**When the CodeRabbit PR bot did not review a factory PR's head commit, the
factory reviews it with the CodeRabbit CLI instead, and posts the findings as
review threads that the ADR-0035 fix loop answers.**

- **Gap-fill only.** The CLI runs for a head SHA only when the bot did not cover
  it (rate-limited, skipped, paused, or still absent after a grace period). It
  uses the same engine as the bot, so running it on a covered SHA would only
  duplicate threads.
- **Bounded wait.** On a converged In Review card (CI green, Claude review done,
  no open threads) the card holds while the bot is in progress or within its
  grace period, and while a CLI run for that SHA is in flight. The hold is capped
  per head SHA (`FACTORY_CR_HOLD_MAX_MIN`, plus the CLI timeout). The hold on a
  card's own in-flight run has a bound of its own, 80 minutes past the run's
  deadline (overdue grace + posting give-up + slack), so a housekeeping that
  never manages to finish the run cannot hold the card forever. After the cap
  the card is promoted anyway, and the In Test hand-off says "CodeRabbit did not
  review `<sha>` (…)". That note travels as its own field (`crCoverageNote`),
  never inside the advisory-checks text, and the In Test sweep rebuilds it from
  the recorded coverage when it re-writes a scenario for the same head. The lane
  fails open: if it errors, the card promotes with "CodeRabbit coverage of
  `<sha>` unknown (lane error)".
- **Asynchronous.** A review takes 7–30+ minutes and the tick loop is
  sequential, so the CLI runs under a **detached supervisor** process in its own
  detached git worktree (never the factory checkout, which is hard-reset every
  tick, and never the card worktree, which the fix loop edits). The supervisor
  gives the CLI an **allowlisted environment** (no `GH_TOKEN`, no support
  secrets), enforces a timeout, and writes its result to a run directory. It never
  touches git or `factory-state.json`; a later tick collects the result. A run
  whose PR head moves on (or whose PR closes) while it is still going is
  terminated by the next tick: its result could only be a stale summary, and it
  would hold the lane's single slot from the new head. Its hourly slot stays
  spent; its card's run is refunded. A worktree is never reaped while its
  supervisor is still alive, and `factory:cr-cli-finish` stops the supervisor
  before releasing the slot, so an operator release cannot leave a review
  running on a deleted tree.
- **Budget.** A global rolling ledger in `factory-state.json` allows at most
  `FACTORY_CR_CLI_MAX_PER_HOUR` (3) runs per hour and **one run in flight**. A
  vendor rate-limit error sets a **lane-only** pause until its `waitTime` — it
  never uses `factory:pause-until`, which would stop the whole factory. A lane
  pause holds a converged card only when the lane set it itself (`rate_limited`
  or `action_required`) and it ends inside the hold window; a longer one
  promotes with coverage `budget`. Any other pause (`auth`, `doctor`, an
  operator's) promotes at once as `cli-unavailable`: nothing is going to lift it
  in time, so waiting would only delay the card.
- **No Claude call to post.** Findings become review threads deterministically.
  Full reviews thread critical/major/minor findings; incremental reviews thread
  only critical/major. Everything else, and anything outside the PR diff or near
  an existing thread, goes into one summary comment marked
  `<!-- drafto-factory-cr-cli sha=<sha> -->`. A fingerprint marker per finding
  makes posting idempotent; the fingerprint ignores the finding's location
  phrase, and an earlier comment only answers a finding within 20 lines of it, so
  the same wording at another spot is still raised.
  - **A summary line is not a thread.** A thread-worthy finding that only reaches
    the summary (past the thread cap, or a comment GitHub rejects twice) records
    coverage `cli-partial`, which carries an In Test note: the fix loop reads
    threads, not the summary.
  - **Only trusted comments count.** Fingerprint de-duplication and the
    proximity check read only the owner's and the CodeRabbit bot's comments,
    and the summary counts as already posted only if the owner wrote it, so a
    public commenter cannot suppress a finding by pasting a marker.
  - **Proximity is narrow.** "Near an existing thread" means within 3 lines of a
    trusted comment in a thread that is unresolved and not outdated, at the
    thread's current line. A resolved or outdated thread from an older commit,
    or one this run already posted, never demotes a finding, and a critical
    finding is never demoted for proximity.
  - **Posting is bounded.** A failed post is retried each tick; when GitHub
    won't serve the diff (it refuses past 20,000 lines or 300 files), the
    threads open at file level, which needs no hunk. Seventy minutes past the
    run's deadline (overdue grace plus an hour) the lane gives up, records
    `cli-failed` and frees the slot, so a failing post cannot hold a card or the
    lane forever.
- **Review results are read strictly.** Only a completed review, or a skip
  because there were no changes, counts as reviewed. A failed review, or a skip
  for any other reason (too many files, an unsupported diff), records
  `cli-failed` whatever the exit code, so the tester is told.
- **Incremental base.** A re-review diffs from the nearest ancestor CodeRabbit
  already covered (by bot or CLI), falling back to the merge-base with `main`
  when there is none or the range contains a merge. Findings the fix loop already
  answered are not re-raised by every new commit.
- **Churn bound.** At most `FACTORY_CR_CLI_MAX_RUNS_PER_CARD` (2) CLI runs per In
  Review stint. A fix pass whose open threads are **all** CLI findings gets one
  free pass per CLI run instead of spending a retry attempt, so CLI rounds cannot
  exhaust `FACTORY_MAX_ATTEMPTS` on their own.
- **Never paid overage.** `--use-credits` is never passed, enforced by a test
  that scans `scripts/`, and the supervisor re-checks the command it is about to
  spawn (read back from the run's `meta.json`). An `action_required` (on-demand
  billing) result is treated as an exhausted budget.
- **Vendor text is sanitised** before it is posted under the owner's identity:
  HTML comments stripped (so factory markers can't be forged), `@mentions`
  neutralised, ` ```suggestion ` fences turned into inert ` ```diff `, length
  capped, and a disclaimer marks each thread as an automated, unverified vendor
  finding. The watcher prompt lists `<review-comment>` as data, not instructions.
- **Off by default.** `FACTORY_CR_CLI=0` ships dark; the operator flips it in the
  launchd plist after a dry run. A dry run saves nothing, so the bot grace clock
  restarts every tick and it can only report a `start` for a commit the bot
  marked rate-limited, skipped or paused. A missing binary or failed
  `coderabbit doctor` disables the lane and promotes the card with a note in the
  same tick — the lane never blocks.
- **The switch is also the kill switch.** Setting `FACTORY_CR_CLI` back to `0`
  stops the gate holding cards, and housekeeping (which keeps running)
  terminates an in-flight run and discards its results instead of posting them.
  Posting after the card has left In Review would produce exactly the late
  threads the hold exists to avoid (see "Don't wait" below).

## Consequences

- **Positive**: factory commits the bot skipped — the majority of fix commits,
  and whole PRs during rate-limit windows — get a CodeRabbit review for no money
  and no Claude tokens. The fix loop, the thread gate and `--release` are
  unchanged; CLI findings are just more threads. The In Test hand-off tells the
  tester which commits the lane promoted without a review and why, instead of
  that being invisible.
- **Negative**:
  - Each converged head commit can normally hold the card in In Review for up
    to about **105 minutes** (`FACTORY_CR_HOLD_MAX_MIN` 60 +
    `FACTORY_CR_CLI_TIMEOUT_MIN` 45), and up to 80 minutes past the run's
    deadline (~185 minutes) if collecting the run keeps failing. The clock
    restarts on every fix commit, so a card that goes through two CLI rounds can
    sit in In Review for 3–4 hours, plus the bot grace on any later commit.
  - The coverage note comes only from the lane's promotion decision (or the
    coverage it recorded for that same head). A commit pushed while the card is
    already In Test gets no note, and a fail-open "lane error" note is not
    recorded, so a re-written scenario cannot repeat it.
  - The CLI is lighter than the bot: on the spike it missed most of the bot's
    majors and has no security review. It fills gaps; it does not replace the bot.
  - Vendor text appears on a public PR under the owner's GitHub identity,
    mitigated by the header, disclaimer and sanitising.
  - The 3/hr CLI allowance is shared with interactive CLI use by the same
    developer, which the ledger cannot see; the vendor's rate-limit error remains
    the real signal.
  - Each CLI finding thread still costs a Claude fix pass in `--watch`.
- **Neutral**: `factory-state.json` gains a top-level `crCli` ledger and per-issue
  `cr*` fields (which forced a fix to `mergeWithDefaults`, which previously
  dropped every unknown top-level key on write). CLI run artefacts live under
  `logs/factory/cr-cli/<runId>/` and are reaped after 30 days by the lane's own
  housekeeping (every `--watch` tick) — the single retention rule for them.

## Alternatives Considered

**Run the CLI on every head SHA.** Maximum coverage, but the CLI uses the bot's
engine, so a covered SHA would get near-certain duplicate threads, each costing a
fix pass and, before the free-pass rule, a retry attempt. Rejected in favour of
gap-fill.

**Run the CLI pre-PR inside `--implement`.** The single bot review would see
cleaner code. But there is no PR to hang threads on, so findings would have to be
fed back into the implement prompt (more Claude tokens, bypassing the thread
gate), and nothing would cover the `--watch` fix commits — which is where most of
the gaps are.

**Don't wait; promote and let late threads bounce.** Simpler (no hold clock), but
`--release` would move the card back to In Review after a human has already
tested and approved it, costing a re-approval — and the tester would be testing
code about to change.

**Upgrade to a paid CodeRabbit plan.** Essentials is $24/developer/month (billed
annually) and raises PR reviews to 5/hr. Rejected under the cost-discipline rule
in `CLAUDE.md`: the gap can be filled with an allowance we already have.

**Run the CLI synchronously inside the tick.** `factory-agent-loop.sh` runs
`--plan`, `--implement`, `--watch`, `--release` sequentially under one mutex, so a
7–30 minute review would stall every other card and every merge. Rejected for the
detached supervisor.

**Use `coderabbit pullrequest` as the coverage signal.** It only returns the
consolidated prompt for AI agents (and an error when there is none), with no
information about which commit was reviewed. Rejected for parsing the bot's own
review bodies and summary comment over REST, filtered to the bot account.
