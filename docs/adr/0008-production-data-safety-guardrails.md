# 0008 — Production Data Safety Guardrails

- **Status**: Accepted
- **Date**: 2026-03-07
- **Authors**: Jakub, Claude

## Context

Drafto stores real user data in a production Supabase project. Two Supabase projects provide dev/prod isolation (ADR-0006) and RLS policies protect all tables, but there are no automated safeguards to prevent accidental destructive operations against the production database. A single mistake — wrong `supabase db push` target, a destructive migration, or `db reset` on prod — could cause irreversible data loss.

As the app grows and more migrations are applied, the risk of an accidental destructive operation increases. We need layered defenses that catch mistakes at multiple stages of the workflow.

## Decision

Implement layered production data safety guardrails:

1. **Migration safety script** (`scripts/check-migration-safety.sh`) — a shell script that scans `supabase/migrations/*.sql` for destructive SQL patterns (DROP TABLE without IF EXISTS, TRUNCATE, DELETE without WHERE, DROP SCHEMA). Errors block CI; warnings are informational. Lines can be suppressed with `-- safety:ignore`.

2. **CI integration** — the migration safety script runs as a step in the `lint-and-typecheck` CI job, blocking any PR with unreviewed destructive migrations.

3. **CLAUDE.md rules** — explicit instructions for Claude Code sessions: never run destructive SQL against prod, always verify the linked Supabase project ref before `db push`, require explicit user confirmation for any production database operation, and follow dev-first migration workflow.

4. **Persistent memory** — Claude Code memory file with production safety checklist, standard migration flow, rollback procedures, and emergency recovery steps.

## Consequences

- **Positive**: Multiple layers of defense catch destructive operations at different stages (authoring, CI, deployment). Clear documentation reduces human error. Migration safety script provides fast feedback during development.
- **Negative**: Slight overhead from running the safety script in CI (negligible — it's a fast shell script). Developers must add `-- safety:ignore` for intentional destructive operations, which adds friction (this is by design).
- **Neutral**: The safety script uses pattern matching, not SQL parsing, so edge cases in complex SQL may not be caught. This is acceptable as a first line of defense alongside code review.

## Alternatives Considered

1. **SQL parser-based linting** (e.g., sqlfluff, squawk) — more accurate but heavier dependency. Could be added later alongside the pattern-based script. Rejected for now to keep the toolchain simple.
2. **Supabase branch databases** — would provide isolated environments per PR. Not yet available for self-hosted or all plans. Can be adopted when available.
3. **Pre-push git hook for migrations** — would catch issues locally but is easier to bypass (--no-verify). CI integration is more reliable.
