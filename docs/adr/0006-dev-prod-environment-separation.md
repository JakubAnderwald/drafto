# 0006 — Dev/Prod Environment Separation

- **Status**: Accepted
- **Date**: 2026-03-04
- **Authors**: Jakub Anderwald

## Context

All environments (production at drafto.eu, Vercel preview deploys, local dev, CI E2E tests) shared a single Supabase project (`tbmjbxxseonkciqovnpl`). This caused:

- E2E tests creating/deleting data in the production database
- Preview deployments potentially corrupting production data
- No safe environment for destructive migration testing or schema experiments

## Decision

Create a dedicated **development Supabase project** (`huhzactreblzcogqkbsd`, drafto-dev) that is used by all non-production environments: local development, Vercel previews, and CI/GitHub Actions.

The production Supabase project remains unchanged and is only used by the Vercel production deployment (drafto.eu).

Observability services (Sentry, PostHog) use a single project each with **environment tagging** to distinguish data sources, rather than separate projects per environment.

Migration workflow: apply migrations to dev first (`supabase:link:dev` + `supabase:push`), verify, then apply to prod (`supabase:link:prod` + `supabase:push`).

## Consequences

- **Positive**: Production data is fully isolated from test/preview activity. Migrations can be safely tested before applying to production. E2E tests no longer affect real users.
- **Negative**: Two Supabase projects to maintain. Auth settings and test users must be configured in both projects. Slightly more complex onboarding for new developers.
- **Neutral**: CI secret values changed (to dev project). Workflow files unchanged.

## Alternatives Considered

- **Supabase local dev (Docker)**: Would provide full isolation but adds Docker dependency, is slower for CI, and doesn't cover Vercel preview deploys.
- **Separate Sentry/PostHog projects per environment**: Rejected — adds DSN/key management overhead for minimal benefit. Environment tagging achieves the same filtering.
- **Branch-based Supabase projects**: Supabase branching is a paid feature and adds complexity. A single dev project is simpler and sufficient.
