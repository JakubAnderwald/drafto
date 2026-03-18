# Drafto

A note-taking app with notebooks, rich text editing, and auto-save. Available as a web app and a mobile app with offline support.

**Live:** [drafto.eu](https://drafto.eu)

## Tech Stack

### Monorepo

- **Package manager:** pnpm workspaces
- **Orchestration:** Turborepo
- **Language:** TypeScript (strict mode)
- **Formatting:** Prettier + ESLint
- **Git hooks:** Husky + lint-staged + commitlint (conventional commits)

### Web (`apps/web/`)

- **Framework:** Next.js 16 (App Router, Turbopack)
- **UI:** React 19, Tailwind CSS v4 + custom design system (CSS variables)
- **Editor:** BlockNote (block-based rich text)
- **Database & Auth:** Supabase (PostgreSQL + Row Level Security)
- **Env validation:** t3-env + Zod
- **Monitoring:** Sentry (errors), PostHog (analytics)
- **Testing:** Vitest + Testing Library (unit/integration), Playwright (E2E)

### Mobile (`apps/mobile/`)

- **Framework:** Expo 55 + React Native 0.84
- **Navigation:** expo-router
- **Editor:** TenTap Editor (WebView-based TipTap)
- **Local database:** WatermelonDB (SQLite, offline-first with Supabase sync)
- **Testing:** Jest + Testing Library React Native (unit), Maestro (E2E)

### Shared (`packages/shared/`)

- Shared TypeScript types (`Database`, API types) and constants, consumed by both web and mobile

### Infrastructure

- **Backend:** Supabase (Postgres + Auth + Storage + Realtime) — two isolated projects for dev and prod
- **Web hosting:** Vercel (with preview deployments)
- **Mobile CI/CD:** EAS Build — Google Play (internal testing) and TestFlight
- **CI:** GitHub Actions, SonarCloud (code quality)

## Features

- **Notebooks** — create, rename, delete notebooks to organize notes
- **Notes** — create and edit notes within notebooks, with relative timestamps
- **Rich text editor** — block editor with auto-save (BlockNote on web, TenTap on mobile)
- **Offline support** — mobile app works offline via WatermelonDB, syncs when back online
- **Dark mode** — system-preference-aware theme toggle with localStorage persistence
- **Authentication** — email/password signup with email confirmation, password reset
- **User approval** — new accounts require admin approval before access
- **Evernote import** — import notes from Evernote `.enex` files with full content and attachment support
- **Row Level Security** — all data access enforced at the database level

## Environments

| Environment     | Supabase Project | Supabase Ref           | Used By                              |
| --------------- | ---------------- | ---------------------- | ------------------------------------ |
| **Production**  | drafto.eu        | `tbmjbxxseonkciqovnpl` | Vercel production deploy (drafto.eu) |
| **Development** | drafto-dev       | `huhzactreblzcogqkbsd` | Local dev, Vercel previews, CI/E2E   |

Sentry and PostHog use a single project each with environment tagging to distinguish data.

### Migration Workflow

Apply migrations to dev first, verify, then apply to production:

```bash
pnpm supabase:link:dev   # Link CLI to dev project
pnpm supabase:push       # Apply migrations to dev
# Verify everything works
pnpm supabase:link:prod  # Link CLI to prod project
pnpm supabase:push       # Apply migrations to prod
```

## Getting Started

### Prerequisites

- Node.js 22+
- [pnpm](https://pnpm.io/)
- A [Supabase](https://supabase.com/) project
- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started) — for migrations and DB management
- [Playwright browsers](https://playwright.dev/) — `pnpm exec playwright install` for E2E tests

For mobile development:

- [Expo CLI](https://docs.expo.dev/get-started/set-up-your-environment/)
- Android SDK (for Android builds)
- Xcode (for iOS builds on macOS)

### Setup

1. Clone the repo and install dependencies:

```bash
git clone https://github.com/JakubAnderwald/drafto.git
cd drafto
pnpm install
```

1. Copy the env file and fill in your Supabase credentials:

```bash
cp apps/web/.env.local.example apps/web/.env.local
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

### Root (Turborepo)

| Command                | Description                          |
| ---------------------- | ------------------------------------ |
| `pnpm dev`             | Start dev server (all apps)          |
| `pnpm build`           | Production build                     |
| `pnpm lint`            | ESLint (all packages)                |
| `pnpm format:check`    | Prettier check                       |
| `pnpm test`            | Unit + integration tests             |
| `pnpm typecheck`       | TypeScript check                     |
| `pnpm migration:check` | Check migrations for destructive SQL |

### Web (`apps/web/`)

| Command                 | Description              |
| ----------------------- | ------------------------ |
| `pnpm test`             | Unit + integration tests |
| `pnpm test:unit`        | Unit tests only          |
| `pnpm test:integration` | Integration tests only   |
| `pnpm test:coverage`    | Tests with coverage      |
| `pnpm test:e2e`         | Playwright E2E tests     |
| `pnpm typecheck`        | Type check               |

### Mobile (`apps/mobile/`)

| Command                      | Description                          |
| ---------------------------- | ------------------------------------ |
| `pnpm android`               | Debug build + run on device/emulator |
| `pnpm android:release-local` | Release APK (prod backend)           |
| `pnpm test`                  | Unit tests                           |

## Project Structure

```text
apps/
  web/
    src/
      app/
        (app)/          # Authenticated app routes (notebooks, admin)
        (auth)/         # Auth routes (login, signup, forgot/reset password)
        api/            # API routes (notebooks, notes, admin)
        auth/           # Auth callback handler
        design-system/  # Design system showcase
      components/
        editor/         # BlockNote editor
        layout/         # App shell (three-panel layout)
        notebooks/      # Notebooks sidebar
        notes/          # Note list, note editor panel
        ui/             # Design system primitives (Button, Input, Card, etc.)
      hooks/            # Custom hooks (auto-save, theme)
      lib/
        api/            # API utilities
        supabase/       # Supabase client/server helpers
      env.ts            # Environment variable validation (t3-env + zod)
    __tests__/
      unit/             # Unit tests (vitest)
      integration/      # Integration tests (vitest + testing-library)
    e2e/                # E2E tests (Playwright)
  mobile/
    app/                # Expo Router screens
    src/
      components/       # Mobile components
      db/               # WatermelonDB schema, models, sync
      hooks/            # Custom hooks
      lib/              # Mobile libraries (supabase)
      providers/        # Context providers
      theme/            # Theme definitions
    store/              # State management
    e2e/                # Maestro E2E tests
packages/
  shared/              # Shared types and constants (@drafto/shared)
supabase/
  config.toml          # Supabase project config
  migrations/          # Database migrations
docs/
  adr/                 # Architecture Decision Records
```

## Architecture

### Web

The web app uses a **three-panel layout**: notebooks sidebar, notes list, and editor. Data flows through Next.js API routes that use the Supabase server client, with Row Level Security enforcing access control at the database level.

### Mobile

The mobile app uses a **local-first architecture** with WatermelonDB (SQLite) for offline storage and Supabase for cloud sync. Notes are available offline and sync automatically when connectivity is restored.

### Auth

Auth is handled via Supabase Auth with email confirmation. New users must be approved by an admin (`profiles.is_approved`) before they can access the app. Session refresh and approval checks run on every request via `middleware.ts`.

See [`docs/adr/`](./docs/adr/) for Architecture Decision Records.

## Design System

The web app uses a custom design system built on CSS custom properties, defined in [`apps/web/src/app/globals.css`](./apps/web/src/app/globals.css) and exposed to Tailwind via `@theme inline`. See the live showcase at `/design-system`.

### Color Palette

| Role                 | Scale  | Usage                                                              |
| -------------------- | ------ | ------------------------------------------------------------------ |
| **Primary** (Indigo) | 50–900 | Buttons, links, focus rings, active states                         |
| **Accent** (Amber)   | 50–600 | Highlights, interactive accents                                    |
| **Neutral** (Stone)  | 50–900 | Backgrounds, text, borders                                         |
| **Semantic**         | —      | `success` (green), `warning` (amber), `error` (red), `info` (blue) |

### Surface Tokens

Semantic tokens that automatically switch between light and dark mode:

- `--bg`, `--bg-subtle`, `--bg-muted` — background surfaces
- `--fg`, `--fg-muted`, `--fg-subtle` — foreground/text colors
- `--border`, `--border-strong`, `--ring` — borders and focus rings
- `--sidebar-bg`, `--sidebar-hover`, `--sidebar-active` — sidebar-specific

Use them in Tailwind as `bg-bg`, `text-fg-muted`, `border-border`, etc.

### UI Primitives

Reusable components in `apps/web/src/components/ui/`:

| Component       | File                 | Variants / Props                                            |
| --------------- | -------------------- | ----------------------------------------------------------- |
| `Button`        | `button.tsx`         | `primary`, `secondary`, `ghost`, `danger` + `loading` state |
| `Input`         | `input.tsx`          | `sm`, `md`, `lg` sizes + `error` state                      |
| `Label`         | `label.tsx`          | Standard form label                                         |
| `Card`          | `card.tsx`           | `CardHeader`, `CardBody`, `CardFooter` slots                |
| `Badge`         | `badge.tsx`          | `default`, `success`, `warning`, `error`                    |
| `IconButton`    | `icon-button.tsx`    | `ghost`, `danger` variants                                  |
| `Skeleton`      | `skeleton.tsx`       | Configurable `height`, `width`, `rounded`                   |
| `ConfirmDialog` | `confirm-dialog.tsx` | Inline confirmation with confirm/cancel actions             |
| `DropdownMenu`  | `dropdown-menu.tsx`  | Positioned menu with items + destructive variant            |
| `ThemeToggle`   | `theme-toggle.tsx`   | Sun/moon toggle for dark mode                               |

### Dark Mode

Dark mode is toggled via a `.dark` class on `<html>`. The `useTheme` hook manages the theme:

- Respects `prefers-color-scheme` on first visit
- Persists choice to `localStorage("theme")`
- A `<script>` in `<head>` prevents flash of wrong theme on load

## License

Private project.
