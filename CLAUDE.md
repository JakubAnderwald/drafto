# Drafto

Note-taking app at drafto.eu. Monorepo with pnpm workspaces + Turborepo. Web (Next.js 16, React 19, Supabase), iOS + Android (Expo / React Native), macOS (React Native macOS). Mobile and desktop are offline-first via WatermelonDB.

## Where to find things

| Need                                              | Start at                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| What a feature does and where it lives in code    | [`docs/features/`](./docs/features/)                                                 |
| System shape, data flow, platform parity          | [`docs/architecture/`](./docs/architecture/)                                         |
| Testing matrix (commands per platform)            | [`docs/architecture/testing.md`](./docs/architecture/testing.md)                     |
| Environments, Supabase refs, migration workflow   | [`docs/architecture/environments.md`](./docs/architecture/environments.md)           |
| Local machine setup                               | [`docs/operations/local-dev-setup.md`](./docs/operations/local-dev-setup.md)         |
| Builds, Fastlane, App Store / Play / Mac releases | [`docs/operations/builds-and-releases.md`](./docs/operations/builds-and-releases.md) |
| Supabase migration safety workflow                | [`docs/operations/migrations.md`](./docs/operations/migrations.md)                   |
| Why a tech / pattern was chosen                   | [`docs/adr/`](./docs/adr/README.md)                                                  |
| Full index                                        | [`docs/README.md`](./docs/README.md)                                                 |

Historical plans live in [`docs/archive/`](./docs/archive/) — do not treat as source of truth.

## Worktree Workflow (Required)

Never work directly on `main`. For every new task (feature, fix, chore, docs):

1. Use the `/worktree` command to create an isolated branch and worktree
2. **Immediately run `pnpm install`** in the new worktree — worktrees do not share `node_modules`, so all tooling (`turbo`, `tsc`, etc.) will fail without this step
3. Do all work (commits, edits, tests) in that worktree
4. Open a PR to merge into `main` — never push directly to `main`

**Only exception:** The user explicitly asks to work on or push to `main` directly. Without that explicit request, always use a branch + PR.

**Worktree setup for mobile/desktop development:**

Git worktrees do not copy gitignored files. When working on mobile or desktop code in a worktree, copy these files from the main repo before building or running tests:

```bash
# Required for mobile builds and Maestro E2E tests
cp /Users/jakub/code/drafto/apps/mobile/.env apps/mobile/.env
cp /Users/jakub/code/drafto/apps/mobile/.env.production apps/mobile/.env.production

# Required for desktop builds
cp /Users/jakub/code/drafto/apps/desktop/.env apps/desktop/.env
cp /Users/jakub/code/drafto/apps/desktop/.env.production apps/desktop/.env.production

# Required after expo prebuild (regenerates android/ without local.properties)
echo "sdk.dir=/Users/jakub/Library/Android/sdk" > apps/mobile/android/local.properties
```

**Metro port conflicts:** The main repo may have Metro running on port 8081. In a worktree, start Metro on a different port (`pnpm start --port 8082`) and use `adb reverse tcp:8081 tcp:8082` to redirect the app.

**Worktree git gotchas:**

- **Cannot checkout `main`**: In a worktree, `main` is already checked out by the original repo. To create a new branch from latest main, use: `git fetch origin main && git checkout -b <branch> origin/main`
- **Cannot merge PRs with `--delete-branch`**: `gh pr merge --delete-branch` fails because it tries to switch to `main` locally. Instead use the GitHub API: `gh api repos/{owner}/{repo}/pulls/{number}/merge -f merge_method=squash`
- **Fastlane in worktrees**: Worktrees do not share Ruby gems. Run `bundle install` in the worktree's `apps/mobile/` (or `apps/desktop/`) directory before using Fastlane commands. Also copy `google-play-service-account.json` if needed for store submissions.

## Parallel Tool Execution

When planning, fan out independent actions into a single batched message — don't serialise across turns. Only stay sequential when a tool genuinely needs a prior tool's output (e.g., commit after edits, push after commit).

**High-yield cases in this repo:**

- **Cross-platform mirror edits**: `apps/mobile/src/db/` and `apps/desktop/src/db/` must stay in sync (schema, migrations, models). Batch all 6 file edits in one message — never edit one platform, then the other.
- **Cross-platform UI**: files like `attachment-list.tsx` on desktop and mobile are different files with no dependency — batch, don't serialise.
- **Verification sweep**: `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, per-app `pnpm --filter … test`, and `pnpm --filter=@drafto/shared test` are independent — fan out in one message.
- **Exploration**: Launch multiple `Explore` subagents in one message when scoping work across separate areas.

**Worktree gotcha**: `Edit`/`Write` require a prior `Read` of the _exact_ path. Reading `/Users/…/drafto/foo.ts` does NOT satisfy an edit against `/Users/…/drafto-worktree/foo.ts`. Pattern when starting work in a worktree: one batched `Read` for every worktree file you'll touch, then one batched `Edit`/`Write` for all the changes.

## SOLID Principles (Enforced)

Every module must follow SOLID:

- **SRP**: One reason to change per file. Split if a file handles both data fetching and UI.
- **OCP**: Extend via composition, not modification. Use props/config over editing existing code.
- **LSP**: Components accepting the same props must behave consistently.
- **ISP**: Keep interfaces small. Split large prop types into focused ones.
- **DIP**: Import abstractions from `src/lib/`, never instantiate clients directly in components.

## Code Style

- Strict TypeScript — no `any`, no `@ts-ignore`
- Prettier handles formatting (run `pnpm format:check` to verify)
- Named exports only (no default exports except for Next.js pages/layouts)
- Kebab-case file names (e.g., `user-profile.tsx`, not `UserProfile.tsx`)
- Use `@/` import alias for all `src/` imports

## Design System (Enforced)

All UI code must use the design system defined in `apps/web/src/app/globals.css`. Full reference: [`docs/features/design-system.md`](./docs/features/design-system.md).

- Use semantic token classes (`bg-bg`, `text-fg-muted`, `border-border`) — never raw Tailwind colors (`bg-gray-100`)
- Use scale token classes (`bg-primary-500`, `text-accent-400`) — never arbitrary color values (`bg-[#4f46e5]`)
- Check `apps/web/src/components/ui/` before building any new button / input / card / dialog / dropdown / skeleton — a primitive likely already exists
- When adding a new token, add an example to the showcase page (`apps/web/src/app/design-system/page.tsx`)
- When adding a new UI primitive, add it to the showcase page with all variants

**Lint guardrails** enforce these rules automatically:

- Web (`apps/web/eslint.config.mjs`) — blocks raw Tailwind greys (`bg-gray-*`, `text-slate-*`, …), arbitrary color values (`bg-[#...]`), and arbitrary shadow/radius values (`shadow-[...]`, `rounded-[...]`) inside `className`.
- Mobile + desktop (`apps/{mobile,desktop}/eslint.config.mjs`) — blocks numeric `fontSize` literals and hex color strings assigned to `color`/`backgroundColor`/`borderColor` inside `src/`, `app/`, and `components/`.
- Suppress legitimate exceptions with `// eslint-disable-next-line no-restricted-syntax -- <reason>` and explain why (e.g. an emoji glyph sized as a visual, not typography). See `docs/features/design-system.md` → "Lint guardrails" for the full rule set.

## Testing Requirements

Every feature needs unit tests (`__tests__/unit/`), integration tests (`__tests__/integration/`), and E2E tests (`e2e/`). The full per-platform matrix of commands lives in [`docs/architecture/testing.md`](./docs/architecture/testing.md).

**Pre-push checklist (required before every push):** run every row of the testing matrix plus `pnpm lint && pnpm typecheck`. Never push code that fails any check.

Common CI failure patterns:

- **Missing coverage**: Write tests concurrently with new code. SonarCloud enforces ~80% on new code. Query the gate for a PR with `https://sonarcloud.io/api/qualitygates/project_status?projectKey=JakubAnderwald_drafto&pullRequest=<N>`.
- **E2E assumptions**: E2E tests depend on applied migrations + seed data. If adding features that require new migrations, apply to dev first before running E2E.

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
- **Never commit or push directly to `main`** unless the user explicitly requests it. All work goes through feature branches and PRs.
- **All pushes must use the `/push` command** — this ensures commits are pushed, CI/CD checks are polled until green, review comments are addressed, and failures are fixed automatically

## Cross-Platform Feature Workflow

Drafto runs on 4 platforms: **web**, **iOS**, **Android**, and **macOS**. Every new user-facing feature must be implemented on all relevant platforms or explicitly scoped to a subset with justification.

**When adding a feature:**

1. Determine which platforms are affected (most features affect all 4)
2. Implement on each platform in the same PR or a coordinated set of PRs
3. If a feature is intentionally skipped on a platform, document why (e.g., "macOS: deferred — requires native toolbar integration")

**Shared code:** Changes in `packages/shared/` affect all platforms. Changes in `apps/mobile/src/db/` (schema, models, sync) are shared with `apps/desktop/` — keep them in sync.

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

Two Supabase projects provide full data isolation: production `drafto.eu` (ref `tbmjbxxseonkciqovnpl`) and development `drafto-dev` (ref `huhzactreblzcogqkbsd`). Prod serves drafto.eu; dev serves local dev, Vercel previews, and CI/E2E. Full reference: [`docs/architecture/environments.md`](./docs/architecture/environments.md).

## Production Data Safety

Full safety rails + migration workflow: [`docs/operations/migrations.md`](./docs/operations/migrations.md).

- Never run `DROP TABLE`, `TRUNCATE`, or unqualified `DELETE FROM` against production
- Never run `supabase db reset` against production — it drops and recreates the entire database
- Always run `pnpm migration:check` before pushing migrations
- Before `supabase db push`, verify the linked project ref with `supabase projects list` (prod `tbmjbxxseonkciqovnpl`, dev `huhzactreblzcogqkbsd`)
- Require explicit user "yes" before any production database operation — state the target project, operation, and affected data before asking

## Environment Variables

- Declare all env vars in `src/env.ts` using zod schemas
- Access via `import { env } from "@/env"` — never use `process.env` directly
- See `.env.local.example` for required variables

## Error Handling

- Errors flow through Sentry automatically (`@sentry/nextjs`)
- Client config: `instrumentation-client.ts` (NOT `sentry.client.config.ts` — Turbopack ignores the old webpack convention)
- Server/edge configs: `sentry.server.config.ts`, `sentry.edge.config.ts` (loaded via `instrumentation.ts`)
- Do not swallow errors silently — let them propagate to Sentry

## MCP Server (Claude Cowork Integration)

Full reference with all 9 tools enumerated, auth model, and registry publishing steps: [`docs/features/mcp-server.md`](./docs/features/mcp-server.md).

**Maintenance rules (agents must follow):**

- When adding a new user-facing feature (API route, data model, capability), evaluate whether it should be exposed as an MCP tool and update `apps/web/src/app/api/mcp/route.ts` and `apps/web/src/lib/api/mcp-tools.ts` accordingly
- When changing an existing API route's behavior or schema, update the corresponding MCP tool handler and its input/output schemas to match
- When adding or modifying database tables/columns that affect note content or structure, update `packages/shared/src/editor/markdown-converter.ts` if the new content type needs Markdown representation
- After changing any MCP tool, bump `version` in `server.json` and run `~/bin/mcp-publisher publish`
- Run MCP-related tests: `cd apps/web && pnpm test` (includes mcp-auth and api-keys tests)

## Useful Commands

Dev + verification only. Build and release commands live in [`docs/operations/builds-and-releases.md`](./docs/operations/builds-and-releases.md).

```bash
pnpm dev              # Start dev server (all apps via Turborepo)
pnpm build            # Production build (all packages)
pnpm lint             # ESLint (all packages)
pnpm format:check     # Prettier check
pnpm test             # Unit + integration tests (all packages)
pnpm typecheck        # TypeScript check (all packages)
pnpm migration:check  # Check migrations for destructive SQL
```

## Local Dev Setup

See [`docs/operations/local-dev-setup.md`](./docs/operations/local-dev-setup.md) for first-time machine setup (CLI tools, Fastlane, Claude Code memory symlink).
