# Factory verification before In Test (the Testing column)

**Status:** state machine, shell lane and browser lane built, off by default (`FACTORY_VERIFY=0`) **Updated:** 2026-10-21

## What it is

A factory-owned **Testing** column between In Review and In Test on the [dark factory](./dark-factory.md) board. When a card's PR is green and reviewed, the factory runs the card's test scenario itself before a human tests it. It then moves the card to In Test with one **verification report** comment: what passed, what failed, and what's left to do by hand.

Verification is **evidence, never a gate** ([ADR-0035](../adr/0035-factory-code-review-gate.md)). A FAIL doesn't hold the card, and a hold cap bounds the whole stay. The only reasons a card goes back to In Review are about the commit, not the evidence. The decision is [ADR-0053](../adr/0053-pre-in-test-verification-stage.md).

## Flow

All of it runs in `scripts/factory-agent.sh --watch`, the shell lane detached from it, except the browser lane's Chrome run, which runs in `--browser` (see "The browser lane" below).

1. **Entry (In Review → Testing).** At the point where a converged card used to be promoted to In Test (CI green, preview up, review done, no open threads, the CodeRabbit gate passed), `verify_target_status` decides where it goes. The card goes to Testing when `FACTORY_VERIFY=1`, the canary label (if one is set) is on the issue, the board has the Testing option, the repo has the `status:testing` label, and this commit has no report yet. `verify_enter` then:
   - moves the card first;
   - starts the round (`verifySha`, `verifyStartedAt`, `verifyCrNote`, and `lastFeedbackAt` if it was empty);
   - dispatches the pre-merge betas;
   - writes the scenario with the Testing title, "Test scenario — verifying now (Testing)" (`INTEST_STAGE=testing`), and the verification platforms (see "Web reached through `packages/shared/`" below).

   If the move fails, or anything above isn't true, the card is promoted to In Test exactly as before.

2. **The Testing sweep.** Every tick, between the In Review loop and the In Test sweep, `verify_sweep` takes each card in Testing, oldest issue first. It skips `factory-pause` and `support` cards and stops if the factory pauses. Only the switch and the canary label decide whether a card already in Testing is verified: a failed column lookup can't drain it. For each card it gathers the facts: PR state and head, required CI, review threads, the last reviewed head, new actionable feedback, each lane's state and the hold-cap clock. It then asks `scripts/lib/verify-decide.mjs` for one action:

   | Situation (first match wins)                                                   | Action                                      |
   | ------------------------------------------------------------------------------ | ------------------------------------------- |
   | PR merged or closed                                                            | leave it for the operator                   |
   | verification off                                                               | promote (drains the column)                 |
   | actionable new feedback on the issue                                           | promote (the In Test sweep then revises it) |
   | an open round is for another commit (the head moved)                           | hand back to In Review                      |
   | required CI red; head not code-reviewed                                        | hand back to In Review                      |
   | open review threads (read once CI is green), under `FACTORY_VERIFY_BOUNCE_MAX` | hand back to In Review                      |
   | no round for this head (dragged in)                                            | start a round                               |
   | required CI pending; thread list or PR head unreadable                         | wait, or promote at the hold cap            |
   | every lane done, or the hold cap reached                                       | promote                                     |
   | otherwise                                                                      | work the lanes                              |

3. **Hand-back.** `verify_hand_back` moves the card back to In Review; a hand-back for review threads also bumps `verifyBounces`, the per-commit budget the bounce cap counts (the other reasons are bounded already: a new commit, the fix loop's attempts, a once-per-commit review). It posts one comment per commit and reason (`drafto-factory-verify-handback:<sha12>:<reason>`). Attempts aren't reset, so a card that keeps bouncing ends in Blocked rather than looping.
4. **Promotion.** `verify_promote` composes the report, moves the card to In Test and posts the report once per commit. Its resets match the old promotion's: attempts and the CodeRabbit run cap. If composing fails, a minimal notice goes out. If posting fails, the In Test sweep tries three more times, 10, 20 and 30 minutes after the report was composed (`verify_report_retry`). Lanes still running when the card leaves Testing are stopped (`verify_stop_lanes`), on promotion as on a hand-back.
5. **Revision no-op.** When a revision needs no code change, `--implement` sends the card back to Testing if that commit still owes a report, and to In Test otherwise. It starts the commit's round itself, as entry does.

## Lanes

| Lane                 | What it does                                                                                                                                                                                                                                                                                                        | Status                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Repo & API (`shell`) | A detached `--no-chrome` claude session with a guard hook, in its own detached worktree with no env files. It runs targeted tests, the scenario's command steps, the macOS `--preflight` (ADR-0043), and API and MCP checks against the per-commit preview through a curl wrapper holding the Vercel bypass secret. | Built (Wave 5A); see below                    |
| Web (`browser`)      | A `verify` kind of the locked-down Claude in Chrome runner (ADR-0051), on the per-commit preview.                                                                                                                                                                                                                   | Built (Wave 5B); see "The browser lane" below |
| iOS / Android, macOS | Manual, on the betas dispatched at Testing entry. The report lists the steps.                                                                                                                                                                                                                                       | Deferred (see "Planned" below)                |

A lane's state is read for the card's head as `"<sha>:<state>[:<verdict>]"` (`verifyShell`, `verifyBrowser`). The states:

- **Terminal:** `reported[:<verdict>]`, `timeout`, `unavailable:<reason>`, `stale-branch`, `no-preview`, `skipped:<reason>`.
- **Still running:** anything else: `none`, the shell lane's `running`, `retry:<why>` and `deferred:<why>`, the browser lane's `waiting-preview:<iso>`.
- **Filled in by the sweep:** `skipped:not-built` for a lane missing from `VERIFY_BUILT_LANES` (both lanes are built, so only a future lane would read it), `skipped:lane-off` when `FACTORY_VERIFY_LANES` leaves the lane out, and `skipped:verification-off` when the card is drained. At promotion, a lane still running becomes `skipped:hold-cap` or `skipped:feedback`. At the hold cap, a shell lane still `deferred:<why>` becomes `skipped:<why>` (memory pressure, low disk, another card's run, a session limit), one whose last attempt ended `retry:<why>` becomes `skipped:after-<why>`, and the browser lane's preview wait becomes `skipped:hold-cap`.

The report reads every reason as a sentence (the `REASONS` table in `verify-report.mjs`); an unknown one is shown as it is.

## The shell lane

`scripts/lib/verify-lane.mjs` (the IO), `scripts/lib/verify-guard.mjs` (its PreToolUse guard) and `scripts/factory-verify-prompt.md` (its prompt). It's run like the CodeRabbit CLI lane ([ADR-0036](../adr/0036-factory-coderabbit-cli-gap-fill.md)): detached, collected later, never blocking a tick.

1. **Start** (`verify_shell_work` on the sweep's `work-lanes` action → `verify-lane.mjs start`). Refused, and tried again next tick, while the factory or the lane is paused, another run holds the lane's single slot, memory pressure is at warn or worse, disk is low, the scenario for this commit isn't written yet, or the preview isn't up and `FACTORY_VERIFY_PREVIEW_WAIT_MIN` hasn't passed. The attempts for this commit (`FACTORY_VERIFY_MAX_ATTEMPTS`) being spent is final (`skipped:attempts`). Otherwise it reserves the slot in the state file before doing anything else, fetches `pull/<pr>/head` into a fresh detached worktree (`worktrees/verify-<issue>-<sha12>`, no env files), writes the run directory (prompt, the `factory_verify_shell` bundle, the guard's files, `meta.json` with secret-file paths only) and spawns the supervisor under `nice -n 10`. The card's shell lane reads `running`.
2. **Supervise** (detached; never touches git, `gh` or the state file). Clones `node_modules` from the factory checkout and runs `pnpm install --frozen-lockfile --prefer-offline`. With a preview, it mints the one-time sign-in link (`browser-signin.mjs`) and exchanges it with curl into a cookie jar, and writes `private/curl.cfg` (mode 600: the bypass header, the jar, https only, a 30-second cap) and `bin/preview-curl`. Then the claude session, through `run-claude.mjs`:

   `-p --no-chrome --strict-mcp-config --setting-sources "" --settings <guard> --permission-mode dontAsk --tools Bash,Read,Grep,Glob --allowedTools Bash,Read,Grep,Glob --session-id <uuid> --effort $FACTORY_PLAN_EFFORT`

   with an allowlisted environment (no tokens), `GH_CONFIG_DIR` pointing at an empty directory, and a cap that ends the call two minutes before the run's deadline (`FACTORY_VERIFY_SHELL_TIMEOUT_MIN`). Afterwards it checks the guard's canary, revokes the API keys named with the run's tag (and older `factory-shell-…` leftovers of killed runs, never a newer run's), deletes `private/` and writes `exit.json`. The run's deadline never passes the hold cap, and no run starts with less than 10 minutes of the round left.

3. **Collect** (`verify_shell_housekeeping`, top of every `--watch` tick). Records `verifyShell` and `verifyShellRunDir`, frees the slot, removes the worktree. It kills a run whose PR head moved, whose PR closed or whose card lost `status:testing`, and one past its deadline. A moved head or a closed PR gives the attempt back. A card that lost the label keeps it spent, so a label that disagrees with the board can't loop start and kill. A session limit pauses the factory, as any claude call's does, and refunds the attempt. A guard that didn't load pauses the lane for 24 hours.
4. **Stop** (`verify_shell_stop`, on every exit from Testing). Kills the run, refunds its attempt, removes the worktree.

**`preview-curl`** is the lane's only way to the preview. It takes a path, never a URL, and an allowlist of curl options (`-X`, `-H`, `-d` / `--data-raw` / `--json`, `-G`, `-s`, `-S`, `-f`, `-o /dev/null`, `-w '%{http_code}'`). It refuses `-K`, proxies, `--url`, `--connect-to`, `@file` bodies, `-i` / `-v` / `-D` and anything else that could print headers, read a file or reach another host, and `x-vercel-*` / `cookie` headers. Scenario steps written as `vercel curl` are translated to it; `vercel curl` itself is never run, because it mints a bypass secret of its own.

The report gets the lane's own facts as coverage gaps (`verify-lane.mjs gaps`): no usable bypass secret, no preview, no session on the preview, key revocation not confirmed. A run that was given the bypass secret has its output scanned for it even if the file is gone by the time the report is composed (fail closed).

## The browser lane

The Web lane is the browser runner's `verify` kind ([ADR-0051](../adr/0051-factory-browser-runner.md)): the same locked-down `claude -p --chrome` session as the In Test web run, with the same prompt, guard, sign-in link and secret scan, running the scenario's own `### Web` section on the commit's per-commit preview. There is still exactly one claude call with `--chrome`.

1. **Queue (`--watch`).** On `work-lanes`, `verify_browser_work` looks at the lane's state for the head. A web card (the PR diff touches `apps/web/` or `packages/shared/`, see "Web reached through `packages/shared/`" below) with no result yet gets a `verify:<issue>:<pr>:<sha>` line in `logs/factory-browser-candidates`. Two outcomes are settled here, without Chrome: a diff that touches neither (`skipped:not-web`) and a runner whose `verify` kind is off (`FACTORY_BROWSER=0`, or `FACTORY_BROWSER_KINDS` without `verify`: `skipped:browser-off`). Platforms that couldn't be read wait a tick.
2. **Run (`--browser`).** The loop runs `--browser` after `--release`, so a Chrome session never delays a merge. It takes the `verify` lines first, re-checks that the card is still in Testing (and not paused), and runs at most one candidate per tick, verify or In Test. `browser_run verify` checks that the card's round is for this head, the lane has no result yet and the scenario for the head exists, then does what the In Test run does: the live-head check, the health preflight, the preview lookup, the stale-branch check, the one-time sign-in link, the session.
3. **Record, never post.** The run's output is rendered with `browser-report.mjs render --kind verify`, which writes a scanned, defanged `section.md` with no factory markers, plus `render.json`, and posts nothing. The lane records `verifyBrowser="<sha>:<state>"` and `verifyBrowserRunDir`. The verification report reads that run dir's `runner-output.txt` and scans it again when the card is promoted. The result is recorded only if, once the session is over, the round is still for that head and the card is still in Testing. A card dragged out mid-run keeps no result, so the In Test run can still report on it.
4. **Terminal at once.** Anything waiting can't fix ends the lane right away, so the card doesn't sit out the hold cap:

   | State                                               | When                                                                                                                                                                                                                                                                                                  | Attempt  |
   | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
   | `reported:<verdict>`                                | The runner printed a status line, `ok` or `blocked`.                                                                                                                                                                                                                                                  | spent    |
   | `stale-branch`                                      | The PR head predates `/auth/test-sign-in`. No session, no health strike and no note of its own: the report tells the reader to update the branch.                                                                                                                                                     | none     |
   | `no-preview`                                        | Still no successful `vercel[bot]` deployment of the head `FACTORY_VERIFY_PREVIEW_WAIT_MIN` (10) minutes after the lane first found none. Until then the lane waits (`waiting-preview:<iso>`, not terminal); a GitHub error doesn't count.                                                             | none     |
   | `timeout`                                           | The session hit `FACTORY_BROWSER_TIMEOUT_SEC`.                                                                                                                                                                                                                                                        | spent    |
   | `unavailable:<reason>`                              | The operator's side: a failed preflight (`chrome-not-running`, `runner-disabled`, `account`, `signin-key`, `preflight`; it ends every queued verify lane that tick, with one health record), `signin-mint`, `runner-start`, `guard`, `session-limit`, or the runner's own `chrome` or `auth-expired`. | refunded |
   | `unavailable:signin-failed`                         | The sign-in link didn't sign the runner in. No retry fixes it.                                                                                                                                                                                                                                        | spent    |
   | `unavailable:runner-error`, `unavailable:malformed` | claude failed, or printed no status line, on the commit's last attempt. Before that, the next tick tries again.                                                                                                                                                                                       | spent    |
   | `unavailable:attempts`                              | The commit's attempts (`FACTORY_BROWSER_MAX_ATTEMPTS`, 2, shared with the In Test run) were already spent.                                                                                                                                                                                            | —        |
   | `skipped:not-web`, `skipped:browser-off`            | See step 1.                                                                                                                                                                                                                                                                                           | none     |
   | `skipped:no-scenario`, `skipped:no-web-steps`       | No factory scenario for the head (or only the fallback comment), or one without a `### Web` section.                                                                                                                                                                                                  | none     |
   | `skipped:already-run`                               | The In Test run's report for this commit is on the issue (the card came back to Testing on the same head). An In Test pass that left no report doesn't count: this run then gives its own reason.                                                                                                     | none     |

   Health recording (`browser-health.mjs`) is the same as for an In Test run, so the operator gets the same emails.

5. **The In Test run is the fallback.** Both kinds share `browserRunSha` and the per-commit attempts. The verify lane claims a commit (`browserRunSha`) when it reports for a card the board shows in Testing, or finds a stale branch or nothing to run. A claimed commit isn't run again in In Test. One the lane couldn't report on (unavailable, no preview, a timeout with an attempt left) gets its In Test run once the card is there. So does a claimed one whose result never reached the issue: when the minimal notice goes out instead of the report, or posting the report is given up, `verify_browser_unclaim` releases the claim. The In Test run keeps the plain platforms, so a PR that reaches the web app only through `packages/shared/` has no In Test fallback: the report lists its Web steps for the human instead.
6. **Stopping.** A verify run is synchronous inside `--browser`, which never overlaps `--watch`, so nothing is in flight when a card leaves Testing. `verify_browser_stop` only drops the card's candidate from the tick's list, and `--browser` re-checks the column and the round before every run.

The browser lane reads the scenario's own `### Web` section: `extractWebSection` is the `Web` entry of `extractScenarioSections`, so a `### Web` under "How to get a build" is never taken for steps. That holds for the In Test run too.

## Web reached through `packages/shared/`

`derivePlatforms` (`scripts/lib/dispatch-release.mjs`) maps `packages/shared/` to mobile and desktop only, because nothing is dispatched for web. The web app imports `packages/shared/` too, and Vercel builds a preview for every PR head, a shared-only one included. So the verification stage reads its own variant, `deriveVerifyPlatforms` (`derive-platforms --verify`): mobile and desktop are unchanged, `web` is also true when `packages/shared/` changed, and `webViaShared` is true when that is the only way web came in.

Read the verification variant:

- **Both lanes** (`VERIFY_LANE_PLATFORMS` → `verify_work_lanes`). The browser lane queues; the shell lane's bundle carries `webViaShared`, so it knows the web app's tests that cover the changed shared code are targeted tests.
- **The report** (`verify_promote` → `verify-report.mjs --platforms`). The Web row says the web changes come through `packages/shared/`.
- **The scenario for a commit with a verification round** (`scenario_platforms`): the Testing-stage scenario, and any later rewrite for that same commit.

Keep the plain platforms:

- The betas (`intest_dispatch_betas`), whose lanes read only mobile and desktop anyway.
- `INTEST_PLATFORMS`, the In Review preview gate (`WEB_TOUCHED`) and the post-merge beta dispatch.
- The parity check, which reads the diff itself (`apps/web/` only).
- The `intest` browser kind's candidate check.

The scenario matters because the browser lane runs only its `### Web` section: the writer is told to cover only `bundle.platforms`, so without the variant a shared-only PR would get no Web section and the lane would end `skipped:no-web-steps`. With `webViaShared` the writer covers how the shared change shows up in the web app and says in its summary that the web changes come through `packages/shared/`. `scenario_platforms` keys on `verifySha`: the In Review promotion re-posts the scenario for a card handed back without a new commit (a thread, a red check, a drag back), and that re-post keeps the variant, and so the Web section, the commit's Testing scenario had.

## The report

`scripts/lib/verify-report.mjs` is deterministic (no claude call). It writes one comment, **🏭 Verification before In Test**:

1. **Headline verdict:** PASS / WARN / FAIL (the worst of the lanes that reported), or INCOMPLETE. Then "Evidence, not a gate: the card is now In Test."
2. **Lane table:** status, verdict and a note for each lane, plus iOS / Android and macOS. On a PR that reaches the web app only through `packages/shared/`, the Web row's note says so.
3. **Assessment** from the lanes.
4. **Steps for you to do manually:** deduplicated, at most 25.
5. **Coverage gaps**, including the CodeRabbit coverage note the card carried into Testing (`verifyCrNote`).
6. Each lane's full report, collapsed, and where the evidence is on the Mac mini.
7. The markers `<!-- drafto-factory-verify-report -->` and `<!-- drafto-factory-verify-sha:<sha> -->`.

Every lane's text is scanned for secrets: the test account's password, the bypass secret and the dev service-role key, each as a literal, plus token patterns and the bypass header names. A hit withholds that lane only. An unreadable secret file withholds the lanes it guards. All text is defanged, so a lane can't fake a factory marker.

## Code paths

| Piece                                                                         | Where                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings, entry, sweep, hand-back, promotion, report retry, the no-op routing | `scripts/factory-agent.sh` (`verify_*` functions; the sweep is called as step 2b of `--watch`)                                                                                                                                                                          |
| The decision table                                                            | `scripts/lib/verify-decide.mjs`                                                                                                                                                                                                                                         |
| The report                                                                    | `scripts/lib/verify-report.mjs`, with `parseBlocks()` in `browser-report.mjs` and `extractScenarioSections()` in `factory-bundle.mjs`                                                                                                                                   |
| The shell lane                                                                | `scripts/lib/verify-lane.mjs`, `scripts/lib/verify-guard.mjs`, `scripts/factory-verify-prompt.md`; `verify_shell_*` in `factory-agent.sh`                                                                                                                               |
| The browser lane                                                              | `scripts/factory-agent.sh` (`verify_browser_*`, `browser_run verify`, the `--browser` loop), `browser-report.mjs render --kind verify`                                                                                                                                  |
| Per-card state and the lane ledger                                            | `scripts/lib/factory-state.mjs` (`VERIFY_ISSUE_FIELDS`, the `verify` ledger), `state-cli.mjs factory:verify-*`                                                                                                                                                          |
| The column                                                                    | `scripts/setup-factory-board.sh`, `scripts/setup-factory-labels.sh`, `scripts/lib/factory-project.mjs has-status-option`                                                                                                                                                |
| The Testing-stage scenario wording                                            | `scripts/factory-intest-prompt.md` ("Stage: In Test or Testing"), `buildFactoryInTestBundle({stage})`, `intest_fallback_comment`                                                                                                                                        |
| Web reached through `packages/shared/`                                        | `deriveVerifyPlatforms` (`dispatch-release.mjs`, `derive-platforms --verify`); `verify_platforms_of`, `scenario_platforms` in `factory-agent.sh`; tests in `dispatch-release.test.mjs`, `factory-intest-prompt-grounding.test.mjs`                                      |
| Tests                                                                         | `scripts/__tests__/verify-decide.test.mjs`, `factory-agent-verify.test.mjs`, `verify-report.test.mjs`, `verify-lane.test.mjs`, `verify-lane-supervisor.test.mjs`, `verify-guard.test.mjs`, `factory-verify-prompt-grounding.test.mjs`, `factory-agent-browser.test.mjs` |

## Settings and operations

The settings table, one-time setup (board, label, bypass secret, canary), triage and the rollback drill are in [the runbook's "Pre-In-Test verification (Testing)"](../operations/factory-runbook.md#pre-in-test-verification-testing). The short version:

- `FACTORY_VERIFY=0` is the default and the kill switch. With it off, the Testing sweep only drains the column.
- To roll back, set `FACTORY_VERIFY=0`, wait for the Testing column to empty (move by hand any card the sweep leaves: `factory-pause` or `support` labels, a merged or closed PR, no PR), and only then revert the code.

## Planned: device lanes (deferred)

No lane runs a native app yet. iOS, Android and macOS steps go to the manual list, on the betas dispatched at Testing entry. A device lane would need all of the following:

- **Dev-backed debug builds of the PR head only.** Never `.env.production`, never a release or TestFlight build: the lane signs in to the dev Supabase project with the dev test account.
- **A dedicated build root** under the same root lock as the beta lanes (`scripts/lib/beta-build-root.sh`), never the card's slot worktree.
- **A Metro port per slot, or an embedded JS bundle,** so two cards' builds can't serve each other's code.
- **Simulators:** a headless Android emulator (`emulator -no-window`) and an iOS simulator through `simctl`.
- **Maestro on the factory's PATH** (`~/.maestro/bin`).
- **The shell lane translating the scenario's steps into Maestro YAML** in its run directory, not in the repo.
- **Typed sign-in** with the dev test account (no one-time link on a device).
- **A RAM budget.** The emulator takes 2–3 GB and a Gradle build 3–4 GB, so device lanes have to be serialised with the beta lanes.
- **Disk.** An AVD is about 10 GB, so `FACTORY_MIN_FREE_DISK_GB` would have to go up.
- **Killed when the head moves**, like the shell lane.
- **macOS stays manual** until an ADR allows a dev-backed harness mode. ADR-0043 allows agents `--preflight` only.
- **Prerequisites:** an ADR amendment (ADR-0053 and ADR-0043), and RAM measurements on the Mac mini with a beta build running.

## Related

- [ADR-0053](../adr/0053-pre-in-test-verification-stage.md) — the decision. It amends [ADR-0030](../adr/0030-in-test-scenarios-and-pre-merge-betas.md) (when the scenario is written) and [ADR-0051](../adr/0051-factory-browser-runner.md) (the bypass secret).
- [dark-factory.md](./dark-factory.md) — the board, "What you get at In Test", troubleshooting.
- [factory-runbook.md](../operations/factory-runbook.md) — settings, setup, triage, kill switches.
