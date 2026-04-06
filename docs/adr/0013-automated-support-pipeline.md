# 0013 — Automated Support Pipeline

- **Status**: Accepted
- **Date**: 2026-03-16
- **Authors**: Jakub Anderwald

## Context

Support emails arrive at support@drafto.eu and need to be processed into code changes (bug fixes, feature requests). Dependabot PRs also accumulate and require regular triage — minor/patch updates can be auto-merged when CI passes, while major bumps need human review. Handling both manually is time-consuming and delays responses.

A fully automated pipeline is needed that converts support emails into GitHub issues and then processes those issues (and Dependabot PRs) into actionable PRs with minimal human intervention.

## Decision

Implement a two-stage nightly pipeline:

1. **Stage 1 — Email to Issues (23:00 daily)**: A Google Apps Script watches support@drafto.eu, extracts email content, and creates GitHub issues with the `support` label via the GitHub API.

2. **Stage 2 — Issue & PR Processing (00:03 daily)**: A macOS launchd job runs `scripts/nightly-support.sh`, which invokes Claude Code with `--dangerously-skip-permissions` to (see [Scheduler Runbook](#scheduler-runbook) below):
   - **Dependabot PRs**: Auto-merge minor/patch updates with passing CI, close failing PRs with explanations, flag major version bumps with `needs-review` label.
   - **Support issues**: Validate sender (allowlist: jakub@anderwald.info, joanna@anderwald.info), create worktree branches, implement fixes/features following CLAUDE.md guidelines, run lint/typecheck/tests, open PRs referencing the issue, and comment back.

3. **Stage 3 — Nightly Audit (05:00 daily)**: A pure bash script (`scripts/nightly-audit.sh`) runs after the nightly processing completes. It checks:
   - **Issue creation health**: Attachment upload failures, unrecognized senders (`needs-triage`)
   - **Nightly script results**: Log errors, completion status, `needs-manual-intervention` issues
   - **PR/merge health**: Main branch CI status after overnight merges, bot-processed PRs with failing CI
   - **Build/deploy health**: Fastlane build failure patterns, per-platform build results
   - **App health**: `drafto.eu` HTTP health check, GitHub Actions status on main

   If any problems are found, it creates a single GitHub issue with the `nightly-audit` label summarizing all findings. Runs via `~/Library/LaunchAgents/eu.drafto.nightly-audit.plist`.

GitHub labels coordinate the workflow: `support`, `needs-triage`, `needs-review`, `needs-manual-intervention`, `needs-migration-review`, `nightly-audit`.

Safety constraints:

- Never push directly to main — always branches and PRs.
- Never modify production data or run database migrations automatically.
- If database changes are needed, create the migration file but add `needs-migration-review` and comment that manual deploy is required.
- If stuck, add `needs-manual-intervention` and comment with the problem.

## Consequences

- **Positive**: Support requests get automated PR responses overnight. Dependabot PRs are triaged automatically, reducing maintenance burden. Sender allowlist prevents unauthorized access. Safety constraints prevent production incidents.
- **Negative**: `--dangerously-skip-permissions` grants broad access to the Claude Code agent — the allowlist and constraints mitigate but don't eliminate risk. The pipeline can only handle issues within Claude Code's capability; complex architectural changes will still need manual intervention.
- **Neutral**: Logs are written to `$REPO_ROOT/logs/` (git-ignored). The launchd job runs at 00:03, giving the Apps Script stage (23:00) time to create issues before processing begins.

## Scheduler Runbook

The Stage 2 launchd job is defined as code below. To set up or recover the scheduler on a new machine:

### Plist Template

Install to `~/Library/LaunchAgents/eu.drafto.nightly-support.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>eu.drafto.nightly-support</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/ABSOLUTE/PATH/TO/drafto/scripts/nightly-support.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>0</integer>
        <key>Minute</key>
        <integer>3</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/drafto-nightly-support.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/drafto-nightly-support.stderr.log</string>
    <!-- launchd does NOT expand $HOME — replace /Users/YOUR_USERNAME with your actual home directory -->
    <!-- The script also exports PATH="$HOME/.local/bin:$PATH" as a belt-and-suspenders measure -->
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

> Replace `/ABSOLUTE/PATH/TO/drafto` with your local absolute repo path.

### Audit Plist Template

Install to `~/Library/LaunchAgents/eu.drafto.nightly-audit.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>eu.drafto.nightly-audit</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/ABSOLUTE/PATH/TO/drafto/scripts/nightly-audit.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>5</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/ABSOLUTE/PATH/TO/drafto/logs/launchd-audit-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/ABSOLUTE/PATH/TO/drafto/logs/launchd-audit-stderr.log</string>
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

### Bootstrap / Reload Commands

```bash
# Install (first time)
cp eu.drafto.nightly-support.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/eu.drafto.nightly-support.plist

# Reload after changes
launchctl unload ~/Library/LaunchAgents/eu.drafto.nightly-support.plist
launchctl load ~/Library/LaunchAgents/eu.drafto.nightly-support.plist

# Same for audit agent
launchctl load ~/Library/LaunchAgents/eu.drafto.nightly-audit.plist

# Verify both are registered
launchctl list | grep eu.drafto

# Manual trigger for testing
launchctl start eu.drafto.nightly-support
launchctl start eu.drafto.nightly-audit
```

### File Ownership & Permissions

```bash
chmod 644 ~/Library/LaunchAgents/eu.drafto.nightly-support.plist
chmod 755 scripts/nightly-support.sh
# The plist and script must be owned by the current user (not root)
```

### Monitoring

- Nightly support logs: `$REPO_ROOT/logs/nightly-YYYY-MM-DD.log`
- Nightly audit logs: `$REPO_ROOT/logs/audit-YYYY-MM-DD.log`
- Launchd stdout/stderr: `$REPO_ROOT/logs/launchd-{stdout,stderr}.log` (support), `$REPO_ROOT/logs/launchd-audit-{stdout,stderr}.log` (audit)
- If a job fails to run, check `launchctl list | grep eu.drafto` for exit status
- Owner: Jakub Anderwald (jakub@anderwald.info)

### Dependabot CI Secrets

GitHub does not expose repository secrets to `pull_request` events triggered by Dependabot. This causes SonarCloud analysis and E2E tests to fail on every Dependabot PR. Mirror the required secrets as [Dependabot secrets](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/configuring-access-to-private-registries-for-dependabot#storing-credentials-for-dependabot-to-use) (Settings → Secrets and variables → Dependabot):

| Secret                          | Source                                                |
| ------------------------------- | ----------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | `apps/web/.env.local`                                 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `apps/web/.env.local`                                 |
| `E2E_TEST_EMAIL`                | `apps/web/.env.local`                                 |
| `E2E_TEST_PASSWORD`             | `apps/web/.env.local`                                 |
| `SONAR_TOKEN`                   | SonarCloud dashboard (My Account → Security → Tokens) |

These must be kept in sync with the corresponding repository secrets. If a secret is rotated, update both the repo secret and the Dependabot secret.

## Alternatives Considered

- **Claude Cloud (MCP-based)**: Would avoid local machine dependency, but lacks access to local tooling (pnpm, Node.js, project worktrees) needed for building, testing, and pushing code.
- **GitHub Actions**: Running Claude Code inside a GitHub Action would create a recursive CI problem — the agent triggers CI by pushing PRs, which could trigger the agent again. Also, Actions minutes are limited and expensive for long-running agent sessions.
