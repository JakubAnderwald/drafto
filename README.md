# Drafto

A note-taking app with notebooks, rich text editing, and auto-save. Available as a web app, iOS + Android apps, and a macOS desktop app — all with offline support.

**Live:** [drafto.eu](https://drafto.eu)

## Features

- **Notebooks** — flat list of notebooks to organize notes
- **Notes** — rich text with auto-save (BlockNote on web, TenTap on mobile/desktop)
- **Offline support** — mobile and desktop use WatermelonDB locally and sync to Supabase when online
- **Authentication** — email/password with email confirmation, plus Google and Apple OAuth; admin approval gates new accounts
- **Dark mode** — system-aware theme toggle, persisted in localStorage
- **Evernote import** — import notes from `.enex` files with full content and attachment support
- **MCP server** — expose your notes to Claude Desktop, Claude Cowork, and other MCP clients via `eu.drafto/mcp` on the [MCP Registry](https://registry.modelcontextprotocol.io)

See [`docs/features/`](./docs/features/) for one brief per functional area (code paths, ADRs, testing).

## Tech Stack

| Area       | Stack                                                                                |
| ---------- | ------------------------------------------------------------------------------------ |
| Web        | Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS v4, BlockNote |
| Mobile     | Expo 55, React Native 0.84, expo-router, TenTap editor, WatermelonDB                 |
| Desktop    | React Native macOS 0.81.5, TenTap editor, WatermelonDB (shared with mobile)          |
| Backend    | Supabase (Postgres + Auth + Storage + RLS)                                           |
| Hosting    | Vercel (web), Fastlane → App Store / Play Store / Mac App Store                      |
| Monitoring | Sentry (errors), PostHog (analytics)                                                 |
| Testing    | Vitest, Testing Library, Playwright, Jest, Maestro                                   |
| Monorepo   | pnpm workspaces + Turborepo                                                          |

Architecture deep-dive: [`docs/architecture/overview.md`](./docs/architecture/overview.md).

## Getting Started

### Prerequisites

- Node.js 22+
- [pnpm](https://pnpm.io/)
- A [Supabase](https://supabase.com/) project + [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started)
- [Playwright browsers](https://playwright.dev/) — `pnpm exec playwright install` (for E2E)

For mobile dev: [Expo CLI](https://docs.expo.dev/get-started/set-up-your-environment/), Android SDK, Xcode.
For desktop dev: Xcode, CocoaPods (`gem install cocoapods`), Ruby 3.3.7 via rbenv.

Full first-time setup guide: [`docs/operations/local-dev-setup.md`](./docs/operations/local-dev-setup.md).

### Setup

```bash
git clone https://github.com/JakubAnderwald/drafto.git
cd drafto
pnpm install

# Configure web env
cp apps/web/.env.local.example apps/web/.env.local
# Fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY

# Push schema to your Supabase project
supabase link --project-ref <your-project-ref>
supabase db push

# Run the dev server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

Dev commands live here. Build / release / deployment commands live in [`docs/operations/builds-and-releases.md`](./docs/operations/builds-and-releases.md).

| Command                | Description                          |
| ---------------------- | ------------------------------------ |
| `pnpm dev`             | Start dev server (all apps)          |
| `pnpm build`           | Production build                     |
| `pnpm lint`            | ESLint (all packages)                |
| `pnpm format:check`    | Prettier check                       |
| `pnpm test`            | Unit + integration tests             |
| `pnpm typecheck`       | TypeScript check                     |
| `pnpm migration:check` | Check migrations for destructive SQL |

Per-app test commands: [`docs/architecture/testing.md`](./docs/architecture/testing.md).

## Project Layout

```text
apps/
  web/       Next.js web app (App Router)
  mobile/    Expo + React Native iOS/Android
  desktop/   React Native macOS
packages/
  shared/    TypeScript types + constants (@drafto/shared)
supabase/
  migrations/
docs/
  features/       Per-area briefs (auth, notes, editor, sync, search, MCP, …)
  architecture/   System shape (overview, environments, testing)
  operations/     Runbooks (local-dev-setup, builds-and-releases, migrations)
  adr/            Architecture Decision Records
  archive/        Historical plans (not source of truth)
```

Full index: [`docs/README.md`](./docs/README.md).

## Contributing

All work goes through branches + PRs — see [`CLAUDE.md`](./CLAUDE.md) for the project conventions (worktree workflow, SOLID, testing requirements, production safety rails). Decisions are recorded in [`docs/adr/`](./docs/adr/).

## License

Private project.
