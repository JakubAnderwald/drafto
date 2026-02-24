# Drafto

Note-taking web app at drafto.eu. Built with Next.js 16 (App Router, Turbopack), TypeScript, Tailwind CSS, Supabase.

## Directory Structure

- `src/app/` — Next.js App Router pages and API routes
- `src/lib/` — Shared libraries (supabase, posthog)
- `src/env.ts` — Environment variable validation (t3-env + zod)
- `__tests__/unit/` — Unit tests (vitest)
- `__tests__/integration/` — Integration tests (vitest + testing-library)
- `e2e/` — End-to-end tests (Playwright)
- `docs/adr/` — Architecture Decision Records (see [ADR README](./docs/adr/README.md))
- `middleware.ts` — Next.js middleware (Supabase session refresh)

## SOLID Principles (Enforced)

Every module must follow SOLID:

- **SRP**: One reason to change per file. Split if a file handles both data fetching and UI.
- **OCP**: Extend via composition, not modification. Use props/config over editing existing code.
- **LSP**: Components accepting the same props must behave consistently.
- **ISP**: Keep interfaces small. Split large prop types into focused ones.
- **DIP**: Import abstractions from `src/lib/`, never instantiate clients directly in components.

## Worktree Workflow (Required)

Never work directly on `main`. Always use the `/worktree` command to create an isolated branch, then open a PR.

## Code Style

- Strict TypeScript — no `any`, no `@ts-ignore`
- Prettier handles formatting (run `pnpm format:check` to verify)
- Named exports only (no default exports except for Next.js pages/layouts)
- Kebab-case file names (e.g., `user-profile.tsx`, not `UserProfile.tsx`)
- Use `@/` import alias for all `src/` imports

## Testing Requirements

Every feature needs:

1. **Unit tests** in `__tests__/unit/` — test pure logic and API routes
2. **Integration tests** in `__tests__/integration/` — test component rendering with testing-library
3. **E2E tests** in `e2e/` — test user flows in Playwright

Run tests: `pnpm test` (unit+integration), `pnpm test:e2e` (Playwright)

## Supabase Patterns

- Browser client: `import { createClient } from "@/lib/supabase/client"`
- Server client: `import { createClient } from "@/lib/supabase/server"`
- Session refresh handled automatically by middleware
- Never import `@supabase/supabase-js` directly in components

## Git Conventions

- Branch naming: `feat/`, `fix/`, `chore/`, `docs/` prefixes
- Conventional commits enforced by commitlint (e.g., `feat: add login page`)
- Squash-merge PRs to keep main history clean
- Pre-commit hooks run lint-staged (ESLint + Prettier)
- **All pushes must use the `/push` command** — this ensures commits are pushed, CI/CD checks are polled until green, review comments are addressed, and failures are fixed automatically

## Architecture Decision Records (ADR)

Every significant architectural decision must be recorded in `docs/adr/`.

**When to create an ADR**: introducing or replacing a technology/library/service, changing project structure or module boundaries, defining a new pattern or convention, changing data flow/storage/API design, or making any decision with trade-offs that future contributors should understand.

**Workflow**:

1. Copy `docs/adr/0000-adr-template.md` to a new file with the next sequential number (e.g., `0001-short-title.md`)
2. Fill in all sections — Context, Decision, Consequences, and Alternatives Considered
3. Set the status to `Accepted` and the date to today
4. Add the new entry to the index table in `docs/adr/README.md`
5. Include the ADR file in the same PR as the code change it documents

**Important**: ADRs are append-only. Never delete a past ADR. If a decision is reversed, create a new ADR that supersedes it and update the old ADR's status to `Superseded by [NNNN](./NNNN-title.md)`.

## Environment Variables

- Declare all env vars in `src/env.ts` using zod schemas
- Access via `import { env } from "@/env"` — never use `process.env` directly
- See `.env.local.example` for required variables

## Error Handling

- Errors flow through Sentry automatically (`@sentry/nextjs`)
- Client config: `instrumentation-client.ts` (NOT `sentry.client.config.ts` — Turbopack ignores the old webpack convention)
- Server/edge configs: `sentry.server.config.ts`, `sentry.edge.config.ts` (loaded via `instrumentation.ts`)
- Do not swallow errors silently — let them propagate to Sentry

## Useful Commands

```bash
pnpm dev              # Start dev server
pnpm build            # Production build
pnpm lint             # ESLint
pnpm format:check     # Prettier check
pnpm test             # Unit + integration tests
pnpm test:coverage    # Tests with coverage
pnpm test:e2e         # Playwright E2E tests
pnpm exec tsc --noEmit  # Type check
```
