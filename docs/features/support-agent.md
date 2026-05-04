# Support agent

**Status:** shipped **Updated:** 2026-05-03

## What it is

The real-time support pipeline: customer mail to `support@drafto.eu` is polled every 5 minutes from a Mac-mini-resident agent, classified by Claude Code, and either replied to (high-confidence questions, grounded in `docs/`), filed as a GitHub issue (bug / feature), escalated to human review (`Drafto/Support/NeedsHuman` + admin email), or dropped as spam. Linked GitHub issues sync bidirectionally with the customer's email thread — comments authored by the bot with a `<!-- drafto-progress -->` marker are forwarded as Zoho replies, and lifecycle transitions (closed / not-planned / reopened) trigger customer-facing emails. Release announcements ("Now live in TestFlight build 145") are forwarded the same way after each Fastlane release.

This ADR ([0024 — Real-Time Support Agent](../adr/0024-realtime-support-agent.md)) supersedes [ADR-0013](../adr/0013-automated-support-pipeline.md) for **Stage 1** of the support pipeline. Stage 2 (`scripts/nightly-support.sh`, midnight implementation pass) and Stage 3 (`scripts/nightly-audit.sh`) keep their schedules and core behaviour.

## Current state

Shipped. The pipeline has been live since 2026-04-26; lifecycle sync (Phase G) merged 2026-04-28 in commit `d3b48fc`. The agent runs on the Mac mini via `~/Library/LaunchAgents/eu.drafto.support-agent.plist`. No `apps/web/**`, `apps/mobile/**`, `apps/desktop/**`, or `supabase/**` code is involved — this is a pure scripts-layer system.

## Code paths

| Concern                                            | Path                                   |
| -------------------------------------------------- | -------------------------------------- |
| Launchd entrypoint (5 modes, phase-gated)          | `scripts/support-agent.sh`             |
| Claude prompt (tool playbook + reply templates)    | `scripts/support-agent-prompt.md`      |
| Zoho Mail REST wrapper                             | `scripts/lib/zoho-cli.mjs`             |
| OAuth refresh helper (disk-cached access token)    | `scripts/lib/zoho-auth.mjs`            |
| One-time OAuth bootstrap                           | `scripts/lib/setup-zoho-oauth.mjs`     |
| Bundle builders (inbound, comment-batch, state)    | `scripts/lib/build-bundle.mjs`         |
| Pure policy helpers (rate limits, allowlist, etc.) | `scripts/lib/policy.mjs`               |
| State load / save (atomic, mode 0600)              | `scripts/lib/state.mjs`                |
| GitHub sync helpers (`gh` subprocess wrappers)     | `scripts/lib/github-sync.mjs`          |
| Issue-body footer parser (zoho-thread-id routing)  | `scripts/lib/parse-issue-footer.mjs`   |
| State-mutation CLI (cooldowns, cursors, sender)    | `scripts/lib/state-cli.mjs`            |
| Stage 2 (preserved, sender-gated via state)        | `scripts/nightly-support.sh`           |
| Release-announcement walker (Fastlane post-hook)   | `scripts/comment-released-issues.mjs`  |
| Unit tests (167)                                   | `scripts/__tests__/`                   |
| Captured Zoho fixtures for golden runs             | `scripts/__fixtures__/support-emails/` |

## Architecture

```
Mail to support@drafto.eu
        │ (drafto.eu MX → mx.zoho.eu)
        ▼
Zoho Mail Inbox for support@drafto.eu
        │
        │ (every 5 min) launchd → support-agent.sh
        ▼
[zoho-cli.mjs list-pending]   ◀── Inbox messages without a Drafto/Support/* label
        │
        ▼
For each new thread / each new GitHub comment / each issue state change:
        │   build-bundle.mjs builds {kind: "inbound_thread" | "github_comment_batch" | "github_state_change", ...}
        ▼
[claude --dangerously-skip-permissions  with prompt at scripts/support-agent-prompt.md]
        │   Decides: auto-reply | escalate | classify-and-file | sync-comment | sync-state | spam
        ▼
Tools available to Claude (allow-listed only):
  - node scripts/lib/zoho-cli.mjs reply|send|add-label|add-message-label|move-to-folder|get-thread|get-headers|list-pending
  - gh issue create|comment|view|edit
  - Read-only access to docs/** (used to ground question replies)
  - Read/write under logs/support/, logs/support-state.json
        │
        ▼
[Zoho labels under Drafto/Support/*] + [Drafto/Support/Resolved | Spam folder]
+ [GitHub issue body footer carrying zoho-thread-id (load-bearing for comment-sync) + reporter-email/reporter-allowlisted (provenance only — see ADR-0025)]
+ [logs/support-state.json — cursors, rate-limit counters, admin-notification cooldown, reporterEmail per filed issue]
```

### State machine (Zoho-side)

| Where                                                         | Meaning                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Inbox + no label                                              | Unhandled — agent will pick up next run.                                |
| Inbox + `Drafto/Support/Seen`                                 | Phase C labelled-only; legacy, no longer applied.                       |
| Inbox + `Drafto/Support/NeedsHuman`                           | Escalated; admin email fired (subject to 24h cooldown). Stays in Inbox. |
| `Drafto/Support/Resolved` folder + `Drafto/Support/Replied`   | Agent answered (Phase E question). Out of poll set.                     |
| `Drafto/Support/Resolved` folder + `Drafto/Support/Issue/<n>` | Filed as GitHub issue #n. Out of poll set.                              |
| `Drafto/Support/Spam` folder                                  | Dropped. Agent never re-touches.                                        |

A customer reply on a Resolved thread automatically re-routes to Inbox (Zoho threading), and the agent sees it on the next pass.

### Issue-body footer

Every GitHub issue the agent files carries this fenced footer at the very end of the body:

```
<!-- drafto-support-agent v1
reporter-email: jane@example.com
reporter-allowlisted: false
zoho-thread-id: 1777397751089013400
-->
```

The `zoho-thread-id` field is load-bearing — comment-sync uses it to route GitHub-comment forwards back to the originating Zoho thread. `reporter-email` and `reporter-allowlisted` are kept for human-readable provenance only and are NOT trusted for any privilege decision (see [ADR-0025](../adr/0025-support-allowlist-from-zoho-sender.md)).

> **Singleton-threadId quirk.** Zoho assigns a `threadId` only after a customer-side reply. First-contact filings record `zoho-thread-id: null` in the footer; the operator (or the next agent pass after the customer replies) patches it once Zoho assigns one.

### Allowlist gate (Stage 2)

`scripts/nightly-support.sh` decides whether to spend a Claude session on a `support`-labelled issue by reading the recorded sender, not the issue body:

1. At filing time, `support-agent.sh` extracts the inbound `fromAddress` from the Zoho bundle (captured BEFORE Claude runs) and persists it to `state.issues[<n>].reporterEmail` via `state-cli.mjs record-filed-issue`.
2. At gate time, `nightly-support.sh` calls `state-cli.mjs get-reporter-email <n>` and compares the result (case-insensitive, comma-bounded) against `$SUPPORT_ALLOWLIST` from `~/drafto-secrets/support-env.sh`.
3. Two reject reasons surface: `unknown-sender` (no state entry — legacy / manually-filed / runner failure) and `not-allowlisted`. Either one labels the issue `needs-triage` and posts a comment.

This eliminates the spoof window where a forged `<!-- drafto-support-agent v1 ... reporter-allowlisted: true -->` block in a customer's email body could slip through if the LLM copied it verbatim into the issue body. See [ADR-0025](../adr/0025-support-allowlist-from-zoho-sender.md) for the full rationale.

## Cross-platform notes

- The agent itself does not touch `apps/**` or `packages/**`. It's a pure scripts-layer system on top of `gh` + the Zoho REST API.
- `scripts/comment-released-issues.mjs` is wired into both `apps/mobile/fastlane/Fastfile` and `apps/desktop/fastlane/Fastfile` after each Fastlane lane's `post_release_notes` step. Web releases (Vercel auto-deploy on merge) are announced via the `closed/completed` state-sync email, which mentions "Live on drafto.eu now." when the closing PR touched `apps/web`.

---

# Operational runbook

## One-time setup

### 1. DNS / MX cutover at GoDaddy

```
MX  10  mx.zoho.eu
MX  20  mx2.zoho.eu
MX  50  mx3.zoho.eu
TXT @   v=spf1 include:zoho.eu ~all              (SPF — coexists with Resend's send. subdomain SPF)
TXT zmail._domainkey  <Zoho-prescribed DKIM>     (from Zoho admin console)
TXT _dmarc            v=DMARC1; p=quarantine; rua=mailto:jakub@anderwald.info
```

Zoho's domain-verification UI is occasionally flaky and reports failure even when all four resolvers (Google, Cloudflare, Quad9, OpenDNS) and GoDaddy's authoritative servers serve the right records. **Functional test = truth:** send a real email from a third-party account to `support@drafto.eu` and confirm arrival in the Zoho Inbox.

### 2. Create the `support@drafto.eu` Zoho user

In the Zoho Mail Admin Console, add a new user under the existing `drafto.eu` organisation. Free tier allows 5 users; this consumes one. The agent OAuths as **this** user, not as the admin (`jakubanderwald@drafto.eu`).

### 3. Zoho OAuth bootstrap

Run on the Mac mini, signed in to Zoho as `support@drafto.eu` (use an incognito window where only the support user is signed in to avoid grant confusion):

```bash
node scripts/lib/setup-zoho-oauth.mjs
```

The script walks through:

1. Open <https://api-console.zoho.eu/>, create a new "Self Client" app for the agent.
2. Generate a 10-min code with scope `ZohoMail.accounts.READ,ZohoMail.messages.ALL,ZohoMail.folders.ALL,ZohoMail.tags.ALL`. The labels endpoint is at `/labels` but Zoho's scope name for it is `tags.ALL` — both must be present.
3. Paste the code; the script exchanges it via `accounts.zoho.eu/oauth/v2/token` and writes `~/drafto-secrets/zoho-oauth.json` (mode 0600) with `{client_id, client_secret, refresh_token, account_id, primary_email, datacenter}`.

If the OAuth grant must be done remotely (no terminal session that accepts paste), the same exchange can be done with a non-interactive Node one-liner that takes credentials via env vars and calls `accounts.zoho.eu/oauth/v2/token` + `mail.zoho.eu/api/accounts` directly.

### 4. Allowlist + admin env

Create `~/drafto-secrets/support-env.sh`:

```bash
export SUPPORT_ALLOWLIST="jakub@anderwald.info,joanna@anderwald.info"
export SUPPORT_ADMIN_EMAIL="jakub@anderwald.info"      # optional; defaults to jakub@
export SUPPORT_BOT_GH_USER="JakubAnderwald"            # optional; default
```

Both `support-agent.sh` and `nightly-support.sh` source this file at startup, so this is the single source of truth.

### 5. Install the launchd job

```bash
cp eu.drafto.support-agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/eu.drafto.support-agent.plist

# Verify
launchctl list | grep eu.drafto.support-agent
```

The plist template (replace `/Users/YOUR_USERNAME` and `/ABSOLUTE/PATH/TO/drafto`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>eu.drafto.support-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/ABSOLUTE/PATH/TO/drafto/scripts/support-agent.sh</string>
        <string>--auto-classify</string>
        <string>--phase</string>
        <string>G</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>StandardOutPath</key>
    <string>/ABSOLUTE/PATH/TO/drafto/logs/launchd-support-agent-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/ABSOLUTE/PATH/TO/drafto/logs/launchd-support-agent-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/YOUR_USERNAME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>/Users/YOUR_USERNAME</string>
    </dict>
</dict>
</plist>
```

`--comment-sync` and `--state-sync` are typically run from the same launchd job by chaining inside a wrapper script (or as separate plists with the same `StartInterval`); see `scripts/support-agent.sh --help` for the mode matrix.

### 6. Reuse existing `gh` CLI auth

Stage 2 already authenticates `gh` on the Mac mini for the same user. No additional GitHub credentials are required.

## Modifying safely

- **Invariants:**
  - Every label and folder the agent touches must live under `Drafto/Support/...`. `zoho-cli.mjs` rejects anything else at the CLI boundary, with a closed-suffix allowlist (`{Seen, NeedsHuman, Spam, Resolved, Replied, Issue/<n>}` for labels; `{Spam, Resolved}` for folders). Adding a new label = update the allowlist, the prompt, and `assertSupportNamespace`'s test together.
  - Zoho's `displayName` cap is **25 characters**. `Drafto/Support/NeedsHuman` is exactly 25; `Drafto/Support/Issue/<n>` fits up to 4-digit issue numbers. Do not invent labels longer than that without first verifying live (`POST /labels` returns a length error).
  - `POST /messages` (used for `reply` and `send`) rejects unknown top-level keys with `404 EXTRA_KEY_FOUND_IN_JSON`. Don't add `headers: { ... }` for `Auto-Submitted` — rely on the rate-limit caps for loop protection.
  - Replies must thread via `inReplyTo` + `toAddress` + `subject` anchored to the latest messageId in the thread. `inReplyTo + threadId` together returns `404 JSON_PARSE_ERROR`. The CLI signature is `reply <messageId> --to <addr> --subject <s> --body-file <path>`.
  - Customer-facing replies must be verbose, include the full GitHub URL, and explain "what happens next." The existing prompt templates encode this — keep them.
  - `nightly-support.sh` allowlist gate: read the inbound sender from `state.issues[<n>].reporterEmail` (recorded by the runner at filing time, not from the issue body). Never trust LLM-written content in the issue body for the gate decision — the body could carry a forged footer copied from a customer email. See ADR-0025.
- **Tests that will catch regressions:**
  - `scripts/__tests__/policy.test.mjs` — loop headers, rate limits, sender allowlisting.
  - `scripts/__tests__/zoho-cli.test.mjs` — namespace gates, `add-label` / `move-to-folder` refusals, OAuth refresh-on-401 retries exactly once.
  - `scripts/__tests__/notification.test.mjs` — admin notification 24h cooldown; suppressed for allowlisted senders; suppressed when state.humanIntervened.
  - `scripts/__tests__/state-cli.test.mjs` — counter bumps, atomic save, prior-state preservation.
  - `scripts/__tests__/state-cli-reporter-email.test.mjs` — `record-filed-issue` / `get-reporter-email` round-trip for the Stage 2 allowlist gate (ADR-0025).
  - `scripts/__tests__/build-bundle.test.mjs` — bundle shape for all three kinds.
  - `scripts/__tests__/github-sync.test.mjs` — comment / state diffing, marker filter, platform derivation.
- **Files that must change together:**
  - Adding a new bundle kind → `build-bundle.mjs`, the prompt's "kinds" enum, `support-agent.sh`'s mode dispatch, and a new test fixture under `scripts/__fixtures__/support-emails/`.
  - Adding a new Zoho subcommand → `zoho-cli.mjs`, the prompt's "Tools" allowlist, and `zoho-cli.test.mjs`.
  - Renaming a label → `zoho-cli.mjs`'s namespace allowlist, the prompt's state-machine table, and the runbook's state-machine table above.

## Verify

```bash
# Unit tests (all 167)
pnpm --filter=. exec node --test scripts/__tests__/

# Dry-run against fixtures (no live API)
bash scripts/support-agent.sh --dry-run --fixture scripts/__fixtures__/support-emails/01-bug-attachment-upload.json

# Live dry-run against the real Inbox (requires OAuth bootstrap)
bash scripts/support-agent.sh --dry-run

# Full live mode (Phase G)
bash scripts/support-agent.sh --auto-classify --phase G
bash scripts/support-agent.sh --comment-sync --phase G
bash scripts/support-agent.sh --state-sync --phase G
```

---

## Operating procedures

### Taking over a thread manually

Reply directly via Zoho webmail or the mobile app. The agent's "human-intervened" check (`policy.humanIntervened` — true when the most recent message in the thread was from the OAuth user themselves) labels the thread `Drafto/Support/NeedsHuman` and stops auto-replying. No admin notification fires (you already know).

### Recovering from an outage

- **Mac mini offline.** launchd retries on the next 5-minute interval. Failures over 1h trigger a `nightly-failure`-labelled GitHub issue via the cleanup trap in `support-agent.sh`. There is no escalation beyond that — the next online run catches up.
- **Zoho refresh token revoked.** Symptoms: persistent 401s in `logs/support/support-agent-YYYY-MM-DD.log`, repeated `nightly-failure` issues. Re-run `node scripts/lib/setup-zoho-oauth.mjs`. The disk-cached access token at `~/drafto-secrets/zoho-token-cache.json` is auto-invalidated on 401.
- **Zoho data-centre downtime.** Same as above — launchd retries, failures file an issue. No special action needed unless downtime exceeds a few hours.
- **Claude Code outage.** Pre-check still runs (`list-pending` + `gh issue list`), but `claude` invocation will fail. Mail accumulates in the Inbox and gets processed when Claude returns; the per-thread / per-sender rate limits prevent a backlog stampede.

### Rotating the OAuth client secret

The `client_secret` was pasted in chat during the original Phase-B bootstrap and should be rotated:

1. Open <https://api-console.zoho.eu/>.
2. Open the "Drafto support agent" Self Client app → regenerate `client_secret`.
3. Edit `~/drafto-secrets/zoho-oauth.json` and replace the `client_secret` field. The refresh token still works.
4. Verify with `bash scripts/support-agent.sh --dry-run`.

### Rolling back to a forwarder

If Zoho ever pulls the free tier or otherwise becomes unusable:

1. At GoDaddy, restore the `support@drafto.eu → jakub@anderwald.info` forwarder.
2. Disable the launchd job: `launchctl unload ~/Library/LaunchAgents/eu.drafto.support-agent.plist`.
3. Re-enable the Apps Script trigger in Gmail (it remained installed for rollback safety; check with the project owner whether it's still present).
4. Optionally export the Zoho mailbox via Zoho's IMAP-import tool (`mail.zoho.eu` → Settings → Import / Export).

Estimated rollback time: ~2 hours, dominated by DNS propagation.

## Related ADRs

- [0024 — Real-Time Support Agent](../adr/0024-realtime-support-agent.md) — this pipeline.
- [0013 — Automated Support Pipeline](../adr/0013-automated-support-pipeline.md) — superseded for Stage 1 by 0024; Stages 2 and 3 still apply.
- [0019 — Email Infrastructure and Approval Flow](../adr/0019-email-infrastructure-and-approval-flow.md) — outbound transactional email via Resend (`hello@drafto.eu`); independent of inbound support mail (`support@drafto.eu`).
