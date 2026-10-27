# Dark factory

**Status:** rolling out (Phase B engine + `--release` auto-merge built; runtime phase set on the plist) **Updated:** 2026-10-21

## What it is

A "vibe-kanban-style" pipeline where moving a card on a GitHub Projects v2 board triggers Claude-driven implementation, deploys the result to a beta channel, and waits for explicit human approval before firing production releases. Built on the existing Mac mini, free GitHub, free Vercel — no new paid services. See [ADR-0026](../adr/0026-dark-factory-pipeline.md) for the decision; the original proposal is [`docs/dark-factory-proposal.md`](../dark-factory-proposal.md).

## Current state

The runtime phase is set by `FACTORY_PHASE` on the launchd plist (see the runbook). The phases:

- **Phase A (Plan-only).** `--plan` watches `status:ready` issues, posts a structured plan comment, and stops at `status:plan-review`. `--implement` posts a one-time "implementation skipped" stub; `--watch` / `--release` are no-ops.
- **Phase B (Web-only, staged).** Approving a plan (drag Plan Review → In Progress) runs the real engine: `--implement` takes a worktree slot, implements the approved plan in `worktrees/factory-issue-<n>`, opens a PR, and runs the parity post-check (mobile/desktop changes are auto-blocked — Phase B is web-only). `--watch` then drives the PR: it runs a `/push`-style fix loop on failing CI **and/or unresolved review threads**, and once CI is green it runs a **code review** of the PR (once per commit) before advancing. Findings are posted as inline review threads; the fix loop picks them up next tick, answers each one and resolves it. Only when CI is green, every thread is resolved and the Vercel preview is reachable does the card advance to **In Test** with the preview URL. See [ADR-0035](../adr/0035-factory-code-review-gate.md). When CodeRabbit's PR bot didn't review the head commit (rate-limited, auto-paused, or skipped), an opt-in **CodeRabbit CLI gap-fill lane** (`FACTORY_CR_CLI=1`) reviews it on the Mac mini instead and posts its findings as threads for the same fix loop; the card holds in In Review while that runs, for a bounded time. A PR opened by hand has no card; `/merge` reviews its head with the same CLI via `coderabbit-cli.mjs review`, which shares the lane's run log ([ADR-0037](../adr/0037-manual-coderabbit-cli-review.md)). See [ADR-0036](../adr/0036-factory-coderabbit-cli-gap-fill.md). **In Test iteration:** while a card sits in In Test, commenting on the issue with a change request rolls it back to **In Progress**; the factory revises on the **same** PR branch (reusing the slot, worktree, and preview URL) and it flows back to In Test. Repeat until you're happy. A pure "thanks/looks good" comment is treated as noise (no rework); approval stays explicit — drag to **Approved** (or, household, reply "ship it"). **`--release` then auto-merges on Approved:** the Approved drag is the merge authorisation — the factory squash-merges the green PR via the GitHub API, advances the card to **Released**, and Vercel deploys main → prod. It refuses to merge a PR touching `supabase/migrations/**` until `migration-approved` is on the PR, and won't merge unless CI is green and conflict-free. Hard holds (missing migration approval, conflicts, a failed merge) leave the card in Approved **and post a one-time comment**; transient waits (CI still running, mergeability still computing) leave it in Approved silently and retry next tick. Required checks that GitHub **cancelled before any runner picked them up** aren't treated as a verdict. The factory re-runs them, up to `FACTORY_CI_RERUN_MAX` times per commit; this also applies in `--watch`, where re-runs never spend a fix attempt. Only after that does it comment once and hold the card. A **genuinely red** required check posts a one-time comment and moves the card back to **In Review** for the fix loop. It then returns to In Test for your approval (see [ADR-0041](../adr/0041-factory-ci-red-and-cancelled-checks.md) and the runbook's "Red or cancelled CI on a factory PR"). Just before merging it **verifies** every review thread (CodeRabbit / the factory's own review / yours) is resolved — it never clears one unread. An open thread refuses the merge and moves the card back to **In Review** so the fix loop can answer it; it then returns to In Test for your approval. Beta-channel dispatch (iOS/Android/macOS) stays a Phase D concern. `--release` skips `support`-labelled issues entirely: `nightly-support.sh` merges those itself and ships their betas in its Phase 4, through the same beta build roots and root lock (`scripts/lib/beta-build-root.sh`, [ADR-0042](../adr/0042-nightly-support-runner-owns-beta-dispatch.md)). Promote per phase only after ≥5 clean runs without human intervention.

**Browser checks.** The factory can drive Chrome on the Mac mini through Claude in Chrome, but only from one locked-down **browser runner**. That's a `claude -p --chrome` session in `dontAsk` mode with no built-in tools (no Bash, no files, no `gh`). A guard hook pins this Mac mini's browser and keeps the session to its own tabs and to the run's exact preview origin. The runner prints a report; bash scans it for secrets and posts it. Every other claude call passes `--no-chrome`, and every factory, support and nightly call passes `--strict-mcp-config`, so none of the operator's claude.ai connectors (Gmail, Drive, …) load in an unattended session. It has two uses: the **In Test web run** (below) and, with verification on, the Testing column's **browser lane**, which runs the same steps before In Test and puts its result in the verification report instead of a comment of its own. It is on by default (`FACTORY_BROWSER=0` turns it off) and drives the operator's own signed-in Chrome profile, a deliberate tradeoff recorded in [ADR-0051](../adr/0051-factory-browser-runner.md). Knobs, setup and triage are in the runbook's "Browser runner (Claude in Chrome)".

**Verification before In Test (off by default).** With `FACTORY_VERIFY=1`, a converged card stops in a factory-owned **Testing** column before In Test. The factory writes the test scenario and dispatches the betas there, runs its own verification lanes, and then moves the card to In Test with one **verification report** comment. The report is evidence, not a gate: a FAIL doesn't hold the card, and the hold cap (`FACTORY_VERIFY_HOLD_MAX_MIN`, 60 min by default) bounds the stay. The card only goes back to In Review for something wrong with the commit itself: the head moved, required CI is red, the commit missed the code review, or review threads are open. Two lanes run there: the shell lane (targeted tests, command steps, API checks on the preview) and, on a web card, the browser lane (the browser runner's `verify` kind). Their results are the report's Repo & API and Web rows. A card with no lane result is promoted with an INCOMPLETE report that lists what to test by hand. See [factory-verification.md](./factory-verification.md) and [ADR-0053](../adr/0053-pre-in-test-verification-stage.md).

**Claude effort.** The two code-writing stages (`--implement`, `--watch`) invoke Claude at **ultracode** effort (xhigh reasoning + dynamic multi-agent workflow orchestration); the read-only planning stages (`--plan`, replan) run at **xhigh** to conserve the shared Claude subscription. Both are env knobs (`FACTORY_EFFORT`, `FACTORY_PLAN_EFFORT`) on the launchd plist, and ultracode degrades safely to plain xhigh if the Workflows feature is unavailable on the account. Because ultracode runs its work in background workflows, the factory lifts `claude -p`'s 600s background-task ceiling (`FACTORY_BG_WAIT_CEILING_MS`, default `0`) and relies on the per-stage wall caps instead. See [ADR-0029](../adr/0029-factory-ultracode-effort.md) and the runbook's "Claude effort & timeouts" knobs.

## The board

- **Owner**: `JakubAnderwald`
- **Title**: `Drafto Factory`
- **URL**: <https://github.com/users/JakubAnderwald/projects/1>

To re-bootstrap (e.g. after a deletion), run `scripts/setup-factory-board.sh`. It is idempotent and prints the URL on success. On a board that's already in use it keeps every existing option's id, so cards keep their Status. It refuses to delete an option unless you pass `--allow-drop`, and `--dry-run` previews the change. To add a column to the live board, follow the runbook's "Changing the board's Status options".

The board has one custom Status field with twelve values:

| Status      | Who sets it           | Meaning                                                                    |
| ----------- | --------------------- | -------------------------------------------------------------------------- |
| Backlog     | human                 | Filed, not yet specced. Factory ignores.                                   |
| Ready       | human                 | Spec complete; factory may **plan** (read-only).                           |
| Planning    | factory               | Claude is reading the issue and writing a plan.                            |
| Plan Review | factory               | Plan posted as a comment; awaiting human approval.                         |
| In Progress | human / allowlisted   | Plan approved; factory implements per the approved plan.                   |
| In Review   | factory               | PR open; factory monitors CI and review comments.                          |
| Testing     | factory               | Factory verifies the change before In Test (ADR-0053; `FACTORY_VERIFY=1`). |
| In Test     | factory               | Testable build + test scenario posted; awaiting human approval.            |
| Approved    | human / allowlisted   | Authorise prod release. Migration gate enforced.                           |
| Released    | factory               | PR merged; beta channels dispatched (Phase D).                             |
| Done        | human / support-agent | Final acceptance; issue closed.                                            |
| Blocked     | factory               | Spec incomplete, retry budget exhausted, parity violation, hard gate.      |

The factory agent reads the Status field directly via the GitHub GraphQL API on each 5-min tick. It also writes a matching `status:*` label as a transition side-effect (for filtering on the Issues list); the labels are observability, not the agent's queue.

## Label glossary

The full set is created idempotently by `scripts/setup-factory-labels.sh`. Reference:

| Label                 | Set by               | Meaning                                                              |
| --------------------- | -------------------- | -------------------------------------------------------------------- |
| `status:ready`        | human (via board)    | Spec accepted; factory may plan.                                     |
| `status:planning`     | factory              | Plan in progress.                                                    |
| `status:plan-review`  | factory              | Awaiting plan approval.                                              |
| `status:in-progress`  | human / factory      | Implementation in progress.                                          |
| `status:in-review`    | factory              | PR open, CI / review comments active.                                |
| `status:testing`      | factory              | Pre-In-Test verification running (ADR-0053).                         |
| `status:in-test`      | factory              | Testable build + scenario posted, awaiting ship approval.            |
| `status:approved`     | human / factory      | Approved for release; merge + dispatch authorised.                   |
| `status:released`     | factory              | Merged + beta dispatched.                                            |
| `status:done`         | human / support      | Final acceptance.                                                    |
| `status:blocked`      | factory              | Hard stop — see comment on issue.                                    |
| `factory-pause`       | operator             | Global kill switch on this issue (factory ignores).                  |
| `migration-approved`  | operator             | Authorises factory to merge a PR with `supabase/migrations` SQL.     |
| `factory-failure`     | factory failure trap | Filed by `cleanup()` on a run error, or by the toolchain check.      |
| `parity:web-only`     | operator             | Skip cross-platform parity check (legitimate web-only work).         |
| `parity:mobile-only`  | operator             | Skip cross-platform parity check (legitimate mobile-only work).      |
| `parity:desktop-only` | operator             | Skip cross-platform parity check (legitimate desktop-only work).     |
| `parity:infra-only`   | operator             | Skip parity check; change touches no app platform (scripts/docs/CI). |

## How to file an issue for the factory

Use the **Factory feature spec** template (`.github/ISSUE_TEMPLATE/factory-feature.yml`). It enforces the spec contract:

1. **What** — one paragraph user-facing description.
2. **Acceptance criteria** — bulleted, testable.
3. **Affected platforms** — checkboxes (web / iOS+Android / macOS), or **None** for a factory-internal / docs / CI change that touches no app platform.
4. **Schema changes?** — yes/no. If yes, the factory adds `needs-migration-review`.
5. **UI?** — screenshot / Figma URL if applicable.
6. **Out of scope** — explicit non-goals.

After filing, drag the card to **Ready** on the board. The factory picks it up on its next 5-min tick — it queries the board's Status field directly, then applies the `status:ready` label as a side-effect for filtering on the Issues list.

## Kill switches

- **Per-card**: drag the card to **Blocked**, or apply `factory-pause` to the issue. The factory ignores the card on the next tick.
- **Global**: run `node scripts/lib/state-cli.mjs factory:pause` on the Mac mini. The agent reads the flag every cycle and exits early when set. A manual pause never auto-expires; `factory:resume` to unpause. (Available once Wave 2 lands; until then, unload the launchd plist.)
- **Automatic (self-healing)**: when a claude call dies on a Claude subscription _session usage_ limit, the factory pauses itself until the limit resets (`factory:pause-until`) instead of burning the card's retry budget, then auto-resumes on the first tick past the deadline. See [factory-runbook.md → "Automatic pause on a Claude session limit"](../operations/factory-runbook.md#automatic-pause-on-a-claude-session-limit-self-healing).
- **Automatic toolchain pause (self-healing)**: every tick probes git / gh / claude on the Mac mini before running the modes. If one stays broken for two ticks (e.g. git refusing to run on an unaccepted Xcode license after an Xcode update), the factory pauses itself, emails the operator the exact fix and files one `factory-failure` issue, then resumes on its own once the probes pass. See [factory-runbook.md → "Automatic toolchain pause"](../operations/factory-runbook.md#automatic-toolchain-pause-self-healing).
- **Verification stage**: `FACTORY_VERIFY=0` in the plist (the default). Cards then go straight to In Test, and any card already in **Testing** is promoted on the next tick with a report that says verification was switched off. `FACTORY_VERIFY_ONLY_LABEL` limits the stage to cards carrying one label. Dragging a card out of Testing by hand works too; `factory-pause` on the issue freezes it where it is.
- **Emergency stop**: `launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist` on the Mac mini, or `kill` the active claude PID under `logs/factory.*.pid`.

## Troubleshooting

### "I dragged a card but the factory didn't pick it up"

1. The factory polls every 5 minutes; wait one tick. Confirm the launchd job is alive on the Mac mini: `launchctl list | grep eu.drafto.factory`. PID column `-` with exit `0` is normal between ticks; a non-zero exit means the last tick failed — check `logs/launchd-factory-stderr.log`.
2. Check the agent saw the card on its latest tick: `logs/launchd-factory-stdout.log` (or `logs/factory-plan-*.log`) should mention the board fetch. A `factory-project find-project failed` warning means the `gh` token on the Mac mini is missing the `project` scope — run `gh auth refresh -s project`.
3. If the tick ran and the card was in scope but ignored: check the issue for a `factory-pause` label, or `logs/factory-state.json` for a global `paused: true` flag, or the issue's retry budget under `issues[<n>].attempts`.
4. A card that _was_ picked up can still look idle during its first implement while dependencies install. The factory now seeds `node_modules` from the main checkout by clonefile and runs a fast offline reconcile (seconds — logged as `seeding node_modules (clonefile) + reconciling deps`); a multi-hour `pnpm install` was the old behavior (#451) and is no longer expected.

### "A card is stuck in Planning"

`Planning` is a transient, factory-owned status — a card should only sit there for the seconds a planner runs. If one is parked there across ticks, an earlier `--plan` tick died between moving the card to Planning and its follow-up transition (e.g. a launchd SIGTERM during the board write, which stranded #418, or a claude timeout). You don't need to do anything: the **rescue sweep** at the top of every `--plan` tick re-floats orphaned Planning cards automatically — if the plan comment was already posted it goes back to **Plan Review**, otherwise it returns to **Ready** to be re-planned (bounded by the `attempts` budget, so a card that keeps dying ends up **Blocked**). To recover immediately instead of waiting for the next tick, drag the card to **Plan Review** (plan comment present) or **Ready** (no plan comment) by hand.

### "The plan comment looks wrong / Claude misread the issue"

This is exactly what the Plan Review gate catches. Don't drag to In Progress. Two paths:

- **Tweak (preferred).** Comment on the issue with your correction — keep the rest of the plan intact. On the next 5-min tick the factory re-invokes the planner with your comment in the bundle and **edits the existing plan comment in place** (GitHub shows the "edited" badge; the comment ID stays stable). It also posts **one new 🏭 reply per comment you wrote**: it answers your questions, says what changed in the plan, or why it didn't follow a suggestion and what you'd change to get it (for example the issue's "Out of scope"). The edit alone sends no notification, which is how a question on #718 once went unanswered. Allowlisted reporters can do the same by replying to the planning email — `support-agent.sh`'s `--auto-classify` step 4.5 forwards the reply as a GitHub comment with `OWNER` association, which the factory detects identically.
- **Full restart.** If you want the factory to discard the plan and start fresh, delete the bot's `<!-- drafto-factory-plan -->` comment, then drag the card back to **Ready**. The next tick will plan from scratch.

How the in-place replan stays idempotent: after a successful replan, the edited plan body carries one `<!-- drafto-factory-replan-ack:<comment-id> -->` marker per trigger comment. The next tick only re-fires if there's a newer OWNER comment whose ID isn't in the ack set — a thank-you reply that produces `action=noop` still gets ack-stamped, so it doesn't loop. The planner only writes each reply to a file; the factory posts it with `<!-- drafto-factory-plan-reply-<comment-id> -->` appended. The detector skips the factory's own marker comments (it posts under your identity, so they're `OWNER` too), so a reply never starts another replan. If a handled comment has no reply after the run, the factory posts a short "no reply was posted to your comment" notice carrying that marker instead; if the replan ends in **Blocked**, every comment it was answering gets one.

### "PR opened but CI keeps failing"

The factory's `--watch` mode loops `/push`-style: it reads CI failures and review comments, re-invokes Claude to fix, re-pushes. Bounded by `factory.issues[<n>].attempts` in `logs/factory-state.json`. When the budget is exhausted the card moves to **Blocked** with a comment listing the unresolved items. Human must take over from there.

### What you get at In Test

When a card advances, the factory posts one comment (marker `<!-- drafto-factory-test-scenario -->`) containing:

1. **A manual test scenario**, written by Claude from the **actual PR diff** — numbered steps per touched platform, each with an expected result, opening with a reproduction of the original bug so the fix is observable, plus what failure would look like and what is only covered by unit tests.
2. **How to get a build**, per platform. The platforms come from the diff (not the issue's "Affected platforms" checkboxes, which can be stale), so a mobile-only PR never tells you to open a web preview:
   - **web** — the Vercel preview URL.
   - **iOS / Android / macOS** — a beta build dispatched from the PR head if pre-merge dispatch is on (see the runbook), otherwise the exact commands to run the branch locally.
3. Any **advisory** (non-required) red checks, for a glance before Approving.
4. When the CodeRabbit CLI lane is on and it promoted the commit without full CodeRabbit coverage, a note saying so ("CodeRabbit did not review `<sha>` (…)"), on its own line — it is not a check, and it travels to the scenario writer as its own bundle field (`crCoverageNote`), never inside the advisory list. If the lane itself errored, the card is promoted anyway and the note reads "CodeRabbit coverage of `<sha>` unknown (lane error)". When the scenario is re-written for the same head (e.g. the promoting tick died before posting it), the note is rebuilt from the recorded coverage; the lane-error note isn't recorded, so it can't be. A commit pushed while the card is already In Test gets no note.

On macOS the scenario can be run hands-off against the posted TestFlight build: see [macOS In-Test automation](../operations/macos-in-test-automation.md).

On web, with the browser runner on (the default: `FACTORY_BROWSER=1`, kinds `intest,verify`), the factory runs the scenario's `### Web` steps itself. It runs them in Chrome on the Mac mini, against the **per-commit** Vercel preview, signed in as a dedicated test account in the dev database. It then posts a second comment, **🏭 Browser run — web steps on the preview**, with a PASS / FAIL / WARN / SKIP row per step and the evidence for each (marker `<!-- drafto-factory-browser-report -->`). Screenshots stay on the Mac mini under `logs/factory/browser/`, because the repo is public. The report is evidence for you, not a gate: a FAIL doesn't move the card. It runs once per head commit, at most one card per tick, in a `--browser` step after `--release` so it never delays a merge. It only runs a scenario the factory wrote itself, never the fallback comment. With verification on, this run happens in **Testing** instead and its result is the verification report's Web row; a commit verified there gets no second browser run in In Test. See [ADR-0051](../adr/0051-factory-browser-runner.md).

With verification on (`FACTORY_VERIFY=1`), the scenario is written earlier, when the card enters **Testing**, and is titled "Test scenario — verifying now (Testing)". When the card reaches In Test, a second comment follows: **🏭 Verification before In Test** (markers `<!-- drafto-factory-verify-report -->` and `<!-- drafto-factory-verify-sha:<sha> -->`, posted once per commit). It holds:

1. A headline verdict: **PASS / WARN / FAIL** (the worst of the lanes that reported), or **INCOMPLETE** when none reported. Then "Evidence, not a gate: the card is now In Test."
2. A lane table: Repo & API (shell), Web (browser), iOS / Android and macOS, each with a status, a verdict and a note.
3. The assessment the lanes wrote.
4. **Steps for you to do manually**: what no lane covered, such as the native sections of the scenario on the beta, the Web steps when the browser lane didn't report, and the lanes' own manual list.
5. **Coverage gaps**: lanes that timed out, were skipped or were unavailable, plus the CodeRabbit note if there is one.

Both lanes are built. The shell lane (targeted tests, command steps, API checks on the preview, the macOS `--preflight`) is the report's Repo & API row, and on a web card the browser run is its Web row. A report where no lane got a verdict is INCOMPLETE, which still gives you the manual list. See [factory-verification.md](./factory-verification.md).

The scenario is refreshed whenever the PR head SHA changes, so an In Test → feedback → In Test round trip gets a new one. If Claude fails or times out, the factory posts a deterministic fallback comment instead — the card still advances, and this stage never consumes the retry budget.

### "A card sat in Testing"

Testing is factory-owned and bounded: a card leaves it at the latest `FACTORY_VERIFY_HOLD_MAX_MIN` (default 60) minutes after its round started. The `--watch` log has one `Testing → <action> (<reason>)` line per card per tick:

- **wait (ci-pending)** — a required check is running again on the same commit. **wait (threads-unknown)** — the review-thread query failed. Both end at the hold cap.
- **work-lanes** — the verification lanes are still running. The shell lane logs `verification shell lane started` or `not started (<reason>)`: `busy` (another card's run holds the lane), `memory` or `disk` (the Mac mini is short), `preview-wait` (the commit's preview isn't up yet). The browser lane is waiting for its turn in `--browser` (one browser run per tick), the scenario for the commit, or the preview (at most `FACTORY_VERIFY_PREVIEW_WAIT_MIN`, 10 min, after it first looked). `factory:get-issue <n>` → `verifyShell` / `verifyBrowser` shows each lane's result once it has one.
- **skip (pr-merged / pr-closed)** — the PR left by another route. The factory leaves the card for you: drag it to the right column.
- **hand-back (…)** — the card went back to In Review, with one comment on the issue saying why. It comes back to Testing by itself once the fix loop is done.

Nothing in the log at all means the sweep isn't seeing the card. Check for a `factory-pause` or `support` label, a global pause, or a `query-status-items 'Testing' failed` warning. `node scripts/lib/state-cli.mjs factory:verify-status` shows each card's `verify*` fields. To start a card's round again, run `factory:verify-reset <n>`. To skip verification for it, drag it to In Test. The runbook's "Pre-In-Test verification (Testing)" has the full triage.

### "The verification report says INCOMPLETE"

INCOMPLETE means no lane reported a verdict for that commit. Its **Coverage gaps** say why, lane by lane:

- **deferred under memory pressure / low disk / another card's verification run held the lane** — the shell lane never got its turn before the hold cap.
- **unavailable: the lane's guard hook didn't load** — on the **Repo & API** row, the shell lane is paused for 24 hours: find out why, then `node scripts/lib/state-cli.mjs factory:verify-resume` (the runbook's "The shell lane"). On the **Web** row, the browser runner's guard didn't load and the runner is off: fix its settings file, then `node scripts/lib/state-cli.mjs factory:browser-reset` (the runbook's "Browser runner (Claude in Chrome)", `guard-not-loaded`).
- **unavailable: …** (Web row) — the browser couldn't run (Chrome not running, the extension signed out, the Vercel login expired, …). The lane ends at once rather than holding the card; the In Test browser run tries again once the browser is fixed, for a PR that touches `apps/web/` (one that reaches the web app only through `packages/shared/` has no In Test run, so run its Web steps by hand). The runbook's "A Testing card's browser lane" lists every reason.
- **the PR's diff touches neither the web app (`apps/web/`) nor `packages/shared/`**, **no Vercel preview was ready**, **the PR branch predates the preview sign-in route** — the browser lane had nothing it could run.
- **the hold cap was reached first** — a lane was still running at the cap.
- **new feedback on the issue cut verification short** — you commented while the card was in Testing. The card went on to In Test, and from there back to In Progress for the revision.
- **verification is switched off** — the card was drained after `FACTORY_VERIFY=0`.
- **the lane is switched off** — `FACTORY_VERIFY_LANES` leaves it out.

The card is in In Test either way. Follow **Steps for you to do manually**.

### "Vercel preview never appeared in In Test"

The factory advances In Review → In Test when every branch-protection **required** status context is green. It additionally waits for a Vercel preview URL **only when the PR touches `apps/web`** — for a native-only PR the preview exercises nothing, so requiring it would deadlock the card. "CI is green" means the **required** contexts only — an advisory bot like CodeRabbit (including its "Review rate limited" status) is never a required context, so its red neither blocks the advance nor triggers the fix loop; it's surfaced in the In Test hand-off comment for the operator to glance at instead. If a web PR's required checks are green but Vercel hasn't run, check the Vercel project's GitHub integration is wired up; sometimes the bot misses a push and a force-push to bump the PR head re-triggers it.

### "A card sat in In Review for an hour or more before reaching In Test"

With the CodeRabbit CLI lane on (`FACTORY_CR_CLI=1`), a card whose CI is green and whose threads are all resolved can still hold in **In Review** while CodeRabbit covers its head commit ([ADR-0036](../adr/0036-factory-coderabbit-cli-gap-fill.md)). The `--watch` log names the reason for the hold:

- **bot-in-progress / bot-grace** — the PR bot is reviewing, or hasn't posted yet (grace `FACTORY_CR_BOT_GRACE_MIN`, default 15 min).
- **cli-in-flight** — a CLI review of this commit is running (7–30+ min; capped by `FACTORY_CR_CLI_TIMEOUT_MIN`, default 45). If a fix commit moves the PR head (or the PR closes) while it runs, the next tick terminates that run and frees the lane for the new head; the terminated run doesn't count against the card's run cap.
- **cli-busy / cli-budget-wait / cli-paused** — another card's CLI run is in flight, the 3-per-hour budget is spent, or the vendor rate-limited the lane and that pause ends inside the hold window.

Every hold is bounded per head commit: after `FACTORY_CR_HOLD_MAX_MIN` (default 60) the card is promoted anyway, so one commit normally holds for at most roughly `HOLD_MAX` + the CLI timeout (~105 min). A hold on the card's own run ends 80 minutes past that run's deadline even if collecting the run keeps failing (worst case ~185 min), promoting as `hold-expired`. The clock restarts when a fix commit converges, so a card that goes through two CLI rounds can sit in In Review for 3–4 h. Check the lane with `node scripts/lib/state-cli.mjs factory:cr-cli-status`.

To stop holding cards, set `FACTORY_CR_CLI=0` in the plist. That is also the kill switch: an in-flight CLI run is terminated and its results discarded, so nothing is posted. A lane pause (`factory:cr-cli-pause-until <iso> <reason>`) is not a substitute — it only stops new runs. Cards still hold for the bot and for their own in-flight run, then promote with `cli-unavailable`. See the runbook's "CodeRabbit CLI gap-fill lane".

### "The In Test comment says CodeRabbit did not review `<sha>`"

That commit got neither a PR-bot review nor a complete CLI review, so nothing but the factory's own Claude review fully read it — give it a closer look before Approving. The reason in parentheses maps to the card's recorded coverage (`factory:get-issue <n>` → `crCoverage`): the hourly CLI **budget** was spent, the **hold expired**, the per-card **cap** of CLI runs was reached, the CLI **failed** (an errored or failed review, a skip for any reason but "no changes", or findings that still couldn't be posted 70 minutes after the run's deadline), the CLI was **unavailable** (not installed, logged out, `coderabbit doctor` failing — the card then promotes in the same tick — or the lane paused by an operator), or the review was **partial**: the CLI did review it, but some thread-worthy findings could only go into the CLI summary comment on the PR (past the thread cap, or rejected by GitHub), where the fix loop never acts on them — read that comment. It never blocks the card. The runbook's "CodeRabbit CLI gap-fill lane" lists each value and the fix for the unavailable case.

If the note instead says coverage is **unknown (lane error)**, the lane itself failed and the card was promoted anyway (the lane fails open); the `--watch` log shows why (a `gate-error` reason or a lane WARNING). The note comes from the lane's promotion decision (or, for a re-written scenario of the same head, from the coverage recorded for it), so a commit pushed while the card is already In Test gets none — if in doubt, check that `crCoverageSha` matches the PR head.

### "A web card reached In Test but no browser report appeared"

If the card came through **Testing**, its browser run happened there: the result is the Web row of the verification report, and the In Test run skips that commit. It runs in In Test only when the Testing lane couldn't report on the commit.

The browser run is on by default. It is off when the plist sets `FACTORY_BROWSER=0`, or when `FACTORY_BROWSER_KINDS` leaves out `intest`. When it is on, it waits for:

- the scenario for this exact commit;
- a successful `vercel[bot]` deployment of that commit;
- its turn, since one card runs per tick.

It also skips a scenario without a `### Web` section, and a card with a revision request pending. A PR whose branch was cut before `/auth/test-sign-in` landed gets no run either: the issue gets a "No browser run" note asking for `main` to be merged into the branch (the **Update branch** button), and the next commit gets its run.

When the browser itself is the problem, the issue gets no comment and the operator gets an email after two bad results in a row: Chrome not running, the extension signed out, or the Vercel login expired. Check `node scripts/lib/state-cli.mjs factory:browser-status`, and `factory:get-issue <n>` → `browserRunSha` / `browserRunAttempts`. The runbook's "Browser runner (Claude in Chrome)" lists every reason and its fix.

### "My TestFlight / Play beta build never arrived"

Pre-merge beta dispatch is **off by default** and has two knobs. `FACTORY_INTEST_BETA` is the **master switch**: while it is `0`, no lane is dispatched at all — not mobile, not macOS. With it on, mobile dispatches, and macOS _additionally_ requires `FACTORY_INTEST_BETA_DESKTOP=1` (setting only the desktop knob gets you nothing). When a lane is gated off, the In Test comment says so and gives you the manual command instead. See the runbook's "Pre-merge beta dispatch" section for the knobs, the build roots, and triage (`factory:get-issue <n>` → `intestBetaSha` / `intestBetaLanes`).

A dispatched lane is a detached local Fastlane build that takes 20-40 minutes; when it lands, a follow-up comment reports the build number. Its release notes begin `PRE-MERGE TEST BUILD — issue #N / PR #M (sha)` so you can tell which build belongs to which card, and that it is a build of **unmerged** code.

### "I tested the preview and want changes"

Comment the change on the **issue** while the card is in **In Test** (e.g. "the close button overlaps the title — move it left"). On the next `--watch` tick the factory rolls the card back to **In Progress** and posts "🏭 revising…"; the next `--implement` tick applies your feedback on the **same** PR branch (the approved plan still bounds scope — a request outside it is declined: you get a 🏭 reply saying so, and the card comes back to In Test with the PR unchanged; open a new issue for that work rather than rephrasing it, [ADR-0058](../adr/0058-revision-blocks-return-to-test.md). A change it started but couldn't finish, or a suspected prompt injection, still goes to **Blocked** for you to look at), and the card flows back through In Review → In Test with the preview redeployed. **Every comment gets its own 🏭 reply on the issue** (marked `<!-- drafto-factory-revise-reply-<commentId> -->`), even when several arrive in one round: a change request's reply says what was changed, and a comment that needs no code change, such as a question or "run the test scenario for me", gets done and answered. When nothing needed a code change, the card returns to In Test with the PR unchanged. Approval noise ("thanks", "lgtm") gets no reply. Steps only you can run, such as pushing a migration to dev or the dev live tests (`pnpm test:live:supabase`), are listed in that reply under **Steps for you** with the exact commands. The implementer only runs commands from the factory's own In Test scenario or the repo's tests, never commands written in a comment, and a forwarded customer email never triggers a run. If a comment's reply is missing afterwards, the factory posts a short fallback for that comment instead ("no code change was made for that, and no reply was found"; for a declined request "declined that as outside this issue's plan"; for a pushed change "a revision was pushed for that, but no reply was found"), so no comment goes unanswered. A comment you post while the revision is running isn't lost: it's picked up as the next round of feedback. Iterate as many rounds as you like. To stop and ship instead, drag the card to **Approved** (a "looks good"/"thanks" comment is treated as noise, not a ship signal — approval is always the explicit drag). The factory only acts on comments posted _after_ the preview it last showed you, so older discussion doesn't re-trigger work.

### "Allowlisted reporter's email reply didn't move the card"

`support-agent.sh`'s accept-signal classifier requires:

- The reporter's address matches `reporter-email` from the issue body footer (no impersonation via cc/bcc).
- The card is in one of the two transitionable states (`status:plan-review` → `status:in-progress`, or `status:released` → `status:done`).
- The reply text reads as accept-intent ("go ahead", "ship it", "thanks", `[ACCEPT]`, `[GO]`).

Check `logs/support/support-agent-*.log` for the per-thread classification line. If the classifier flagged the reply as non-accept-intent (e.g. it mentioned a new direction), the agent treated the reply as a fresh comment and the card stays where it is — drag it manually if needed.

### "Every card stalled and I got a 'drafto factory paused' email"

The toolchain health check found a broken tool on the Mac mini, typically git failing because a new Xcode's license hasn't been accepted. The email and the `factory-failure` issue name the fix. For the Xcode license, run `sudo xcodebuild -license accept` in a real Terminal on the Mac mini; it can't run from launchd or a Claude `!` command because sudo needs a password prompt. Nothing else is needed: the next tick sees the probes pass, resumes the factory, closes the issue and emails you that it has recovered. See [factory-runbook.md → "Automatic toolchain pause"](../operations/factory-runbook.md#automatic-toolchain-pause-self-healing).

### "A card moved to Blocked saying 'low disk'"

Before starting an implementation the factory checks free space on the build volume and, if it's below `FACTORY_MIN_FREE_DISK_GB` (default 3 GB), parks the card in **Blocked** with a `<!-- drafto-factory-disk-low -->` comment instead of failing mid-build. Reclaim space on the Mac mini (`git worktree prune`; clear Xcode `DerivedData`, old simulators, and `~/.gradle/caches`; strip `node_modules` from stale `.claude/worktrees/*` and `worktrees/*`), then drag the card back to **In Progress**. See [`docs/operations/factory-runbook.md`](../operations/factory-runbook.md) → "Worktree installs & disk" for the full reclamation + pnpm-store runbook.

### "I asked for a change, the factory said it did it, and nothing changed"

Fixed in [ADR-0033](../adr/0033-factory-branch-safety-and-implement-verification.md); this is what it looked like. The factory used to delete the local `factory/issue-<n>` branch whenever a card was moved to Blocked while still holding a worktree slot — even with the PR open. The next revision run then found no local branch and rebuilt the worktree from `origin/main`, so the agent edited pre-PR files, its push was rejected as non-fast-forward, and the prompt told it to report success anyway. Bash believed the report, advanced the card, and marked your comments consumed, so the request could never be replayed.

Now: the branch is kept whenever a live PR points at it, a missing branch is recovered from `origin`, and a run that claims success without moving the PR head is treated as a failed attempt — your feedback stays unconsumed and the card stays put. If it repeats until the retry budget is exhausted, the card lands in **Blocked** with a `<!-- drafto-factory-head-unchanged -->` comment rather than looking done.

If you hit the old behaviour on a card that predates the fix, the recovery is in [`docs/operations/factory-runbook.md`](../operations/factory-runbook.md) → "Recovering a card whose feedback was falsely consumed".

## Related

- [ADR-0026](../adr/0026-dark-factory-pipeline.md) — decision record.
- [factory-verification.md](./factory-verification.md) and [ADR-0053](../adr/0053-pre-in-test-verification-stage.md) — the Testing column (pre-In-Test verification).
- [`docs/operations/factory-runbook.md`](../operations/factory-runbook.md) — phase promotion criteria, rollback drills, on-call response.
- [`docs/dark-factory-proposal.md`](../dark-factory-proposal.md) — original proposal (lifecycle table, household autopilot details, implementation waves).
- [`scripts/setup-factory-labels.sh`](../../scripts/setup-factory-labels.sh) — label bootstrap.
- [`scripts/setup-factory-board.sh`](../../scripts/setup-factory-board.sh) — Project v2 board bootstrap.
- [`.github/ISSUE_TEMPLATE/factory-feature.yml`](../../.github/ISSUE_TEMPLATE/factory-feature.yml) — spec contract template.
