# Drafto

A note-taking web app with notebooks, rich text editing, and auto-save. Built with Next.js, TypeScript, Tailwind CSS, and Supabase.

**Live:** [drafto.eu](https://drafto.eu)

## Tech Stack

- **Framework:** Next.js 16 (App Router, Turbopack)
- **Language:** TypeScript (strict mode)
- **Styling:** Tailwind CSS
- **Database & Auth:** Supabase (PostgreSQL + Row Level Security)
- **Editor:** BlockNote (block-based rich text)
- **Monitoring:** Sentry (errors), PostHog (analytics)
- **CI/CD:** GitHub Actions, Vercel, SonarCloud

## Features

- **Notebooks** — create, rename, delete notebooks to organize notes
- **Notes** — create and edit notes within notebooks, with relative timestamps
- **Rich text editor** — BlockNote-powered block editor with auto-save
- **Authentication** — email/password signup with email confirmation, password reset
- **User approval** — new accounts require admin approval before access
- **Row Level Security** — all data access enforced at the database level

## Getting Started

### Prerequisites

- Node.js (see `.nvmrc` for version)
- [pnpm](https://pnpm.io/)
- A [Supabase](https://supabase.com/) project

### Setup

1. Clone the repo and install dependencies:

```bash
git clone https://github.com/JakubAnderwald/drafto.git
cd drafto
pnpm install
```

1. Copy the env file and fill in your Supabase credentials:

```bash
cp .env.local.example .env.local
```

Required variables:

- `NEXT_PUBLIC_SUPABASE_URL` — your Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — your Supabase anon key

1. Push the database schema to your Supabase project:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

1. Start the dev server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Command                  | Description                  |
| ------------------------ | ---------------------------- |
| `pnpm dev`               | Start dev server (Turbopack) |
| `pnpm build`             | Production build             |
| `pnpm lint`              | ESLint                       |
| `pnpm format:check`      | Prettier check               |
| `pnpm test`              | Unit + integration tests     |
| `pnpm test:unit`         | Unit tests only              |
| `pnpm test:integration`  | Integration tests only       |
| `pnpm test:coverage`     | Tests with coverage report   |
| `pnpm test:e2e`          | Playwright E2E tests         |
| `pnpm exec tsc --noEmit` | Type check                   |

## Project Structure

```text
src/
  app/
    (app)/          # Authenticated app routes (notebooks, admin)
    (auth)/         # Auth routes (login, signup, forgot/reset password)
    api/            # API routes (notebooks, notes, admin)
    auth/           # Auth callback handler
  components/
    editor/         # BlockNote editor
    layout/         # App shell (three-panel layout)
    notebooks/      # Notebooks sidebar
    notes/          # Note list, note editor panel
  hooks/            # Custom hooks (auto-save)
  lib/
    api/            # API utilities
    supabase/       # Supabase client/server helpers, types
  env.ts            # Environment variable validation (t3-env + zod)
supabase/
  config.toml       # Supabase project config
  migrations/       # Database migrations
__tests__/
  unit/             # Unit tests (vitest)
  integration/      # Integration tests (vitest + testing-library)
e2e/                # E2E tests (Playwright)
docs/
  adr/              # Architecture Decision Records
```

## Architecture

The app uses a **three-panel layout**: notebooks sidebar, notes list, and editor. Data flows through Next.js API routes that use the Supabase server client, with Row Level Security enforcing access control at the database level.

Auth is handled via Supabase Auth with email confirmation. New users must be approved by an admin (`profiles.is_approved`) before they can access the app. Session refresh and approval checks run on every request via `middleware.ts` (the Next.js 16 `proxy.ts` convention is not yet adopted; the project retains `middleware.ts` for Edge runtime compatibility).

See [`docs/adr/`](./docs/adr/) for Architecture Decision Records.

## License

Private project.
