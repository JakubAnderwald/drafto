# Drafto

Note-taking web app at drafto.eu. Monorepo with pnpm workspaces + Turborepo. Built with Next.js 16 (App Router, Turbopack), TypeScript, Tailwind CSS, Supabase.

## Directory Structure

- `apps/web/` — Next.js web app
  - `src/app/` — App Router pages and API routes
  - `src/lib/` — Shared libraries (supabase, posthog)
  - `src/env.ts` — Environment variable validation (t3-env + zod)
  - `__tests__/unit/` — Unit tests (vitest)
  - `__tests__/integration/` — Integration tests (vitest + testing-library)
  - `e2e/` — End-to-end tests (Playwright)
  - `middleware.ts` — Next.js middleware (Supabase session refresh)
- `apps/mobile/` — Expo + React Native mobile app
  - `.env` — Development Supabase credentials (dev backend)
  - `.env.production` — Production Supabase credentials (prod backend)
  - `android/` — Native Android project (Gradle build)
  - `e2e/` — Maestro E2E tests
- `packages/shared/` — Shared types (`Database`, API types) and constants (`@drafto/shared`)
- `docs/adr/` — Architecture Decision Records (see [ADR README](./docs/adr/README.md))
- `supabase/` — Supabase migrations and config

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

## Design System (Enforced)

All UI code must use the design system defined in `apps/web/src/app/globals.css`. See the live showcase at `/design-system`.

**Token usage:**

- Use semantic token classes (`bg-bg`, `text-fg-muted`, `border-border`) for surfaces — never raw Tailwind colors (`bg-gray-100`, `text-slate-500`)
- Use scale token classes (`bg-primary-500`, `text-accent-400`, `text-neutral-600`) from the defined palette — never arbitrary color values (`bg-[#4f46e5]`)
- Use design system shadows (`shadow-sm`, `shadow-md`), radii (`rounded-md`, `rounded-lg`), and transitions (`transition-fast`, `transition-normal`) — never hardcoded values

**Component reuse:**

- Check `apps/web/src/components/ui/` before building any new button, input, card, badge, dialog, dropdown, or skeleton — a primitive likely already exists
- When a new reusable UI pattern emerges, extract it to `apps/web/src/components/ui/` following existing conventions (variant props, `cn()` utility, design tokens)

**Keeping the system current:**

- When adding a new token to `globals.css`, add a corresponding example to the showcase page (`apps/web/src/app/design-system/page.tsx`)
- When adding a new UI primitive, add it to the showcase page with all variants demonstrated

## Testing Requirements

Every feature needs:

1. **Unit tests** in `__tests__/unit/` — test pure logic and API routes
2. **Integration tests** in `__tests__/integration/` — test component rendering with testing-library
3. **E2E tests** in `e2e/` — test user flows in Playwright

Run tests: `cd apps/web && pnpm test` (unit+integration), `cd apps/web && pnpm test:e2e` (Playwright)

**Important**: When asked to "run tests" or verify the test suite, always run **both** `cd apps/web && pnpm test` and `cd apps/web && pnpm test:e2e`. Also run `cd packages/shared && pnpm test` for shared package tests. Never report tests as passing unless all test suites have been executed. E2E tests require `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` in `process.env`. Playwright does not load `.env.local` — the shell must export these vars before running Playwright (e.g., `set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e`).

**Pre-push verification (required before every push):**

Before pushing any changes, run these checks locally to avoid CI failures:

1. **Unit & integration tests**: `cd apps/web && pnpm test`
2. **Coverage check**: `cd apps/web && pnpm test:coverage` — verify new code has adequate coverage (SonarCloud enforces ~80% on new code). Check the coverage report for any files you changed.
3. **E2E tests**: `set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e`
4. **Shared package tests**: `cd packages/shared && pnpm test`
5. **Lint & typecheck**: `pnpm lint && pnpm typecheck`

Never push code that fails any of these checks. Common CI failure patterns to watch for:

- **Missing test coverage**: When adding new code, write tests concurrently. Check coverage locally before pushing rather than iterating via CI.
- **E2E assumptions**: E2E tests depend on database state (migrations applied, seed data). If adding features that require new migrations, ensure the migration is applied to dev before running E2E tests.

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

## Environments

Two Supabase projects provide full data isolation:

| Environment     | Project    | Ref                    | Used By                            |
| --------------- | ---------- | ---------------------- | ---------------------------------- |
| **Production**  | drafto.eu  | `tbmjbxxseonkciqovnpl` | Vercel production (drafto.eu)      |
| **Development** | drafto-dev | `huhzactreblzcogqkbsd` | Local dev, Vercel previews, CI/E2E |

**Migration workflow:** Apply to dev first (`pnpm supabase:link:dev && pnpm supabase:push`), verify, then apply to prod (`pnpm supabase:link:prod && pnpm supabase:push`).

Sentry and PostHog use environment tagging (not separate projects). The `NEXT_PUBLIC_SENTRY_ENVIRONMENT` env var is set per Vercel environment.

Supabase provides daily automatic backups. The Pro plan enables Point-in-Time Recovery (PITR) for granular restore.

## Production Data Safety

**Destructive SQL prevention:**

- Never run `DROP TABLE`, `TRUNCATE`, or `DELETE FROM` without `WHERE` against production
- Never run `supabase db reset` against production — it drops and recreates the entire database
- Always run `pnpm migration:check` before pushing migrations — it scans for destructive patterns

**Supabase project verification:**

- Before `supabase db push`, always verify the linked project ref with `supabase projects list`
- Production ref: `tbmjbxxseonkciqovnpl` — Development ref: `huhzactreblzcogqkbsd`
- When in doubt, re-link explicitly: `pnpm supabase:link:dev` or `pnpm supabase:link:prod`

**Confirmation requirements:**

- Require explicit user "yes" before any production database operation
- State the target project, operation, and affected data before asking for confirmation
- Never batch production operations — one operation at a time with confirmation

**Migration safety workflow:**

1. Write migration and run `pnpm migration:check`
2. Apply to dev first (`pnpm supabase:link:dev && pnpm supabase:push`)
3. Verify on dev environment
4. Apply to prod with confirmation (`pnpm supabase:link:prod && pnpm supabase:push`)

## Environment Variables

- Declare all env vars in `src/env.ts` using zod schemas
- Access via `import { env } from "@/env"` — never use `process.env` directly
- See `.env.local.example` for required variables

## Error Handling

- Errors flow through Sentry automatically (`@sentry/nextjs`)
- Client config: `instrumentation-client.ts` (NOT `sentry.client.config.ts` — Turbopack ignores the old webpack convention)
- Server/edge configs: `sentry.server.config.ts`, `sentry.edge.config.ts` (loaded via `instrumentation.ts`)
- Do not swallow errors silently — let them propagate to Sentry

## Local Dev Setup

After cloning and running `pnpm install`, ensure these CLI tools are also installed:

1. **Playwright browsers**: `pnpm exec playwright install` — required for E2E tests
2. **Vercel CLI**: `pnpm i -g vercel` ([install docs](https://vercel.com/docs/cli)) — used to pull env vars (`vercel env pull`)
3. **Supabase CLI**: `brew install supabase/tap/supabase` (macOS) or see [install docs](https://supabase.com/docs/guides/cli/getting-started) for other platforms — used for migrations and DB management

Without these, E2E tests will fail and environment/database workflows won't work.

## Useful Commands

```bash
# Root (Turborepo orchestrates all packages)
pnpm dev              # Start dev server (all apps)
pnpm build            # Production build (all packages)
pnpm lint             # ESLint (all packages)
pnpm format:check     # Prettier check
pnpm test             # Unit + integration tests (all packages)
pnpm typecheck        # TypeScript check (all packages)
pnpm migration:check  # Check migrations for destructive SQL

# Web app (apps/web/)
cd apps/web && pnpm test           # Web unit + integration tests
cd apps/web && pnpm test:coverage  # Web tests with coverage
cd apps/web && pnpm test:e2e       # Playwright E2E tests (source .env.local first)
cd apps/web && pnpm exec tsc --noEmit  # Web type check

# Shared package (packages/shared/)
cd packages/shared && pnpm test           # Shared package tests
cd packages/shared && pnpm exec tsc --noEmit  # Shared type check

# Mobile app (apps/mobile/)
cd apps/mobile && pnpm android            # Debug build + run on device/emulator (dev backend)
cd apps/mobile && pnpm android:release    # Release APK (prod backend) → android/app/build/outputs/apk/release/app-release.apk
```

## Mobile Build Environment Mapping

The mobile app uses different Supabase backends depending on the build type:

| Build Type  | Env File          | Backend     | Supabase Ref           | Command                             |
| ----------- | ----------------- | ----------- | ---------------------- | ----------------------------------- |
| **Debug**   | `.env`            | Development | `huhzactreblzcogqkbsd` | `pnpm android` / `expo run:android` |
| **Release** | `.env.production` | Production  | `tbmjbxxseonkciqovnpl` | `pnpm android:release`              |

**When asked to build a mobile APK**: always confirm which environment (dev or production) the user wants. Use `pnpm android:release` for production builds and `pnpm android` for dev builds. The release APK is output to `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

**Local build prerequisites**:

- `android/local.properties` must have `sdk.dir` pointing to the Android SDK (e.g., `/Users/jakub/Library/Android/sdk`)
- JDK 25+ requires `_JAVA_OPTIONS='--enable-native-access=ALL-UNNAMED'` (already set in the `android:release` script)
- The release build is signed with the debug keystore — for Play Store distribution, use EAS build (`pnpm build:prod`)

## Google Play Deployment (EAS Build + Submit)

Single command to build and deploy to Google Play internal testing:

```bash
cd apps/mobile && npx eas-cli build --profile beta --platform android --auto-submit --non-interactive
```

**Setup details:**

- EAS project: `@jakubanderwald/drafto` (ID: `6cf2a8f0-c2a6-410c-89dc-3e49aa4119a5`)
- Google Play service account key: `apps/mobile/google-play-service-account.json` (gitignored)
- Submit track: `internal` (configured in `eas.json` submit.beta.android)
- `node-linker=hoisted` is required for EAS Build — set via `eas-build-pre-install` script in `apps/mobile/package.json` (not a repo-level `.npmrc`, which breaks web CI tests)
- `expo-updates` is NOT installed — `runtimeVersion` and `updates` config must not be in `app.config.ts`
- App owner in Expo: `jakubanderwald` (set in `app.config.ts`)
- App package: `eu.drafto.mobile`

**CI automated deploy:** The `beta-release.yml` workflow writes the service account key from `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY` GitHub secret before building. Ensure this secret is set in repo settings.
