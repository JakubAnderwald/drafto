# 0051 — Factory Browser Access Through a Locked-Down Claude in Chrome Runner

- **Status**: Accepted
- **Date**: 2026-10-17
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

The dark factory can't look at a web page. The In Test scenario writer has no network access, and the revision prompt tells Claude to skip any step that means "looking at a preview in a browser". So a web card reaches the In Test gate without anyone having opened it in a browser, and a "run the test scenario for me" comment comes back with the web steps skipped. macOS already has hands-off In Test runs ([ADR-0043](./0043-automated-macos-in-test-scenarios.md)). Web had nothing like it.

Claude Code can drive Chrome through the Claude in Chrome extension (`claude --chrome`). The Mac mini that runs the factory has Chrome with the extension paired (device `9796912b-…`, "mac mini"). The same account also has the operator's MacBook Chrome connected, and the factory must never drive that one.

The operator chose to use the Mac mini's **existing, personal** Chrome profile, which is signed in to Google, GitHub, Vercel and drafto.eu, over a dedicated profile. They also chose to reach Vercel previews, which sit behind Vercel Authentication, through that profile's Vercel session rather than with a bypass secret. Both choices make what the agent may do in the browser the central risk.

A spike on the Mac mini (Claude Code 2.1.302, extension 1.0.101, 2026-10-17) measured the constraints:

- **Chrome tools load only with the flag.** A plain `claude -p` loads none; `--chrome` loads 22. A plain run does connect the claude.ai connectors (Gmail, Drive, Calendar…), which is a separate issue.
- **The extension is not a boundary.** It isolates each session in its own tab group, so a session can't see the operator's other tabs. But its own site permissions did not stop navigation to an arbitrary site in this mode.
- **Hooks and permissions work in this mode.** `--permission-mode dontAsk --tools "" --allowedTools <chrome tools>` gives a session with Chrome and nothing else. Tools not on the allowlist are denied, and `permissions.deny` removes a tool entirely. `--settings` hooks fire on Chrome tools, and a PreToolUse exit 2 blocks the call.
- **A bad settings file is dropped silently.** `claude -p` skips a settings file that fails validation and runs without its hooks, with no error.
- **Some hook failures are silent.** A PreToolUse hook that runs past its `timeout` is treated as allow: the call runs. And a Chrome call that returns an error fires neither PostToolUse nor PostToolUseFailure.
- **Tool responses report tab URLs.** Every Chrome tool response lists each tab in the session's group with its current URL. That's how a hook can see where a click ended up.
- **The Vercel session works.** A per-commit preview host (`https://drafto-<hash>-jakubanderwalds-projects.vercel.app`) loads directly through the profile's login.

The code-writing stages (`--implement`, `--watch`) run with `--dangerously-skip-permissions`, full Bash and file access, and ultracode background agents. If those sessions could drive Chrome, a confused or prompt-injected run could edit the guard, slip past it, or post what it saw through `gh`, all while signed in as the operator.

## Decision

**Exactly one kind of claude call gets Chrome: a locked-down browser runner.** Every other claude call in the factory, the support agent and the nightly runner passes `--no-chrome` explicitly. Implementation: `run_browser_task` in `scripts/factory-agent.sh`, `scripts/lib/browser-guard.mjs`, `scripts/lib/browser-report.mjs`, `scripts/lib/browser-health.mjs`, `scripts/factory-browser-prompt.md`.

1. **The runner has no tools but Chrome.** It runs as `claude -p --chrome --permission-mode dontAsk --tools "" --setting-sources "" --strict-mcp-config` with an allowlist of 14 Chrome tools, from an empty working directory outside the repo:
   - `switch_browser`, `javascript_tool`, `file_upload`, `upload_image`, `shortcuts_*`, `gif_creator` and `browser_batch` are left out of the allowlist and also listed in `permissions.deny`.
   - That means no Bash, no files, no `gh` and no subagents. The runner can only drive the browser and print.
   - No user, project or local settings load (so no plugins, their hooks, or the operator's `CLAUDE.md`), and no MCP server except the built-in `claude-in-chrome`. The claude.ai connectors aren't in the session at all. The guard's `--settings` file still loads; a spike confirmed this.
2. **A guard hook enforces the limits the prompt can't.** `browser-guard.mjs` is generated into a `--settings` file by one tested function, with absolute paths and a `|| exit 2` fail-closed wrapper. Its rules:
   - **Select gate.** Every tool except listing and selecting browsers is denied until a successful `select_browser` on the pinned device has been recorded. Otherwise a lone connected MacBook would be used automatically.
   - **Own tabs only.** A tool may act only on a tab seen in this session's own group.
   - **Exact-origin navigation.** `navigate` accepts only the run's target origin.
   - **Quarantine.** A tab whose reported URL has drifted off that origin can only be closed or navigated back.
   - **Keyboard and modifiers.** `computer` key presses must be on a short allowlist: Enter, Tab, Escape, arrows, editing keys, single characters, and select-all. No other chord and no function key gets through, so nothing like `cmd+L` or `F6` can reach the omnibox. Any action with `modifiers` is denied, because a modified click opens tabs the guard doesn't track.
   - **Evidence.** Screenshots are copied into the run's evidence directory.
   - **Logging.** Every decision goes to `logs/factory/browser-guard/<session>.jsonl`.
   - **A stalled hook blocks.** The pre hook runs under a perl `alarm` well inside its timeout, so a hung guard is killed and blocks rather than timing out into an allow. A post hook marks itself in flight while it runs, and pre denies every call while such a marker exists. A post that died before updating state (and with it a quarantine) therefore stops the session instead of leaving a stale URL behind.
3. **A missing guard turns the runner off.** The guard writes a SessionStart record. If a session ran (its transcript exists) without that record, the settings didn't load. The runner then stays off until an operator runs `factory:browser-reset`. A `claude` that never started a session, say after a CLI update rejects a flag, counts as an ordinary error.
4. **Only bash posts.** It parses the runner's output (`<<<REPORT … REPORT>>>` plus a `browser=… verdict=…` status line) and scans it for the test password, JWTs, Supabase auth cookies, bearer and OAuth tokens and Vercel cookies. If any match, it posts a "report withheld" notice instead of the report.
5. **The target is the per-commit preview from the Deployments API.** It is the `vercel[bot]` deployment for exactly the head SHA, never a URL scraped from PR comments, and `drafto.eu` is never a target. The runner signs in as a dedicated test account in the **dev** Supabase project, whose credentials live in a mode-600 file on the Mac mini. The prompt goes to the runner on stdin, so the password never appears in argv.
6. **The first use is the In Test web run, and it only reports.**
   - **Candidates.** The `--watch` In Test sweep collects them: a web diff, no pending revision, and the factory's own OWNER-posted scenario for the head SHA (not the fallback).
   - **When it runs.** A new `--browser` mode runs after `--release`, so a Chrome session never delays a merge. It re-checks each candidate against the board and runs at most one per tick, once a successful preview exists.
   - **What's posted.** The runner runs the scenario's `### Web` section. For a completed or `blocked` run, bash posts one comment with the `drafto-factory-browser-report` and `drafto-factory-browser-run-sha:<sha>` markers. A run with no status line posts nothing.
   - **What it never does.** It never moves the card and never spends the retry budget.
   - **Attempts.** Each SHA gets two attempts. A run that fails on the browser's side gives its attempt back: unavailable, an expired login, the guard not loading, or a session limit. A timeout or an error keeps it, so a hanging runner can't run every tick.
7. **Health is soft.** A preflight checks that Chrome is running, the account file is valid, and the runner isn't disabled. Results go to `browser-health.mjs`, which emails the operator after two bad results in a row and again on recovery. It never pauses the factory.
8. **It's off by default.** `FACTORY_BROWSER=0` is the master switch, and `FACTORY_BROWSER_KINDS` picks the uses. The UI check in `--watch`, answering "run it for me" comments, and reproducing bugs at plan time follow in later PRs as further kinds of the same runner.

## Consequences

- **Positive:**
  - Web cards reach the In Test gate with a real browser run of their scenario on the commit's own preview, evidence for each step, and screenshots on the Mac mini.
  - The agent that has Chrome has nothing else. A prompt injection through a page or a scenario can at worst steer clicks on the preview's own origin, and anything it prints passes the secret scan before it leaves the Mac mini.
  - Making `--no-chrome` explicit removes any dependence on the CLI default and on `claudeInChromeDefaultEnabled`, which is on on this machine.
- **Negative:**
  - The runner acts inside the operator's real Chrome profile. A click on an in-page link can still take a tab off-origin for one action before the next tool response reveals it and the guard quarantines the tab. The extension's site permissions don't catch it. This is the accepted residual risk of the personal-profile choice.
  - The runner depends on the Mac mini's Chrome running, the extension staying signed in, and the profile's Vercel session staying valid. Each failure degrades to "no report" plus one email.
  - Tabs from a runner killed mid-run stay open in an orphaned tab group.
  - Untested: whether Tab past a page's last focusable element moves focus into Chrome's own toolbar. Tab is allowed, because forms need it. It would only matter if the extension's synthetic keys reach browser UI at all, which the keyboard rule already assumes the worst about.
  - Screenshots stay on the Mac mini. The repo is public, so they are never attached to GitHub.
  - Untested as of this ADR: runs with the display asleep or locked, and signing in with the dev test account, which still has to be created.
- **Neutral:**
  - The In Test gate stays human. The report is evidence for the person approving, not a gate.
  - The runner uses the plan-tier effort (`FACTORY_PLAN_EFFORT`) and the shared Claude subscription. Its wall cap is `FACTORY_BROWSER_TIMEOUT_SEC` (default 900 s).

## Alternatives Considered

- **Give `--chrome` to every stage.** This is closest to "the implementer checks its own UI". Rejected: those sessions have Bash and file access under `--dangerously-skip-permissions`, so the guard would only catch mistakes. Nothing would stop a misbehaving run from editing the guard or posting what it saw. Every use goes through the runner instead.
- **A dedicated Chrome profile with no sign-ins.** It would make an off-origin click harmless. The operator chose the existing profile, so it isn't pursued now. It remains the upgrade if the residual risk above stops being acceptable: the device-id knob and the guard carry over unchanged.
- **Vercel "Protection Bypass for Automation" secret.** It needs no Vercel session in the browser, but it adds a secret that must never reach a public comment. The operator chose the profile's own Vercel login.
- **Playwright with headless Chromium.** It would be fully isolated and scriptable, but it needs a scripted scenario per card rather than the Claude-written prose scenario. It also can't get past Vercel SSO without a bypass secret, and it isn't the "Chrome" capability asked for. The repo's Playwright E2E suite stays the CI regression suite.
- **Rely on the extension's site permissions as the boundary.** The spike showed they don't stop navigation in this mode.
