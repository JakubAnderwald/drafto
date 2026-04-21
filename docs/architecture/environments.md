# Environments

Drafto runs against two Supabase projects with full data isolation between production and everything else. This doc consolidates the environment rules from [`CLAUDE.md`](../../CLAUDE.md) and the README. The underlying decision is recorded in [ADR 0006 — Dev/Prod Environment Separation](../adr/0006-dev-prod-environment-separation.md); production-data guardrails are in [ADR 0008](../adr/0008-production-data-safety-guardrails.md).

## Supabase projects

| Environment     | Project      | Ref                    | Region          | Used by                                                                       |
| --------------- | ------------ | ---------------------- | --------------- | ----------------------------------------------------------------------------- |
| **Production**  | `drafto.eu`  | `tbmjbxxseonkciqovnpl` | West EU Ireland | Vercel production deployment (drafto.eu)                                      |
| **Development** | `drafto-dev` | `huhzactreblzcogqkbsd` | West EU Ireland | Local dev, Vercel previews (`*-jakubanderwalds-projects.vercel.app`), CI, E2E |

Both projects run on the Supabase **Pro plan**, which provides daily automatic backups and enables Point-in-Time Recovery (PITR) for granular restore.

Supabase `config.toml` lives at [`supabase/config.toml`](../../supabase/config.toml). Its auth settings (email confirmations enabled, MFA TOTP enabled, `otp_length=8`, `max_frequency=1m0s`) must match production.

## Where each environment is used

### Web — `apps/web/`

- **Vercel production** (drafto.eu domain): points at the production Supabase project. Environment variables are managed in the Vercel dashboard.
- **Vercel preview deployments** (`*-jakubanderwalds-projects.vercel.app`): point at the dev Supabase project.
- **Local dev** (`pnpm dev`): uses `apps/web/.env.local`, which should target the dev Supabase project.
- **Playwright E2E** (`cd apps/web && pnpm test:e2e`): sources `apps/web/.env.local`, runs against whichever backend it points at — use the dev project.

### Mobile — `apps/mobile/`

Two env files, selected by build type:

| Build type  | Env file          | Backend     | Supabase ref           | Command                                               |
| ----------- | ----------------- | ----------- | ---------------------- | ----------------------------------------------------- |
| **Debug**   | `.env`            | Development | `huhzactreblzcogqkbsd` | `cd apps/mobile && pnpm android` / `expo run:android` |
| **Release** | `.env.production` | Production  | `tbmjbxxseonkciqovnpl` | `cd apps/mobile && pnpm android:release-local`        |

Both env files are gitignored. In a worktree, copy them from the main checkout before building — see the "Worktree setup" section in [`CLAUDE.md`](../../CLAUDE.md).

### Desktop — `apps/desktop/`

Same pattern as mobile: `apps/desktop/.env` for dev backend (used by `npx react-native run-macos`), `apps/desktop/.env.production` for release builds (used by `pnpm release:beta` / `pnpm release:production`). Both files are gitignored and must be copied into new worktrees.

### CI

GitHub Actions workflows run against the **dev** Supabase project. CI secrets (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, service-role keys, etc.) point at `huhzactreblzcogqkbsd`.

## Observability

Sentry and PostHog each use a **single project** with environment tagging, rather than per-environment projects:

- Sentry environment is set via `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, configured per Vercel environment (Production / Preview / Development).
- PostHog events carry the same environment tag so production and preview/dev traffic can be filtered in the same dashboard.
- Client instrumentation: [`apps/web/instrumentation-client.ts`](../../apps/web/instrumentation-client.ts) (not `sentry.client.config.ts` — Turbopack ignores the old webpack convention).
- Server + edge instrumentation: [`apps/web/sentry.server.config.ts`](../../apps/web/sentry.server.config.ts), [`apps/web/sentry.edge.config.ts`](../../apps/web/sentry.edge.config.ts), loaded via [`apps/web/instrumentation.ts`](../../apps/web/instrumentation.ts).

## Verification commands

Before any Supabase CLI operation, verify which project you're linked to:

```bash
# List projects (current link shown with a marker)
supabase projects list

# Link explicitly — these scripts pin the project ref
pnpm supabase:link:dev    # ref huhzactreblzcogqkbsd (drafto-dev)
pnpm supabase:link:prod   # ref tbmjbxxseonkciqovnpl (drafto.eu)
```

The scripts are defined in the root [`package.json`](../../package.json) so the ref can never be mistyped by hand.

## Migration workflow

Always apply migrations to dev first, verify, then to prod:

```bash
# 1. Scan the migration for destructive SQL
pnpm migration:check

# 2. Apply to dev
pnpm supabase:link:dev
pnpm supabase:push

# 3. Verify on dev (run the app, run E2E, manual check)

# 4. Apply to prod (requires explicit confirmation per ADR 0008)
pnpm supabase:link:prod
pnpm supabase:push
```

The `pnpm migration:check` script runs [`scripts/check-migration-safety.sh`](../../scripts/check-migration-safety.sh) and scans for `DROP TABLE`, `TRUNCATE`, and unqualified `DELETE` patterns.

Full safety rules (never `db reset` against production, confirmation requirements, etc.) live in [`../operations/migrations.md`](../operations/migrations.md) and [ADR 0008](../adr/0008-production-data-safety-guardrails.md).

## User approval

Accounts start in `profiles.is_approved = false`. There is no admin UI yet — approval happens via the Supabase dashboard SQL editor or through the email-driven flow in [`../features/email-and-approval.md`](../features/email-and-approval.md). See [ADR 0019](../adr/0019-email-infrastructure-and-approval-flow.md).

## Related ADRs

- [ADR 0006 — Dev/Prod Environment Separation](../adr/0006-dev-prod-environment-separation.md) (authoritative)
- [ADR 0008 — Production Data Safety Guardrails](../adr/0008-production-data-safety-guardrails.md)
- [ADR 0019 — Email Infrastructure and Approval Flow](../adr/0019-email-infrastructure-and-approval-flow.md)
