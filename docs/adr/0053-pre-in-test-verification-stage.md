# 0053 — Pre-In-Test Verification Stage (Testing Column)

- **Status**: Accepted
- **Date**: 2026-10-21
- **Authors**: Jakub Anderwald (with Claude Code)

> **Update 2026-10-21 (shell lane)**: Decision 6's "never as text", and the `vercel curl` alternative's "keeps the secret out of the model's hands", describe the lane's ordinary path. The secret is handed to `preview-curl` through a mode-600 curl config, never put in the prompt, the environment or a command line. That isn't a wall. The session runs as the factory's OS user, which also owns the secret file. A session that gets past the guard, with a script it wrote or through the PR's own tests, can read it, just as the implement stage can read every factory secret. A loopback proxy holding the secret in the supervisor's memory was considered and not adopted, because the source file would stay readable. The secret only unlocks this project's protected previews, and it can be regenerated in the Vercel dashboard. A separate OS user or a sandbox would make it a wall; that's a follow-up. See [claude-code-hooks.md](../operations/claude-code-hooks.md#the-verification-lanes-guard).

## Context

**In Test** is the factory's second human gate (ADR-0026): a person tests the change and drags the card to **Approved**. By the time a card gets there, CI is green, the code review has run (ADR-0035), the scenario is written and the betas are on their way (ADR-0030), and since ADR-0051 a browser runner walks the scenario's Web steps on the preview. Everything else in the scenario is still done by hand: the API and MCP checks, the targeted tests, the macOS `--preflight`. The browser run also starts only after the card has already reached the human, so its report often arrives after testing has begun.

Four constraints shape any automated check before In Test:

- **One Chrome call (ADR-0051).** Exactly one kind of claude call may drive Chrome, and it gets no shell or files. A session that both runs commands and drives the operator's signed-in browser isn't allowed.
- **Long work can't block the tick (ADR-0036).** `--watch` runs every 5 minutes under one mutex. Anything that takes minutes has to run detached and be collected on a later tick, as the CodeRabbit CLI lane is.
- **Previews are behind Vercel Authentication.** An unattended `curl` gets a 302 to the SSO page. `vercel curl` gets through by silently creating a bypass secret.
- **The card's slot worktree holds `.env.production` files** (`copy_worktree_env`). A lane that may run model-chosen commands must not work in it.

## Decision

Add a factory-owned **Testing** column between In Review and In Test. With `FACTORY_VERIFY=1`, a converged In Review card goes to Testing instead of In Test. The factory verifies it there, then promotes it to In Test with one deterministic report comment.

1. **Testing is a factory-owned, transient column.** Only the factory moves cards in and out. `--watch` moves a converged card in (`verify_enter`), at the slot where the In Test promotion sits, after the CodeRabbit gate. The revision no-op path also routes there while the commit has no report (`verify_target_status`). The board migration and the `status:testing` label come first: while either is missing, cards go straight to In Test as before.
2. **Evidence never gates (ADR-0035).** The Testing sweep (`verify_sweep`, between the In Review loop and the In Test sweep) asks `scripts/lib/verify-decide.mjs` what each card needs next. A lane's verdict, FAIL included, never changes the answer. The card leaves Testing for In Test when every lane is done, when actionable feedback arrives, or at the hold cap (`FACTORY_VERIFY_HOLD_MAX_MIN`, 60 min), whichever comes first. Actionable feedback comes first: the revision will replace the commit anyway. Otherwise it goes back to In Review only for reasons about the commit: the head moved, required CI is red, the commit wasn't reviewed, or review threads are open (read once CI is green, at most `FACTORY_VERIFY_BOUNCE_MAX` times per commit). A failed column lookup never drains a card already in Testing; only the switch and the canary label decide that. Attempts aren't reset on the way in, so a card that keeps bouncing still runs out of fix budget and ends in Blocked (#463).
3. **The scenario and betas are written at Testing entry.** This amends ADR-0030's timing: they used to come at In Test entry. The lanes run the scenario, so it has to exist first, and native builds start 20 to 60 minutes sooner. The scenario writer gets `stage: "testing"` (the `INTEST_STAGE` env var) and titles the comment "verifying now (Testing)". Its markers are unchanged.
4. **The report is deterministic.** `scripts/lib/verify-report.mjs` composes it with no claude call, so it can't hit a session limit. It scans each lane's text for secrets, withholds that lane on a hit (and fails closed on an unreadable secret file), and defangs every piece of text. bash posts it once per commit (`drafto-factory-verify-sha:<sha>` from the factory's own identity, recorded in `verifyReportSha`) after the move to In Test (ADR-0030's "advance first"). If composing fails, a minimal notice goes out instead. If posting fails, the In Test sweep tries three more times, 10, 20 and 30 minutes after the report was composed.
5. **Two lanes, neither combining shell and Chrome.**
   - The **shell lane** (Wave 5A) is a detached `--no-chrome` claude session with a PreToolUse guard, run like the CodeRabbit CLI lane (ADR-0036): in its own detached worktree, with no `GH_TOKEN` and no state writes, collected by `--watch`. It runs targeted tests, the scenario's command steps and API checks against the preview.
   - The **browser lane** (Wave 5B) is a new `verify` kind of the existing runner. There is still exactly one Chrome call in the factory (ADR-0051).
6. **The bypass secret is adopted, for the shell lane's curl against per-commit previews only.** This amends ADR-0051's rejected alternative. The secret lives in a mode-600 file (`FACTORY_VERIFY_BYPASS_FILE`). The shell lane reaches it only through a curl wrapper that pins the preview origin, never as text. The report scans for its literal and for its header names. It's created in the Vercel dashboard, never with `vercel curl`. The browser lane keeps using the profile's Vercel login.
7. **macOS gets `--preflight` only (ADR-0043).** The shell lane may run the macOS scenarios' `--preflight` checks. A full run stays manual.
8. **Device lanes are deferred.** iOS, Android and macOS runs need dev-backed debug builds of the PR head, a simulator and an emulator, Maestro and a RAM budget. None of these exist unattended yet. The report lists those steps for the human. `docs/features/factory-verification.md` records what a device lane would need.

`FACTORY_VERIFY=0` is the default and the kill switch. With it off, the In Review promotion is unchanged and the Testing sweep only drains: any card found in Testing is promoted with a report whose lanes read "verification is switched off".

## Consequences

- **Positive**:
  - The human gets the evidence, and the list of what's left to do by hand, at the moment the card reaches them, in one comment.
  - Betas start sooner.
  - API and MCP changes get exercised against the real preview before anyone looks at them.
  - The stage can't strand a card: the hold cap bounds it, the sweep runs with verification off, and a broken decision module fails open to promotion.
- **Negative**:
  - A card reaches In Test up to the hold cap later than it would have.
  - The factory now holds a Vercel bypass secret.
  - Two more lanes compete for the Mac mini's RAM with the beta builds. The shell lane runs one at a time, under `nice`, and is deferred under memory pressure.
  - The board has one more column, which the board-migration script had to learn to add without wiping card statuses (Wave 3A).
- **Neutral**:
  - **Privacy policy: no change.** The lanes use only the dedicated dev test account, dev Supabase and per-commit previews. Evidence stays on the Mac mini; only the scanned, defanged report reaches GitHub. No new third-party processor receives user data.
  - The report is posted once per commit. A card handed back and re-verified on the same commit doesn't post a second report.

## Alternatives Considered

- **Block on FAIL (verification as a gate).** A FAIL would send the card back to In Review. Rejected for the reasons in ADR-0035: a model's verdict on its own test run isn't reliable enough to hold a human's card, and a flaky lane would loop the card. Instead, the FAIL is the first thing the human reads.
- **Run the lanes synchronously in the tick.** Simpler, but a 30-minute run would block every other card's CI fixes, reviews and merges for that long (ADR-0036).
- **One combined Chrome+Bash session.** It would cover the web and API steps in one run. Rejected because ADR-0051's central rule is that the session holding the operator's browser has no shell.
- **`vercel curl` for API checks.** It's what the scenario writer tells humans to use. Unattended, it silently creates a bypass secret the factory doesn't control and would print it into the lane's context. The raw curl wrapper with an operator-made secret keeps the secret out of the model's hands.
- **Reuse the card's slot worktree.** It already has `node_modules`. But it also holds `.env.production` files, and `--watch` may edit it at the same time. A fresh detached worktree with no env copy avoids both.
- **Keep the browser run in In Test only (status quo).** The human starts testing before the browser report lands, and nothing covers the API steps.
