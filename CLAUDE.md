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
- `apps/desktop/` — React Native macOS desktop app (offline-first, Mac App Store)
  - `macos/` — Native macOS Xcode project (Drafto.xcworkspace)
  - `src/` — App source (mirrors mobile: db/, providers/, hooks/, lib/, screens/, components/)
  - `fastlane/` — Fastlane config for Mac App Store deployment
  - `scripts/` — Release notes generation and posting
  - `__tests__/` — Jest unit tests
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

**Metro port conflicts:** The main repo may have Metro running on port 8081. In a worktree, start Metro on a different port (`pnpm start --port 8082`) and use `adb reverse tcp:8081 tcp:8082` to redirect the app. Alternatively, stop the main repo's Metro first.

**Worktree git gotchas:**

- **Cannot checkout `main`**: In a worktree, `main` is already checked out by the original repo. To create a new branch from latest main, use: `git fetch origin main && git checkout -b <branch> origin/main`
- **Cannot merge PRs with `--delete-branch`**: `gh pr merge --delete-branch` fails because it tries to switch to `main` locally. Instead use the GitHub API: `gh api repos/{owner}/{repo}/pulls/{number}/merge -f merge_method=squash`
- **Fastlane in worktrees**: Worktrees do not share Ruby gems. Run `bundle install` in the worktree's `apps/mobile/` (or `apps/desktop/`) directory before using Fastlane commands. Also copy `google-play-service-account.json` if needed for store submissions.

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

**Important**: When asked to "run tests" or verify the test suite, always run **all** of the following. Never report tests as passing unless every suite has been executed:

1. `cd apps/web && pnpm test` — web unit + integration
2. `set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e` — web Playwright E2E (requires `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` in env; Playwright does not load `.env.local` automatically)
3. `cd packages/shared && pnpm test` — shared package tests
4. `cd apps/mobile && pnpm test` — mobile unit tests
5. `maestro test apps/mobile/e2e/ --platform android` — mobile Maestro E2E on Android emulator (requires a running emulator and the dev client started with `cd apps/mobile && npx expo start --dev-client`; also requires `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` in env)
6. `cd apps/desktop && pnpm test` — desktop unit tests

**Pre-push verification (required before every push):**

Before pushing any changes, run these checks locally to avoid CI failures:

1. **Web unit & integration tests**: `cd apps/web && pnpm test`
2. **Web coverage check**: `cd apps/web && pnpm test:coverage` — verify new code has adequate coverage (SonarCloud enforces ~80% on new code). Check the coverage report for any files you changed.
3. **Web E2E tests**: `set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e`
4. **Shared package tests**: `cd packages/shared && pnpm test`
5. **Mobile unit tests**: `cd apps/mobile && pnpm test`
6. **Mobile E2E tests**: `maestro test apps/mobile/e2e/ --platform android` (requires running Android emulator + dev client)
7. **Desktop unit tests**: `cd apps/desktop && pnpm test`
8. **Lint & typecheck**: `pnpm lint && pnpm typecheck`

Never push code that fails any of these checks. Common CI failure patterns to watch for:

- **Missing test coverage**: When adding new code, write tests concurrently. Check coverage locally before pushing rather than iterating via CI.
- **SonarCloud quality gate failure**: To check the specific failing conditions, query the SonarCloud API: `https://sonarcloud.io/api/qualitygates/project_status?projectKey=JakubAnderwald_drafto&pullRequest=<PR_NUMBER>`. This returns the exact metrics (e.g., coverage %, duplications) that failed the gate.
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

## MCP Server (Claude Cowork Integration)

Drafto exposes a remote MCP server at `/api/mcp` for integration with Claude Desktop, Claude Cowork, and other MCP clients. Authenticated via API keys (managed at `/settings`).

**Key files:**

- `apps/web/src/app/api/mcp/route.ts` — MCP tool registry and handlers (all 9 tools defined here)
- `apps/web/src/lib/api/mcp-auth.ts` — API key authentication
- `packages/shared/src/editor/markdown-converter.ts` — BlockNote <-> Markdown conversion
- `supabase/migrations/20260411000001_api_keys.sql` — API keys table

**Maintenance rules (agents must follow):**

- When adding a new user-facing feature (API route, data model, capability), evaluate whether it should be exposed as an MCP tool and update `apps/web/src/app/api/mcp/route.ts` accordingly
- When changing an existing API route's behavior or schema, update the corresponding MCP tool handler and its input/output schemas to match
- When adding or modifying database tables/columns that affect note content or structure, update `packages/shared/src/editor/markdown-converter.ts` if the new content type needs Markdown representation
- Run MCP-related tests after changes: `cd apps/web && pnpm test` (includes mcp-auth and api-keys tests)

**MCP Registry:**

Drafto is published on the official MCP Registry as `eu.drafto/mcp`. The registry metadata is defined in `server.json` (repo root).

- **Registry entry:** `eu.drafto/mcp` at `registry.modelcontextprotocol.io`
- **Auth namespace:** DNS-based (`drafto.eu` TXT record with Ed25519 public key)
- **Private key:** `~/drafto-secrets/mcp-registry-key.pem` (never commit)
- **Publisher CLI:** `~/bin/mcp-publisher`

**To publish an update** (e.g., after adding/changing MCP tools):

1. Bump `version` in `server.json`
2. Run `~/bin/mcp-publisher publish`
3. Verify: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=drafto"`

If the login session has expired, re-authenticate:

```bash
PRIVATE_KEY="$(openssl pkey -in ~/drafto-secrets/mcp-registry-key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
~/bin/mcp-publisher login dns --domain "drafto.eu" --private-key "${PRIVATE_KEY}"
```

## Local Dev Setup

See [docs/local-dev-setup.md](./docs/local-dev-setup.md) for first-time machine setup (CLI tools, Fastlane, Claude Code memory symlink).

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
cd apps/mobile && pnpm android:release-local    # Release APK (prod backend) → android/app/build/outputs/apk/release/app-release.apk

# Mobile releases (apps/mobile/) — Fastlane
cd apps/mobile && pnpm release:beta:android     # Build + submit to Google Play internal track
cd apps/mobile && pnpm release:beta:ios         # Build + submit to TestFlight
cd apps/mobile && pnpm release:beta:all         # Both platforms
cd apps/mobile && pnpm release:prod:android     # Build + submit to Google Play production
cd apps/mobile && pnpm release:prod:ios         # Build + submit to App Store

# Desktop app (apps/desktop/)
cd apps/desktop && npx react-native run-macos   # Build and run macOS app (dev)
cd apps/desktop && pnpm test                    # Desktop unit tests
cd apps/desktop && pnpm lint                    # Desktop lint
cd apps/desktop && pnpm typecheck               # Desktop type check

# Desktop releases (apps/desktop/) — Fastlane
cd apps/desktop && pnpm release:beta            # Build + submit to TestFlight (macOS)
cd apps/desktop && pnpm release:production      # Build + submit to Mac App Store
```

## Mobile Build Environment Mapping

The mobile app uses different Supabase backends depending on the build type:

| Build Type  | Env File          | Backend     | Supabase Ref           | Command                             |
| ----------- | ----------------- | ----------- | ---------------------- | ----------------------------------- |
| **Debug**   | `.env`            | Development | `huhzactreblzcogqkbsd` | `pnpm android` / `expo run:android` |
| **Release** | `.env.production` | Production  | `tbmjbxxseonkciqovnpl` | `pnpm android:release-local`        |

**When asked to build a mobile APK**: always confirm which environment (dev or production) the user wants. Use `pnpm android:release-local` for production builds and `pnpm android` for dev builds. The release APK is output to `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

**Local build prerequisites**:

- `android/local.properties` must have `sdk.dir` pointing to the Android SDK (e.g., `/Users/jakub/Library/Android/sdk`)
- JDK 25+ requires `_JAVA_OPTIONS='--enable-native-access=ALL-UNNAMED'` (already set in the `android:release` script)
- For Play Store distribution, use Fastlane: `cd apps/mobile && pnpm release:beta:android` (internal testing) or `pnpm release:prod:android` (production)

## Mobile Versioning

The mobile app version (`apps/mobile/package.json` → `version`) follows semver. Build numbers (iOS `buildNumber`, Android `versionCode`) are auto-incremented by Fastlane (queried from Google Play / TestFlight) — only the user-facing version needs manual bumps.

**When to bump (agents must follow these rules automatically):**

- **Patch** (`pnpm version:mobile patch`): Bug fixes, performance improvements, or dependency updates that don't change user-visible behavior. Bump in the same PR as the fix.
- **Minor** (`pnpm version:mobile minor`): New features, new screens, or meaningful UX changes visible to users. Bump in the same PR as the feature.
- **Major** (`pnpm version:mobile major`): Breaking changes to local data (e.g., WatermelonDB schema migration that requires a fresh install), or a fundamental redesign of the app. Requires explicit user confirmation before bumping.

**How to bump:** Run `pnpm version:mobile [patch|minor|major]` from the repo root, then commit the changed `package.json` as part of the feature/fix PR. The CI `beta-release.yml` workflow handles git tagging (`mobile@X.Y.Z`) on deploy.

**When NOT to bump:**

- Chore/docs/CI-only changes that don't touch mobile app code
- Changes only in `apps/web/` or `packages/shared/` (unless the shared change affects mobile behavior — then bump mobile too)
- Refactors with no user-visible effect

**Current version lives in:** `apps/mobile/package.json` (single source of truth, read by `app.config.ts`)

## Build & Release Policy

**All builds run locally via Fastlane.** GitHub Actions CI workflows exist for Android, iOS, and macOS but are currently non-functional for iOS (Swift 6 concurrency errors on CI Xcode) and macOS (Metro bundling hangs). Do not use CI builds until these issues are resolved.

### Build commands

| Platform          | Beta (TestFlight / Internal)                  | Production (App Store / Play Store)           |
| ----------------- | --------------------------------------------- | --------------------------------------------- |
| **Android**       | `cd apps/mobile && pnpm release:beta:android` | `cd apps/mobile && pnpm release:prod:android` |
| **iOS**           | `cd apps/mobile && pnpm release:beta:ios`     | `cd apps/mobile && pnpm release:prod:ios`     |
| **macOS**         | `cd apps/desktop && pnpm release:beta`        | `cd apps/desktop && pnpm release:production`  |
| **Android + iOS** | `cd apps/mobile && pnpm release:beta:all`     | `cd apps/mobile && pnpm release:prod:all`     |

### Local build prerequisites

- **Ruby**: rbenv with Ruby 3.3.7 (global default), Bundler 4.0.9
- **Fastlane**: Installed via Bundler (`bundle exec fastlane`)
- **Signing secrets**: Loaded automatically from `~/drafto-secrets/android-env.sh` (covers Android keystore, ASC API key, and Match password)
- **Locale**: `LANG=en_US.UTF-8` required for CocoaPods (set in Fastfiles and nightly script)

## Google Play Deployment (Fastlane)

Single command to build and deploy to Google Play internal testing:

```bash
cd apps/mobile && pnpm release:beta:android
```

For production track: `pnpm release:prod:android`

**What it does:** `expo prebuild` → Gradle `bundleRelease` (signed AAB) → `upload_to_play_store` → post release notes

**Setup details:**

- Google Play service account key: `apps/mobile/google-play-service-account.json` (gitignored)
- Android upload keystore: `~/drafto-secrets/drafto-release.keystore` (env var `ANDROID_KEYSTORE_PATH`)
- App package: `eu.drafto.mobile`
- Build numbers auto-incremented from Google Play's latest version code
- Signing config injected via Expo config plugin (`plugins/with-android-signing.js`)

**Required environment variables for local builds:**

```bash
export ANDROID_KEYSTORE_PATH="$HOME/drafto-secrets/drafto-release.keystore"
export ANDROID_KEYSTORE_PASSWORD="<password>"
export ANDROID_KEY_PASSWORD="<password>"
export ANDROID_KEY_ALIAS="54e4e5b83ca8617c2a3d8dbc2a5dbd87"
```

**CI workflows exist** (`beta-release.yml`, `production-release.yml`) but are not currently used — all builds run locally.

## App Store Deployment (Fastlane)

Single command to build and deploy to TestFlight:

```bash
cd apps/mobile && pnpm release:beta:ios
```

For App Store: `pnpm release:prod:ios`

**What it does:** `expo prebuild` → `match` (fetch signing creds) → `gym` (build IPA) → `pilot` / `deliver` (upload) → post release notes

**Setup details:**

- App Store Connect App ID: `6760675784`
- Apple Developer Team ID: `4J2USPSG2U`
- Signing: Fastlane match with a private Git repo for certificates and provisioning profiles
- Build numbers auto-incremented from TestFlight's latest build number

**Required environment variables for local builds:**

```bash
export ASC_API_KEY_ID="<key-id>"
export ASC_API_ISSUER_ID="<issuer-id>"
export ASC_API_KEY_P8_PATH="/path/to/AuthKey.p8"
```

**First-time setup:** Run `cd apps/mobile && bundle exec fastlane match init` to configure the certificate repository, then `bundle exec fastlane match appstore` to create certificates.

**TestFlight notes:**

- First build requires Apple review (~24-48h), subsequent builds are usually available instantly
- Internal testers are invited via App Store Connect → TestFlight → Internal Testing
- Testers install via the TestFlight app on their iOS device

## Mac App Store Deployment (Fastlane)

Single command to build and deploy to TestFlight (macOS):

```bash
cd apps/desktop && pnpm release:beta
```

For Mac App Store: `pnpm release:production`

**What it does:** CocoaPods install → match (fetch macOS signing creds) → sync version from `package.json` → `build_mac_app` (signed `.pkg`) → `upload_to_testflight` → post release notes

**Setup details:**

- App Store Connect App ID: `6760675784` (shared with iOS — multi-platform app)
- Bundle ID: `eu.drafto.mobile` (shared with iOS)
- Apple Developer Team ID: `4J2USPSG2U`
- Signing: Fastlane match with `platform: "macos"` (same Git repo as iOS certs)
- Build numbers auto-incremented from TestFlight's latest macOS build number

**Required environment variables for local builds:** Same as iOS (`ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, `ASC_API_KEY_P8_PATH`).

**CI workflows exist** (`desktop-beta-release.yml`, `desktop-production-release.yml`) but are not currently used — all builds run locally.

## Desktop Versioning

The desktop app version (`apps/desktop/package.json` → `version`) follows the same semver rules as mobile. Build numbers are auto-incremented by Fastlane from TestFlight.

**How to bump:** Run `pnpm version:desktop [patch|minor|major]` from the repo root, then commit the changed `package.json`. The CI workflow creates `desktop@X.Y.Z` tags on deploy.

**Same bump rules as mobile apply** (patch for fixes, minor for features, major for breaking changes).

## Automated Release Notes

Release notes are auto-generated from conventional commits and posted to both stores after each build submission.

**How it works:**

1. `apps/mobile/scripts/generate-release-notes.sh` extracts `feat:` and `fix:` commits since the last `mobile@*` git tag
2. `apps/mobile/scripts/post-release-notes.mjs` posts notes to Google Play (via Publisher API) and TestFlight (via App Store Connect API)
3. CI workflows call both scripts after successful build+submit

**Character limits:** Google Play: 500 chars, TestFlight "What to Test": 4000 chars.

**Required GitHub Secrets:**

| Secret                            | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY` | Google Play service account JSON         |
| `ANDROID_KEYSTORE_BASE64`         | Android upload keystore (base64-encoded) |
| `ANDROID_KEYSTORE_PASSWORD`       | Keystore password                        |
| `ANDROID_KEY_PASSWORD`            | Key password                             |
| `ANDROID_KEY_ALIAS`               | Android signing key alias                |
| `ASC_API_KEY_ID`                  | App Store Connect API Key ID             |
| `ASC_API_ISSUER_ID`               | App Store Connect Issuer ID              |
| `ASC_API_KEY_P8`                  | App Store Connect API private key (.p8)  |
| `MATCH_PASSWORD`                  | Fastlane match encryption passphrase     |
| `MATCH_GIT_PRIVATE_KEY`           | SSH key for match certificate Git repo   |

**Local usage (after building locally):**

```bash
cd apps/mobile
NOTES=$(bash scripts/generate-release-notes.sh --max-chars 500)
node scripts/post-release-notes.mjs --platform android --notes "$NOTES"
```
