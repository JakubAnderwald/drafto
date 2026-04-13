# Drafto — Claude Code Memory

## Production Safety Checklist

Before ANY production database operation:

1. Verify linked project: `supabase projects list` — confirm ref `tbmjbxxseonkciqovnpl` (prod) vs `huhzactreblzcogqkbsd` (dev)
2. Apply migrations to dev first, verify, then prod
3. Ask user for explicit confirmation before production operations — state target project, operation, and affected data
4. Run `pnpm migration:check` before pushing migration PRs
5. NEVER run `supabase db reset` against production

## Standard Migration Flow

1. Write migration in `supabase/migrations/`
2. Run `pnpm migration:check` to scan for destructive patterns
3. Link dev: `pnpm supabase:link:dev`
4. Push to dev: `pnpm supabase:push`
5. Verify on dev environment
6. Link prod: `pnpm supabase:link:prod` (requires user confirmation)
7. Push to prod: `pnpm supabase:push` (requires user confirmation)

## Rollback Procedures

- Supabase migrations are forward-only — no built-in rollback
- To reverse a migration: create a new migration that undoes the changes
- Supabase daily backups available; Pro plan enables PITR (Point-in-Time Recovery)
- For emergency recovery: enable maintenance mode, restore from backup/PITR, verify data, redeploy

## Known Risks

- `supabase db reset` drops and recreates the entire database — NEVER on prod
- `security definer` functions bypass RLS — review carefully
- CASCADE on foreign keys can cause unexpected data deletion
- DROP TABLE/COLUMN is irreversible without backups

## Project Structure Notes

- Two Supabase projects: prod (`tbmjbxxseonkciqovnpl`) and dev (`huhzactreblzcogqkbsd`)
- Migration safety script: `scripts/check-migration-safety.sh`
- ADRs in `docs/adr/` — append-only, never delete

- [Desktop Phase 3 E2E testing](project_desktop_phase3_e2e.md) — runtime fix + E2E in progress
- [Desktop crash fix + content format](project_desktop_crash_fix.md) — nil crash fix, BlockNote/TipTap bridge, codegen patching
- [SDLC improvements](feedback_sdlc_improvements.md) — branch early, auto-save safety, local testing, pnpm patch, review follow-ups
- [Google OAuth Client IDs](reference_google_oauth_client_ids.md) — Web, iOS, Android client IDs for Drafto
