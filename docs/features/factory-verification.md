# Factory verification before In Test (the Testing column)

**Status:** state machine built, off by default (`FACTORY_VERIFY=0`); lanes not built yet (Waves 5A and 5B) **Updated:** 2026-10-21

## What it is

A factory-owned **Testing** column between In Review and In Test on the [dark factory](./dark-factory.md) board. When a card's PR is green and reviewed, the factory runs the card's test scenario itself before a human tests it. It then moves the card to In Test with one **verification report** comment: what passed, what failed, and what's left to do by hand.

Verification is **evidence, never a gate** ([ADR-0035](../adr/0035-factory-code-review-gate.md)). A FAIL doesn't hold the card, and a hold cap bounds the whole stay. The only reasons a card goes back to In Review are about the commit, not the evidence. The decision is [ADR-0053](../adr/0053-pre-in-test-verification-stage.md).

## Flow

All of it runs in `scripts/factory-agent.sh --watch`; the browser half (Wave 5B) runs in `--browser`.

1. **Entry (In Review → Testing).** At the point where a converged card used to be promoted to In Test (CI green, preview up, review done, no open threads, the CodeRabbit gate passed), `verify_target_status` decides where it goes. The card goes to Testing when `FACTORY_VERIFY=1`, the canary label (if one is set) is on the issue, the board has the Testing option, the repo has the `status:testing` label, and this commit has no report yet. `verify_enter` then:
   - moves the card first;
   - starts the round (`verifySha`, `verifyStartedAt`, `verifyCrNote`, and `lastFeedbackAt` if it was empty);
   - dispatches the pre-merge betas;
   - writes the scenario with the Testing title, "Test scenario — verifying now (Testing)" (`INTEST_STAGE=testing`).

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

| Lane                 | What it does                                                                                                                                                                                                                                                                                                        | Status                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Repo & API (`shell`) | A detached `--no-chrome` claude session with a guard hook, in its own detached worktree with no env files. It runs targeted tests, the scenario's command steps, the macOS `--preflight` (ADR-0043), and API and MCP checks against the per-commit preview through a curl wrapper holding the Vercel bypass secret. | Wave 5A                        |
| Web (`browser`)      | A `verify` kind of the locked-down Claude in Chrome runner (ADR-0051), on the per-commit preview.                                                                                                                                                                                                                   | Wave 5B                        |
| iOS / Android, macOS | Manual, on the betas dispatched at Testing entry. The report lists the steps.                                                                                                                                                                                                                                       | Deferred (see "Planned" below) |

A lane's state is read for the card's head as `"<sha>:<state>[:<verdict>]"` (`verifyShell`, `verifyBrowser`). The states:

- **Terminal:** `reported[:<verdict>]`, `timeout`, `unavailable:<reason>`, `stale-branch`, `no-preview`, `skipped:<reason>`.
- **Still running:** anything else.
- **Filled in by the sweep:** `skipped:not-built` until a lane's wave ships, `skipped:lane-off` when `FACTORY_VERIFY_LANES` leaves the lane out, and `skipped:verification-off` when the card is drained. At promotion, a lane still running becomes `skipped:hold-cap` or `skipped:feedback`.

## The report

`scripts/lib/verify-report.mjs` is deterministic (no claude call). It writes one comment, **🏭 Verification before In Test**:

1. **Headline verdict:** PASS / WARN / FAIL (the worst of the lanes that reported), or INCOMPLETE. Then "Evidence, not a gate: the card is now In Test."
2. **Lane table:** status, verdict and a note for each lane, plus iOS / Android and macOS.
3. **Assessment** from the lanes.
4. **Steps for you to do manually:** deduplicated, at most 25.
5. **Coverage gaps**, including the CodeRabbit coverage note the card carried into Testing (`verifyCrNote`).
6. Each lane's full report, collapsed, and where the evidence is on the Mac mini.
7. The markers `<!-- drafto-factory-verify-report -->` and `<!-- drafto-factory-verify-sha:<sha> -->`.

Every lane's text is scanned for secrets: the test account's password, the bypass secret and the dev service-role key, each as a literal, plus token patterns and the bypass header names. A hit withholds that lane only. An unreadable secret file withholds the lanes it guards. All text is defanged, so a lane can't fake a factory marker.

## Code paths

| Piece                                                                         | Where                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Settings, entry, sweep, hand-back, promotion, report retry, the no-op routing | `scripts/factory-agent.sh` (`verify_*` functions; the sweep is called as step 2b of `--watch`)                                        |
| The decision table                                                            | `scripts/lib/verify-decide.mjs`                                                                                                       |
| The report                                                                    | `scripts/lib/verify-report.mjs`, with `parseBlocks()` in `browser-report.mjs` and `extractScenarioSections()` in `factory-bundle.mjs` |
| Per-card state and the lane ledger                                            | `scripts/lib/factory-state.mjs` (`VERIFY_ISSUE_FIELDS`, the `verify` ledger), `state-cli.mjs factory:verify-*`                        |
| The column                                                                    | `scripts/setup-factory-board.sh`, `scripts/setup-factory-labels.sh`, `scripts/lib/factory-project.mjs has-status-option`              |
| The Testing-stage scenario wording                                            | `scripts/factory-intest-prompt.md` ("Stage: In Test or Testing"), `buildFactoryInTestBundle({stage})`, `intest_fallback_comment`      |
| Tests                                                                         | `scripts/__tests__/verify-decide.test.mjs`, `factory-agent-verify.test.mjs`, `verify-report.test.mjs`                                 |

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
