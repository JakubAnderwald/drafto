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

2. **Stage 2 — Issue & PR Processing (00:03 daily)**: A macOS launchd job runs `scripts/nightly-support.sh`, which invokes Claude Code with `--dangerously-skip-permissions` to:
   - **Dependabot PRs**: Auto-merge minor/patch updates with passing CI, close failing PRs with explanations, flag major version bumps with `needs-review` label.
   - **Support issues**: Validate sender (allowlist: jakub@anderwald.info, joanna@anderwald.info), create worktree branches, implement fixes/features following CLAUDE.md guidelines, run lint/typecheck/tests, open PRs referencing the issue, and comment back.

GitHub labels coordinate the workflow: `support`, `needs-triage`, `needs-review`, `needs-manual-intervention`, `needs-migration-review`.

Safety constraints:

- Never push directly to main — always branches and PRs.
- Never modify production data or run database migrations automatically.
- If database changes are needed, create the migration file but add `needs-migration-review` and comment that manual deploy is required.
- If stuck, add `needs-manual-intervention` and comment with the problem.

## Consequences

- **Positive**: Support requests get automated PR responses overnight. Dependabot PRs are triaged automatically, reducing maintenance burden. Sender allowlist prevents unauthorized access. Safety constraints prevent production incidents.
- **Negative**: `--dangerously-skip-permissions` grants broad access to the Claude Code agent — the allowlist and constraints mitigate but don't eliminate risk. The pipeline can only handle issues within Claude Code's capability; complex architectural changes will still need manual intervention.
- **Neutral**: Logs are written to `~/code/drafto/logs/` (gitignored). The launchd job runs at 00:03, giving the Apps Script stage (23:00) time to create issues before processing begins.

## Alternatives Considered

- **Claude Cloud (MCP-based)**: Would avoid local machine dependency, but lacks access to local tooling (pnpm, Node.js, project worktrees) needed for building, testing, and pushing code.
- **GitHub Actions**: Running Claude Code inside a GitHub Action would create a recursive CI problem — the agent triggers CI by pushing PRs, which could trigger the agent again. Also, Actions minutes are limited and expensive for long-running agent sessions.
