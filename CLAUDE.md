# Drafto

Note-taking app at drafto.eu. Monorepo with pnpm workspaces + Turborepo. Web (Next.js 16, React 19, Supabase), iOS + Android (Expo / React Native), macOS (React Native macOS). Mobile and desktop are offline-first via WatermelonDB.

## Where to find things

| Need                                                          | Start at                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| What a feature does and where it lives in code                | [`docs/features/`](./docs/features/)                                                                                           |
| System shape, data flow, platform parity                      | [`docs/architecture/`](./docs/architecture/)                                                                                   |
| Testing matrix (commands per platform)                        | [`docs/architecture/testing.md`](./docs/architecture/testing.md)                                                               |
| Environments, Supabase refs, migration workflow               | [`docs/architecture/environments.md`](./docs/architecture/environments.md)                                                     |
| Local machine setup                                           | [`docs/operations/local-dev-setup.md`](./docs/operations/local-dev-setup.md)                                                   |
| Cloud / mobile sessions — personal skills, what carries over  | [`docs/operations/cloud-sessions.md`](./docs/operations/cloud-sessions.md)                                                     |
| Builds, Fastlane, App Store / Play / Mac releases             | [`docs/operations/builds-and-releases.md`](./docs/operations/builds-and-releases.md)                                           |
| Desktop (macOS) builds from any checkout after `pnpm install` | [ADR-0067](./docs/adr/0067-desktop-moves-to-react-native-macos-0-83.md) · [`apps/desktop/CLAUDE.md`](./apps/desktop/CLAUDE.md) |
| Supabase migration safety workflow                            | [`docs/operations/migrations.md`](./docs/operations/migrations.md)                                                             |
| Why a tech / pattern was chosen                               | [`docs/adr/`](./docs/adr/README.md)                                                                                            |
| Dark factory pipeline (kanban-driven autopilot)               | [`docs/features/dark-factory.md`](./docs/features/dark-factory.md)                                                             |
| Full index                                                    | [`docs/README.md`](./docs/README.md)                                                                                           |

Historical plans live in [`docs/archive/`](./docs/archive/) — do not treat as source of truth.

## Infrastructure cost discipline

Drafto runs on free / already-paid-for tiers. Before proposing any new paid service (Cloudflare Workers, Postmark, Inngest, an additional Supabase project, etc.), exhaust what's already in place:

- **Vercel free tier** for the web app (with the existing cron at `/api/cron/cleanup-trash`).
- **Supabase free tier** for both prod (`tbmjbxxseonkciqovnpl`) and dev (`huhzactreblzcogqkbsd`) projects.
- **Resend free tier** (3k/month, 100/day) for outbound transactional email — already verified on `drafto.eu`.
- **Zoho Mail Forever Free** for inbound `support@drafto.eu` (EU data centre, MX `mx.zoho.eu`) — the dedicated `support@drafto.eu` user is OAuthed by `scripts/support-agent.sh`. See [`docs/features/support-agent.md`](./docs/features/support-agent.md) and [ADR-0024](./docs/adr/0024-realtime-support-agent.md).
- **Mac mini** for scheduled agent work — already runs `scripts/support-agent.sh` (every 5 min, real-time support pipeline), `scripts/nightly-support.sh` (00:03), and `scripts/nightly-audit.sh` (05:00) via launchd, has `gh` CLI authenticated, and runs Claude Code with `--dangerously-skip-permissions` on an existing paid subscription.
- **GoDaddy** registrar / DNS (don't assume Cloudflare; Cloudflare is not the DNS provider).
- **CodeRabbit free tiers** — the PR bot runs on the free OSS tier (public repo), and the factory's gap-fill lane uses the free CodeRabbit CLI allowance (3 reviews/hr) on the Mac mini to review commits the bot skipped. No usage-based add-on; the factory never passes `--use-credits`. See [ADR-0036](./docs/adr/0036-factory-coderabbit-cli-gap-fill.md).

If a feature genuinely requires paid infrastructure, surface that explicitly as a tradeoff and let the user decide. Don't silently introduce new monthly line items.

## Worktree Workflow (Required)

Never work directly on `main`. For every new task (feature, fix, chore, docs):

1. Use the `/worktree` command to create an isolated branch and worktree
2. **Immediately run `pnpm install`** in the new worktree — worktrees do not share `node_modules`, so all tooling (`turbo`, `tsc`, etc.) will fail without this step, then run `bash scripts/worktree-bootstrap.sh` to copy the gitignored env/config files (see below). A worktree can build the macOS desktop app too. Only when the task calls for a desktop build, also run `bundle install` in `apps/desktop` after these two steps; [Release Authorization](#release-authorization) says which commits `pnpm release:beta` may build. See also [`apps/desktop/CLAUDE.md`](./apps/desktop/CLAUDE.md).
3. Do all work (commits, edits, tests) in that worktree
4. Open a PR to merge into `main` — never push directly to `main`

**Only exception:** The user explicitly asks to work on or push to `main` directly. Without that explicit request, always use a branch + PR.

**Worktree setup for web/mobile/desktop development:**

Git worktrees do not copy gitignored files, so a fresh worktree is missing the
`.env*` files (and a couple of other local config files) needed to build and test
the web, mobile, and desktop apps. Without the web `.env.local`, even
`pnpm --filter @drafto/web build` fails at "Collecting page data" with
`Invalid environment variables` for `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY`.

The one-step fix — run this right after `pnpm install`:

```bash
bash scripts/worktree-bootstrap.sh
```

It copies every known gitignored env/config file from the main repo
(`/Users/jakub/code/drafto`, override with `DRAFTO_MAIN_REPO`) into the current
worktree, and is safe to re-run. If you'd rather copy by hand, the full set is:

```bash
# Web (Supabase + Sentry keys; clears the NEXT_PUBLIC_SUPABASE_* env-validation errors)
cp /Users/jakub/code/drafto/apps/web/.env.local apps/web/.env.local
cp /Users/jakub/code/drafto/apps/web/.env.local.vercel apps/web/.env.local.vercel

# Mobile (required for mobile builds and Maestro E2E tests)
cp /Users/jakub/code/drafto/apps/mobile/.env apps/mobile/.env
cp /Users/jakub/code/drafto/apps/mobile/.env.production apps/mobile/.env.production

# Desktop (required for desktop builds)
cp /Users/jakub/code/drafto/apps/desktop/.env apps/desktop/.env
cp /Users/jakub/code/drafto/apps/desktop/.env.production apps/desktop/.env.production

# Required after expo prebuild (regenerates android/ without local.properties)
echo "sdk.dir=/Users/jakub/Library/Android/sdk" > apps/mobile/android/local.properties
```

> Note: `APP_URL` is the one required server-only variable. Locally it lives in
> `apps/web/.env.local` as `http://localhost:3000` (see `.env.local.example`), and
> Vercel sets the real value at deploy time. Without it, `pnpm dev`, `pnpm test:e2e`
> and `pnpm --filter @drafto/web build` all fail env validation. The other server-only
> secrets in `turbo.json`'s `passThroughEnv` (`SUPABASE_SERVICE_ROLE_KEY`,
> `RESEND_API_KEY`, …) are optional and not in `.env.local`, so the features that
> need them (approval emails, the admin page) stay off locally. The dev live tests are
> the exception: on the Mac mini the **dev** project's service-role key is in
> `~/drafto-secrets/dev-supabase-admin.env`, and interactive sessions run those tests
> with `pnpm test:live:supabase`, which reads it from there (see
> [Local Secrets](#local-secrets-drafto-secrets)). The other server-only secrets stay
> unset locally. CI sets `SKIP_ENV_VALIDATION=true`, so it never notices a required
> var missing from `.env.local.example`. Keep the two in sync. The bootstrap script
> only handles the gitignored _files_.

**Metro port conflicts:** The main repo may have Metro running on port 8081. On Android, in a worktree, start Metro on a different port (`pnpm start --port 8082`) and use `adb reverse tcp:8081 tcp:8082` to redirect the app. `adb reverse` doesn't exist for the iOS simulator, which always loads from 8081, so stop the other Metro first. Under Xcode 27, `pnpm ios` fails; see [Mobile debug builds](./docs/architecture/testing.md#mobile-debug-builds).

**Worktree git gotchas:**

- **Cannot checkout `main`**: In a worktree, `main` is already checked out by the original repo. To create a new branch from latest main, use: `git fetch origin main && git checkout -b <branch> origin/main`
- **Cannot merge PRs with `--delete-branch`**: `gh pr merge --delete-branch` fails because it tries to switch to `main` locally. Instead use the GitHub API — `--method PUT` is required, because the merge endpoint is a PUT while `gh api` switches to POST as soon as any `-f` field is present, and a POST there returns a bare `404 Not Found`: `gh api --method PUT repos/{owner}/{repo}/pulls/{number}/merge -f merge_method=squash`. Delete the remote branch afterwards with `gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/<branch>`.
- **Fastlane in worktrees**: Worktrees do not share Ruby gems. Run `bundle install` in the worktree's `apps/mobile/` (or `apps/desktop/`) directory before using Fastlane commands. Also copy `google-play-service-account.json` if needed for store submissions.

## Parallel Tool Execution

When planning, fan out independent actions into a single batched message — don't serialise across turns. Only stay sequential when a tool genuinely needs a prior tool's output (e.g., commit after edits, push after commit).

**High-yield cases in this repo:**

- **Cross-platform mirror edits**: `apps/mobile/src/db/` and `apps/desktop/src/db/` must stay in sync (schema, migrations, models). Batch all 6 file edits in one message — never edit one platform, then the other.
- **Cross-platform UI**: files like `note-editor.tsx` on desktop and mobile are different files with no dependency — batch, don't serialise.
- **Verification sweep**: `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, per-app `pnpm --filter … test`, and `pnpm --filter=@drafto/shared test` are independent — fan out in one message.
- **Exploration**: Launch multiple `Explore` subagents in one message when scoping work across separate areas.

**Worktree gotcha**: `Edit`/`Write` require a prior `Read` of the _exact_ path. Reading `/Users/…/drafto/foo.ts` does NOT satisfy an edit against `/Users/…/drafto-worktree/foo.ts`. Pattern when starting work in a worktree: one batched `Read` for every worktree file you'll touch, then one batched `Edit`/`Write` for all the changes.

**Plan structure**: Multi-PR or multi-step plans should also exploit parallelism — group independent work into "waves" (Wave 1 fully parallel, Wave 2 after Wave 1, etc.) and assign each independent unit to its own subagent. End any plan that ships a cross-platform change with the **beta** release wave — that is the pre-authorized one: web (Vercel auto-deploys on merge), `cd apps/mobile && pnpm release:beta:android`, `pnpm release:beta:ios`, `cd apps/desktop && pnpm release:beta` (from any checkout after `pnpm install`; its preflight refuses a stale install — see [Release Authorization](#release-authorization)). The three store lanes run concurrently in their own subagents. Note any required version bumps (`pnpm version:mobile|desktop patch|minor|major`) before that wave.

Public-store release is **not** part of the default plan. Plan it only once the user has explicitly approved it and a beta build has actually been tested, as a separate wave after the beta one: `cd apps/mobile && pnpm release:promote:ios`, `cd apps/desktop && pnpm release:promote`, and Play production via `pnpm release:prod:android` or the Play Console. The Apple `promote` lanes submit the exact build TestFlight testers validated instead of rebuilding, so they compile nothing; the rebuild path (`pnpm release:prod:ios` / `pnpm release:production`) stays available for hotfixes and compiles from the checkout like a beta, dependency preflight included.

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
- Named exports only (no default exports except for Next.js pages/layouts, Next.js metadata routes such as `robots.ts` and `sitemap.ts`, and Expo Router route modules under `apps/mobile/app/`, which the router requires to default-export their screen)
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
- A new table or view in `public` needs explicit `GRANT`s in the migration that creates it, and a view also needs `security_invoker = true`. Supabase stops auto-granting the Data API roles on 2026-10-30, and `pnpm migration:check` fails without them. See [`docs/operations/migrations.md`](./docs/operations/migrations.md#new-tables-need-explicit-grants)

## Git Conventions

- Branch naming: `feat/`, `fix/`, `chore/`, `docs/` prefixes
- Conventional commits enforced by commitlint (e.g., `feat: add login page`)
- Squash-merge PRs to keep main history clean
- Pre-commit hooks run lint-staged (ESLint + Prettier)
- **Never commit or push directly to `main`** unless the user explicitly requests it. All work goes through feature branches and PRs. Two committed `PreToolUse` hooks enforce this — they parse the command and block anything that would land on `main`/`master`, including via `cd`, `git -C`, or a `HEAD:main` refspec ([claude-code-hooks.md](./docs/operations/claude-code-hooks.md))
- **All pushes must use the `/push` command** — this ensures commits are pushed, CI/CD checks are polled until green, review comments are addressed, and failures are fixed automatically
- **Before `/push`, run `/code-review` on the pending diff** for any non-trivial change (anything beyond typos, comment edits, or pure renames). Fix or explicitly explain its findings before opening the PR — this catches the same class of issues CodeRabbit catches (mirror-invariant violations, stale doc references, missed edge cases), locally, and saves the post-PR round-trip
- **Every review comment blocks the merge.** `required_conversation_resolution` is enabled on `main`, and the factory's `--release` verifies it rather than clearing it. Address each review thread — fix it, or decide no change is needed — then reply on the thread saying which and why, and resolve it. Never resolve a thread you did not act on. The factory enforces the same contract on its own PRs via a code-review stage in `--watch` ([ADR-0035](./docs/adr/0035-factory-code-review-gate.md))

## Release Authorization

Beta TestFlight builds (Mac App Store Connect, iOS, Android internal track) are **pre-authorized** — ship them without asking. Communicate what's going out (version + build number, what's in it) but don't gate on permission. A bad TestFlight build is reversible: the next build supersedes it, and old builds can be expired in App Store Connect.

Production / public-store releases still require explicit user approval — those affect non-tester users. That covers the Apple App Review submission lanes (`cd apps/mobile && pnpm release:promote:ios`, `cd apps/desktop && pnpm release:promote`), the rebuild-and-upload hotfix lanes (`pnpm release:prod:*`, `pnpm release:production`), and any App Store / Play Store submission or public release done by hand.

### Desktop (macOS) builds from any checkout after `pnpm install`

The macOS desktop app is on `react-native-macos` 0.83.0, which uses the same React 19.2 and `react-native` 0.83.10 as mobile ([ADR-0067](./docs/adr/0067-desktop-moves-to-react-native-macos-0-83.md)). The old "fossil" rule — build only from the primary checkout's never-reinstalled `node_modules` — is retired.

- Build from any checkout, worktrees included: `pnpm install` → `bash scripts/worktree-bootstrap.sh` → `cd apps/desktop && bundle install` → `pnpm release:beta`.
- A normal beta release builds merged `main`: the primary checkout after `git pull && pnpm install`, or a worktree of `origin/main`. The lane tags that commit `desktop@<version>+<build>` and pushes the tag, and the next release's notes start from it.
- A pre-merge test build of an unmerged branch (a card in In Test) runs as `DRAFTO_INTEST_ISSUE=<issue> pnpm release:beta`. The lane then skips the tag and posts the build number on the card. The factory's pre-merge dispatch and the In Test manual commands set it. Without it, the lane tags the unmerged commit as a release.
- The Fastfile's `build_and_submit` lane runs a dependency preflight before CocoaPods. It refuses to build unless the installed `node_modules/react-native-macos` matches the version in `apps/desktop/package.json` and `node_modules/react` is 19.2.x. If it refuses, run `pnpm install`. `assertDesktopDeps()` in `scripts/lib/dispatch-release.mjs` checks the same thing before the factory spawns a desktop lane.
- The factory's desktop build root `/Volumes/DraftoFactory/drafto-beta-desktop` (on the factory's build volume, [ADR-0060](./docs/adr/0060-dedicated-factory-build-volume.md)) installs dependencies like the mobile one.
- Native fixes to `react-native-macos` go in `patches/` as a `pnpm patch`. Each `react-native-macos` release arrives in Dependabot's `react-native` group PR, together with `react-native` and desktop's `@react-native/*` tooling, which must match rnm's `react-native` peer (an rnm minor needs them raised by hand, and waits for an Expo SDK that supports its `react-native`); merge it only after a TestFlight build that opens a note.
- **A green compile is not proof the app works — only a TestFlight build that opens a note is.** CI doesn't build macOS.
- **One-time:** before the primary checkout's first `pnpm install` after ADR-0067 merges, take the clonefile snapshot of the old fossil described in [`docs/operations/desktop-build-fossil.md`](./docs/operations/desktop-build-fossil.md), and keep it until a post-merge TestFlight build opens a note.
- Full rules: [ADR-0067](./docs/adr/0067-desktop-moves-to-react-native-macos-0-83.md) · [ADR-0030](./docs/adr/0030-in-test-scenarios-and-pre-merge-betas.md) · [`apps/desktop/CLAUDE.md`](./apps/desktop/CLAUDE.md).

## Dark Factory

Drafto runs an unattended development pipeline on the Mac mini ("dark factory") that watches a GitHub Projects v2 board and drives issues through plan → implement → preview → **verify** → ship. State lives in `status:*` labels mirrored from the board's Status field, plus `logs/factory-state.json`. The verify step is the factory-owned **Testing** column (off unless `FACTORY_VERIFY=1`): the factory runs the test scenario itself and posts a report before a human tests at In Test. The report is evidence, never a gate ([`docs/features/factory-verification.md`](./docs/features/factory-verification.md), [ADR-0053](./docs/adr/0053-pre-in-test-verification-stage.md)). See [`docs/features/dark-factory.md`](./docs/features/dark-factory.md) for the operator manual, [`docs/operations/factory-runbook.md`](./docs/operations/factory-runbook.md) for phase promotion + rollback, and [ADR-0026](./docs/adr/0026-dark-factory-pipeline.md) for the decision.

**Creating factory issues:** Issues are **not** auto-added to the board — neither `gh issue create` nor the web issue form adds them. Always pass `--project "Drafto Factory"` when creating one via the CLI so the card lands on the [board](https://github.com/users/JakubAnderwald/projects/1) and the factory can pick it up:

```bash
gh issue create --project "Drafto Factory" --title "feat: ..." --body-file spec.md
```

`gh` can't fill in the issue form: `--template` is rejected when `--body`/`--body-file` is given. So `spec.md` must use the form's rendered headings, which `parseSpec` (`scripts/lib/factory-bundle.mjs`) and the spec gate read: `### What`, `### Acceptance criteria`, `### Affected platforms` (checkbox lines such as ``- [x] web (`apps/web`)``), `### Schema changes?` (`no` or `yes`), `### UI design (if applicable)` and `### Out of scope`. Copy an existing factory issue's body as a starting point.

(Requires the `gh` token to carry `project` scope — run `gh auth refresh -s project` once if `--project` errors with a missing-scope message.)

**Two human gates** the factory will never bypass: Plan Review → In Progress (plan-approval) and In Test → Approved (merge + ship). A plan-stage browser probe ([ADR-0071](./docs/adr/0071-plan-stage-browser-probe.md)) is evidence for the plan, not implementation, so it doesn't bypass the plan-approval gate. Both gates are reachable via the kanban board for any reporter, and via email reply for allowlisted reporters (Jakub + his wife). The migration gate (`migration-approved` label required when a PR touches `supabase/migrations/**`) is a hard stop on the Approved transition for everyone. The hosted-config gate holds a PR that changes `supabase/config.toml` in In Review, at every pre-merge beta dispatch and before the merge, until dev and prod have the Redirect URLs it adds (the factory probes them) and, for any other setting or a Redirect URL it can't probe, the `hosted-config-applied` label is on the PR ([ADR-0065](./docs/adr/0065-factory-hosted-config-gate.md)).

**Kill switches**: per-card via `factory-pause` label or dragging to **Blocked**; global via `node scripts/lib/state-cli.mjs factory:pause`; emergency via `launchctl unload ~/Library/LaunchAgents/eu.drafto.factory.plist`.

**Browser access**: only the locked-down browser runner (`run_browser_task` in `scripts/factory-agent.sh`) may pass `--chrome`; every other `claude` call in the factory, support and nightly scripts passes `--no-chrome`. Every factory, support and nightly call also passes `--strict-mcp-config`, so the operator's claude.ai connectors (Gmail, Drive, Calendar…) never load in an unattended session. It drives this Mac mini's own Chrome profile, so keep it that way. See [ADR-0051](./docs/adr/0051-factory-browser-runner.md). One exception to "previews through the browser's Vercel login" is the verification shell lane: it reaches per-commit previews with the Vercel protection-bypass secret, from a mode-600 file and only through its curl wrapper (`preview-curl`). Never create or fetch that secret with `vercel curl` ([ADR-0053](./docs/adr/0053-pre-in-test-verification-stage.md)). That lane's claude call lives in node (`scripts/lib/verify-lane.mjs`), not in the bash scripts: `--no-chrome --strict-mcp-config`, `dontAsk` with Bash/Read/Grep/Glob only, under its own guard hook (`scripts/lib/verify-guard.mjs`), never `--dangerously-skip-permissions`. The other exception is the plan probe's header capture: it reads the same secret in bash (node), passes it to curl on stdin, and keeps only an allowlist of security headers ([ADR-0071](./docs/adr/0071-plan-stage-browser-probe.md)).

**Parity-mandate enforcement**: the factory's `--implement` post-check diffs the PR against the issue's "Affected platforms" checkboxes and blocks the card if a claimed platform has no code changes. To run a legitimate single-platform feature, apply `parity:web-only` / `parity:mobile-only` / `parity:desktop-only` to the issue. For a factory-internal change that touches no app platform (under `scripts/`, docs, CI), tick the **None** box in the issue form (or apply the `parity:infra-only` label) — the spec gate skips the "Affected platforms" requirement and the parity check passes as long as the PR stays out of `apps/` and `packages/shared/`.

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
- Always run `pnpm migration:check` before pushing migrations. It also fails a new migration whose version doesn't sort after the newest one on main (`supabase db push` refuses those), so update the branch from main first, and rename with the `git mv` it prints. See [`docs/operations/migrations.md`](./docs/operations/migrations.md#migration-versions-must-sort-last)
- Before `supabase db push`, verify the linked project ref with `supabase projects list` (prod `tbmjbxxseonkciqovnpl`, dev `huhzactreblzcogqkbsd`)
- Require explicit user "yes" before any production database operation — state the target project, operation, and affected data before asking

## Environment Variables

- Declare all env vars in `src/env.ts` using zod schemas
- Access via `import { env } from "@/env"` — never use `process.env` directly
- See `.env.local.example` for required variables

## Local Secrets (`~/drafto-secrets/`)

Machine-local secrets live as files in `~/drafto-secrets/` on the MacBook Air and the Mac mini, outside the repo. The folder is mode 700 and each file 600; write new ones under `umask 077`. Never commit them, and never paste a value into a doc, issue, PR or chat. `source` the file and use the variable **without printing it**: no `echo $VAR`, no `cat`, nothing that puts the value in a transcript or log.

The recipes below are for interactive sessions. Unattended factory, support and nightly sessions use only the secrets their own scripts load, and the factory's verify lane reaches previews only through `preview-curl` ([ADR-0053](./docs/adr/0053-pre-in-test-verification-stage.md)).

- **`vercel-env.sh`** → `VERCEL_PROTECTION_BYPASS_DRAFTO`. The Vercel "Protection Bypass for Automation" secret for the drafto project: it lets a request skip the Vercel SSO wall on a protected preview deployment. The factory's verify lane reads its own copy, `vercel-bypass.env`. The Mac mini has no `vercel-env.sh`, only that factory copy, so on the Mac mini ask the user before using it. Previews use the dev Supabase project, so a production `dk_` key gets a 401 there.

  ```bash
  source ~/drafto-secrets/vercel-env.sh
  curl "https://drafto-git-<branch>-jakubanderwalds-projects.vercel.app/api/mcp" \
    -H "x-vercel-protection-bypass: $VERCEL_PROTECTION_BYPASS_DRAFTO" \
    -H "Authorization: Bearer <dk_ app key>" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" -d '{...}'
  ```

- **`sentry-read.sh`** → `SENTRY_READ_TOKEN`. A read-only Sentry personal token (`event:read org:read project:read`), one per machine, named `claude-code read-only (<machine>)`. Use it to query errors, traces and spans.
  - The org `jakub-anderwald` is in Sentry's EU region, so call `https://de.sentry.io`. The drafto project ID is `4510937249480784`.
  - The tokens in `~/.sentryclirc` and `apps/web/.env.local` only upload source maps; reads with them get a 403.
  - If the file is missing on a machine, ask the user instead of creating a token.
  - To filter or group differently, change `query` and `field`. For example, `--data-urlencode 'query=http.target:/api/mcp' --data-urlencode 'field=user.ip'` counts `/api/mcp` spans per client IP.

  ```bash
  source ~/drafto-secrets/sentry-read.sh
  curl -s -G -H "Authorization: Bearer $SENTRY_READ_TOKEN" \
    "https://de.sentry.io/api/0/organizations/jakub-anderwald/events/" \
    --data-urlencode 'dataset=spans' --data-urlencode 'statsPeriod=24h' \
    --data-urlencode 'project=4510937249480784' \
    --data-urlencode 'field=transaction' --data-urlencode 'field=count()' --data-urlencode 'sort=-count()'
  ```

- **`dev-supabase-admin.env`** → `DEV_SUPABASE_URL`, `DEV_SUPABASE_SERVICE_ROLE_KEY`. The **dev** project's URL and service-role key (`huhzactreblzcogqkbsd`, never prod), on the Mac mini. The key bypasses RLS on dev, so use it from interactive sessions only and never print it. The factory reads it to mint the browser runner's one-time preview sign-in link ([ADR-0051](./docs/adr/0051-factory-browser-runner.md)) and, when switched on, for the verification lane's `dev-inspect` and `live-tests` wrappers, each in its own process so the session never sees the key ([ADR-0073](./docs/adr/0073-factory-verification-data-checks-live-tests-uploads-admin-js.md)).
  - Use it through `pnpm test:live:supabase`, which runs the dev live tests, rather than sourcing it. Add `-- --only profile-guard|account-deletion` to run one test, or `-- --dry-run` to see the plan.
  - The runner falls back to the `DEV:` line of the MacBook Air's `supabase service keys.txt` when this file is missing and no `--key-file` was given, and reads the anon key from `apps/web/.env.local`. It refuses any project but dev and prints file and variable names, never values.
  - It sets `DRAFTO_LIVE_REQUIRED=1`, so a missing key fails the run instead of skipping it. The tests create users on dev and delete them again.
  - It refuses unattended sessions, before reading any key file. The factory, support and nightly scripts export `DRAFTO_UNATTENDED=1`, and the verification lane sets it in every process it starts, with one exception: with `FACTORY_VERIFY_LIVE_TESTS=1`, the lane's supervisor runs the scenario's live tests at the PR head before the session starts, in a scrubbed process without it, and the session sees only each test's name and outcome ([ADR-0073](./docs/adr/0073-factory-verification-data-checks-live-tests-uploads-admin-js.md)). It also refuses a run under `node --test`. The lane's guard separately denies any command naming the runner or a `test:live` script.

- **Other files** are documented with the feature that uses them; search `docs/` for `drafto-secrets`. They cover signing and App Store Connect ([builds-and-releases.md](./docs/operations/builds-and-releases.md)), the support agent ([support-agent.md](./docs/features/support-agent.md)), the MCP registry key ([mcp-server.md](./docs/features/mcp-server.md)), Sign in with Apple ([auth.md](./docs/features/auth.md)), the Supabase service-role keys ([offline-sync.md](./docs/features/offline-sync.md)) and the account-approval regression tests (`apps/web/e2e/regression/account-approval/README.md`).

## Error Handling

- Errors flow through Sentry automatically (`@sentry/nextjs`)
- Client config: `instrumentation-client.ts` (NOT `sentry.client.config.ts` — Turbopack ignores the old webpack convention)
- Server/edge configs: `sentry.server.config.ts`, `sentry.edge.config.ts` (loaded via `instrumentation.ts`)
- Do not swallow errors silently — let them propagate to Sentry
- To read Sentry data from a session, use the read-only token in [Local Secrets](#local-secrets-drafto-secrets)

## MCP Server (Claude Cowork Integration)

Full reference with all 9 tools enumerated, auth model, and registry publishing steps: [`docs/features/mcp-server.md`](./docs/features/mcp-server.md).

**Maintenance rules (agents must follow):**

- When adding a new user-facing feature (API route, data model, capability), evaluate whether it should be exposed as an MCP tool and update `apps/web/src/app/api/mcp/route.ts` and `apps/web/src/lib/api/mcp-tools.ts` accordingly
- When changing an existing API route's behavior or schema, update the corresponding MCP tool handler and its input/output schemas to match
- When adding or modifying database tables/columns that affect note content or structure, update `packages/shared/src/editor/markdown-converter.ts` if the new content type needs Markdown representation
- After changing any MCP tool, bump `version` in `server.json` and run `~/bin/mcp-publisher publish`
- Run MCP-related tests: `cd apps/web && pnpm test` (includes mcp-auth and api-keys tests)

## Privacy Policy Maintenance

The policy at [drafto.eu/privacy](https://drafto.eu/privacy) (`apps/web/src/app/privacy/page.tsx`) is linked from the App Store and Play listings, so it must describe what the apps actually do. Processor inventory, code locations and the guard test: [`docs/features/privacy-policy.md`](./docs/features/privacy-policy.md).

**Maintenance rules (agents must follow):** update `apps/web/src/app/privacy/page.tsx` — and its "Last updated" date — in the **same PR** whenever a change:

- adds, removes, or swaps a third-party service or SDK that receives user data (analytics, error tracking, email, AI, auth provider, hosting, storage)
- collects a new category of personal data, or a new field on the user or account
- changes where data is stored, how long it's kept, or how it's deleted (retention jobs, trash, account deletion)
- adds a way for data to leave Drafto (export, sharing, API keys, integrations)
- changes the auth or session-storage mechanism on any platform
- sends user or support data to an AI model

Also:

- When a new route must be reachable signed out (legal, support, store-review pages), add it to `PUBLIC_ROUTES` in `apps/web/src/lib/supabase/middleware.ts` and to `apps/web/__tests__/unit/middleware.test.ts`
- When you add a dependency that receives user data, map it to its processor in `apps/web/__tests__/unit/privacy-policy-processors.test.tsx` — the test fails until the processor has a row in the page's sharing table. It reads only `package.json` files, so a service reached over plain `fetch` or a script on the Mac mini needs the manual check above
- A factory card ticked **None** / `parity:infra-only` (e.g. a support-pipeline change under `scripts/`) that triggers these rules is not infra-only: the infra-only parity check rejects the `apps/web` policy edit, so untick **None** and remove the `parity:infra-only` label, then tick the web platform (ticking web alone fails the spec gate, which rejects None / infra-only combined with a platform box)

## Useful Commands

Dev + verification only. Build and release commands live in [`docs/operations/builds-and-releases.md`](./docs/operations/builds-and-releases.md).

```bash
pnpm dev              # Start dev server (all apps via Turborepo)
pnpm build            # Production build (all packages)
pnpm lint             # ESLint (all packages)
pnpm format:check     # Prettier check
pnpm test             # Unit + integration tests (all packages)
pnpm typecheck        # TypeScript check (all packages)
pnpm migration:check  # Check migrations for destructive SQL, missing Data API grants, and new versions that sort before main's newest
```

## Local Dev Setup

See [`docs/operations/local-dev-setup.md`](./docs/operations/local-dev-setup.md) for first-time machine setup (CLI tools, Fastlane, Claude Code memory symlink).
