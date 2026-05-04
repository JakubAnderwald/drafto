# 0024 — Real-Time Support Agent (Zoho REST + Mac mini)

- **Status**: Accepted (allowlist-gate aspect superseded by [ADR-0025](./0025-support-allowlist-from-zoho-sender.md))
- **Date**: 2026-04-28
- **Authors**: Jakub Anderwald

> **Update 2026-05-03**: The "GitHub issue body footer reads `reporter-allowlisted` to gate auto-implementation" mechanism described under "State storage" point 2 below has been replaced. `nightly-support.sh` now reads the inbound Zoho `fromAddress` from `logs/support-state.json` (recorded by `support-agent.sh` at filing time) — the LLM-written footer is no longer trusted for the allowlist decision. The footer itself stays in the issue body for `zoho-thread-id` comment-sync routing only. See [ADR-0025](./0025-support-allowlist-from-zoho-sender.md).

## Context

[ADR-0013](./0013-automated-support-pipeline.md) defined a three-stage nightly pipeline. **Stage 1** ran a Google Apps Script in a personal Gmail account at 23:00 daily — it pulled messages forwarded from `support@drafto.eu`, filed GitHub issues, and that was the only customer-facing acknowledgement. Two consequences mattered:

- **Customer latency.** Anyone emailing `support@drafto.eu` waited up to 24 hours for any response — even just "we got it." For a small indie product trying to win over early users, that's a poor first impression.
- **Brittleness and opacity.** The Apps Script lived in Gmail script storage, outside the monorepo. It had no version control, no tests, no CI, and no shared review surface. A failure was invisible until someone noticed mail wasn't being processed.

A separate constraint shaped the rewrite: **no new monthly cost.** Drafto runs on free / already-paid-for tiers (see [`CLAUDE.md`](../../CLAUDE.md) → "Infrastructure cost discipline"). Anything we adopted had to fit there.

## Decision

Replace **Stage 1 only** with a Mac-mini-resident, real-time support agent that polls a Zoho-hosted `support@drafto.eu` mailbox every 5 minutes, classifies inbound mail with Claude Code, and syncs bug/feature threads bidirectionally with GitHub issues. Stages 2 (`scripts/nightly-support.sh`) and 3 (`scripts/nightly-audit.sh`) are preserved unchanged in schedule and core behaviour — Stage 2 gains four small edits to read a new footer, defend the allowlist, and emit progress comments.

Concretely:

### 1. Mailbox layer — Zoho Mail Forever Free

`drafto.eu`'s MX records were moved (at GoDaddy) to point at `mx.zoho.eu` / `mx2.zoho.eu` / `mx3.zoho.eu`. A dedicated `support@drafto.eu` user was created in the existing `drafto.eu` Zoho organisation (free tier, EU data centre). The agent OAuths as that user via the Zoho Mail REST API; revoking the agent's tokens never touches the human admin's mail.

### 2. Agent runtime — launchd + Claude Code on the Mac mini

- `~/Library/LaunchAgents/eu.drafto.support-agent.plist` schedules `scripts/support-agent.sh` every 5 minutes.
- The script holds a PID-file lock (`logs/support-agent.lock`), runs a cheap pre-check (Zoho `list-pending` + `gh issue list --label support`), and only invokes `claude --dangerously-skip-permissions` when there's actual work — so the Claude API quota burns only on demand.
- The bash entrypoint runs in one of five modes: `--dry-run`, `--label-only`, `--auto-classify`, `--comment-sync`, `--state-sync`. A `--phase D|E|F|G` flag gates which actions Claude is allowed to take, matching the rollout plan.

### 3. State storage — Zoho labels + GitHub issue footer + state JSON

No database. Three layers, all already free:

1. **Zoho labels and folders** form the per-thread state machine, all under the `Drafto/Support/...` namespace (the CLI rejects anything else):
   - Inbox + no label = unhandled, agent will pick it up.
   - Inbox + `Drafto/Support/NeedsHuman` = agent escalated, waiting for human review.
   - `Drafto/Support/Resolved` folder + `Drafto/Support/Replied` = agent answered; out of Inbox, out of agent's poll set. A customer reply automatically re-routes to Inbox via Zoho threading.
   - `Drafto/Support/Resolved` folder + `Drafto/Support/Issue/<n>` = filed as GitHub issue #n.
   - `Drafto/Support/Spam` folder = dropped, never re-touched.
2. **GitHub issue body footer** carries customer linkage in a fenced block the agent always writes:
   ```
   <!-- drafto-support-agent v1
   reporter-email: jane@example.com
   reporter-allowlisted: false
   zoho-thread-id: 1777397751089013400
   -->
   ```
   `nightly-support.sh` reads `reporter-allowlisted` to decide whether to auto-implement. The allowlist is double-checked against `SUPPORT_ALLOWLIST` so a tampered issue body can't smuggle past the gate.
3. **`logs/support-state.json`** (gitignored, mode 0600) tracks per-issue cursors (`lastGithubCommentSyncAt`, `lastIssueStateSync`, `lastKnownState`), per-thread and per-sender rate-limit counters, the daily auto-reply cap, and the admin-notification cooldown.

### 4. Bidirectional GitHub sync

- **Email → GitHub:** Claude classifies inbound. For `bug` / `feature` it runs `gh issue create --label support`; the customer gets a "Filed as #N — `https://github.com/JakubAnderwald/drafto/issues/N`" acknowledgement and the thread is labelled `Drafto/Support/Issue/<n>` and moved to Resolved.
- **GitHub comments → email:** every run, `--comment-sync` lists support-labelled issues with comments newer than the per-issue cursor, filters out the bot user (default `JakubAnderwald`), keeps only progress-marker comments authored by the bot (`<!-- drafto-progress -->`), and forwards each as a Zoho reply with a "From #N on GitHub:" preamble.
- **GitHub state changes → email:** every run, `--state-sync` diffs each support issue's `{state, state_reason}` against `state.issues[<n>].lastKnownState`. Three transitions trigger a customer email — `closed/completed` ("we've fixed this"), `closed/not_planned` or `closed/duplicate` ("won't be implementing this; reason: …"), and `reopened` ("looking at this again"). Bootstrap on first sight records state silently to avoid retroactive emails.
- **Release announcements:** `scripts/comment-released-issues.mjs` runs after each Fastlane release; it walks merged-PR commit bodies since the last `mobile@*` / `desktop@*` tag, extracts `Closes/Fixes/Resolves #N` references, and posts "Now live in &lt;track&gt;." per released support issue. The comment-sync forwarder picks these up on its next pass.

### 5. Auto-reply policy

Auto-reply only when **all** hold:

- `intent === "question"` with confidence ≥ 0.85 (Phase E+) **or** an acknowledgement reply on a freshly filed `bug` / `feature` issue (Phase F+).
- Inbound lacks `Auto-Submitted: auto-replied` / `Precedence: bulk` / DSN markers.
- Per-thread (≤3/24h), per-sender (≤5/1h), and global (≤100/day) rate-limit caps pass.
- Customer email is not in `noreply@*` / `mailer-daemon@*` / `postmaster@*`.
- The most recent message in the thread was not from the agent's OAuth user themselves — i.e. the human admin hasn't replied directly via Zoho webmail.

For `question` intent, the prompt requires the agent to `Grep` / `Read` under `docs/features/`, `docs/architecture/`, and `docs/operations/` before drafting, and to escalate (label `NeedsHuman`, leave in Inbox, fire admin notification) rather than guess if `docs/` doesn't cover the question.

Customer-facing replies are verbose, multi-paragraph, and always include the full GitHub issue URL when one exists — see `scripts/support-agent-prompt.md` for the templates.

### 6. Stage 2 contract preserved

When `jakub@anderwald.info` or `joanna@anderwald.info` email `support@drafto.eu` with a bug or feature, the chain is now: real-time issue creation + acknowledgement (this agent) → midnight implementation (existing `nightly-support.sh`). The allowlist source of truth moved from Apps Script into one shell line at `~/drafto-secrets/support-env.sh`, sourced by both `support-agent.sh` and `nightly-support.sh`.

## Consequences

**Positive**

- Customers get a reply within 5 minutes instead of 24 hours, with a clickable GitHub URL and an explicit "what happens next."
- The entire pipeline lives in the monorepo: shell + Node CLI + prompt MD, all version-controlled, tested (167 unit tests), and reviewable in PRs.
- Failures file `nightly-failure`-labelled GitHub issues via the same trap mechanism as `nightly-support.sh`, so outages are visible.
- The mailbox is on a dedicated user — token revocation never touches the human admin's mail. There is no path from the agent's credentials to `jakub@anderwald.info`.
- Lifecycle sync closes the loop: the customer hears about start-of-work, PR-in-review, fix-merged, and release-shipped without anyone composing those emails.

**Negative**

- Adds one external surface (Zoho Mail Free) with its own outage modes and a documented "free-tier withdrawal" risk. Mitigated by an export-and-rollback runbook ([`docs/features/support-agent.md`](../features/support-agent.md) → "Rolling back to a forwarder").
- The agent runs `claude --dangerously-skip-permissions` against a constrained tool list. The constraint is enforced by the prompt and by the CLI namespace checks (`Drafto/Support/...` only) — not by an OS sandbox. Treat any leak from a customer message body as untrusted and rely on the XML-tagged input fence in the prompt.
- Zoho's REST API surface is undocumented in places (label-name length cap, scope-name vs endpoint-name mismatch, message-body-key strictness on `POST /messages`). Several quirks are encoded in `zoho-cli.mjs`; expect to read the comments before extending it.
- A second launchd job is now load-bearing on the Mac mini. Mac-mini downtime delays customer replies by however long the box is offline.

**Neutral**

- The OAuth refresh token at `~/drafto-secrets/zoho-oauth.json` is the single authentication surface. Rotating it requires re-running `scripts/lib/setup-zoho-oauth.mjs` and pasting a fresh grant code; documented in the runbook.
- State lives in Zoho labels / folders + GitHub issue bodies + `logs/support-state.json`. There is no admin web UI — administrative intervention happens by replying directly via Zoho webmail or the mobile app, which the agent detects ("human intervened") and steps back from.
- Customer threading is RFC 5322-driven (`In-Reply-To` + `References`); we observed Zoho occasionally spawns a fresh server-side `threadId` for outbound, but customer mail clients group correctly. Don't trust `messages/view?threadId=` to enumerate self-authored outbound.

## Alternatives Considered

- **Keep the Apps Script with a tighter cadence.** Apps Script triggers run at most every minute, but the script remained out-of-repo and brittle, and it offered no path to bidirectional GitHub sync. A 5-minute REST poll on a real mailbox is cheaper to operate and far easier to evolve.
- **Inbound webhook (Zoho push or a third-party catcher).** Would require public ingress on the Mac mini (port forwarding / tunnel) or a paid catcher. Both violate the no-cost rule and complicate the threat model for no perceptible UX win at our scale (5-minute polling is "near-real-time" enough).
- **Postmark / SES / Mailgun inbound.** All viable. All paid past trivial volume. Zoho's Forever Free tier covers the workload at zero cost and gives us an EU-resident mailbox to match `drafto.eu`'s data residency story.
- **Run the agent on Vercel cron.** Vercel cron has a free tier, but every invocation would need to ship the Zoho refresh token + GitHub PAT to a serverless function and the agent itself runs Claude Code locally on the Mac mini already. Centralising the secrets there avoids a second set of rotated credentials.
- **GitHub Actions workflow.** Same trade-off as ADR-0013 — recursive CI surface (the agent files PRs, which trigger Actions, which could trigger the agent), and Actions minutes are limited and expensive for long-running Claude sessions.
- **Forward `support@drafto.eu` into a personal Gmail and keep the Apps Script.** The current state. Re-anchoring the mailbox at Zoho costs a one-afternoon DNS change and removes the personal-inbox blast-radius risk entirely.

## Related

- `scripts/support-agent.sh` — launchd entrypoint with five modes (`--dry-run`, `--label-only`, `--auto-classify`, `--comment-sync`, `--state-sync`).
- `scripts/support-agent-prompt.md` — Claude's tool playbook + reply templates + phase gate.
- `scripts/lib/zoho-{cli,auth}.mjs` — Zoho Mail REST wrapper + OAuth refresh helper.
- `scripts/lib/{state,policy,build-bundle,github-sync,parse-issue-footer,state-cli}.mjs` — pure helpers and CLI bridges that back the bash entrypoint.
- `scripts/lib/setup-zoho-oauth.mjs` — interactive bootstrap for `~/drafto-secrets/zoho-oauth.json`.
- `scripts/comment-released-issues.mjs` — release-announcement walker, called from both Fastfiles after `post_release_notes`.
- `scripts/nightly-support.sh` — Stage 2 (preserved); now sources `~/drafto-secrets/support-env.sh`, gates on the issue-body footer, and emits progress comments at start / PR-open / blocker.
- [`docs/features/support-agent.md`](../features/support-agent.md) — operational runbook (DNS / MX, OAuth setup, taking over a thread, rollback).
- [`docs/adr/0013-automated-support-pipeline.md`](./0013-automated-support-pipeline.md) — superseded by this ADR for Stage 1; Stages 2 and 3 still apply.
