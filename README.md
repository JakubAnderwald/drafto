# Drafto

A note-taking web app with notebooks, rich text editing, and auto-save. Built with Next.js, TypeScript, Tailwind CSS, and Supabase.

**Live:** [drafto.eu](https://drafto.eu)

## Tech Stack

- **Framework:** Next.js 16 (App Router, Turbopack)
- **Language:** TypeScript (strict mode)
- **Styling:** Tailwind CSS v4 + custom design system (CSS variables)
- **Database & Auth:** Supabase (PostgreSQL + Row Level Security)
- **Editor:** BlockNote (block-based rich text)
- **Monitoring:** Sentry (errors), PostHog (analytics)
- **CI/CD:** GitHub Actions, Vercel, SonarCloud

## Features

- **Notebooks** — create, rename, delete notebooks to organize notes
- **Notes** — create and edit notes within notebooks, with relative timestamps
- **Rich text editor** — BlockNote-powered block editor with auto-save
- **Dark mode** — system-preference-aware theme toggle with localStorage persistence
- **Authentication** — email/password signup with email confirmation, password reset
- **User approval** — new accounts require admin approval before access
- **Evernote import** — import notes from Evernote `.enex` files with full content and attachment support
- **App menu** — dropdown menu with import, theme toggle, and logout
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
    ui/             # Design system primitives (Button, Input, Card, etc.)
  hooks/            # Custom hooks (auto-save, theme)
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

## Design System

The app uses a custom design system built on CSS custom properties, defined in [`src/app/globals.css`](./src/app/globals.css) and exposed to Tailwind via `@theme inline`.

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

Reusable components in `src/components/ui/`:

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

Dark mode is toggled via a `.dark` class on `<html>`. The `useTheme` hook (`src/hooks/use-theme.ts`) manages the theme:

- Respects `prefers-color-scheme` on first visit
- Persists choice to `localStorage("theme")`
- A `<script>` in `<head>` prevents flash of wrong theme on load

### Adding New Tokens

1. Add the CSS variable to `:root` (light value) and `.dark` (dark value) in `globals.css`
2. Wire it into Tailwind under the `@theme inline` block as `--color-<name>: var(--your-var)`
3. Use in components as `bg-<name>`, `text-<name>`, etc.

## License

Private project.
