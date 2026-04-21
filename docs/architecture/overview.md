# Architecture Overview

A single-page system map for placing new code in Drafto. Read the root [`CLAUDE.md`](../../CLAUDE.md) for the full set of enforced rules; this doc gives the shape of the system.

## Pointer box

- Feature-level docs: [`../features/`](../features/)
- Operations (env setup, deploys, runbooks): [`../operations/`](../operations/)
- Architecture Decision Records: [`../adr/`](../adr/)
- Archived / historical plans: [`../archive/`](../archive/)

## Monorepo layout

Drafto is a pnpm + Turborepo workspace. Packages are declared in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) (`apps/*` and `packages/*`); build orchestration lives in [`turbo.json`](../../turbo.json).

| Path                                         | Role                                                           |
| -------------------------------------------- | -------------------------------------------------------------- |
| [`apps/web/`](../../apps/web/)               | Next.js 16 web app (drafto.eu). App Router, Turbopack, RSC.    |
| [`apps/mobile/`](../../apps/mobile/)         | Expo + React Native mobile app (iOS + Android). Offline-first. |
| [`apps/desktop/`](../../apps/desktop/)       | React Native macOS app (Mac App Store). Offline-first.         |
| [`packages/shared/`](../../packages/shared/) | `@drafto/shared` — types, editor converters, constants.        |
| [`supabase/`](../../supabase/)               | Migrations (`supabase/migrations/`) and `config.toml`.         |
| [`docs/`](../)                               | Architecture, features, operations, and ADRs.                  |

Within each app:

- `apps/web/src/app/` — App Router pages and API routes (`api/notes/`, `api/notebooks/`, `api/attachments/`, `api/mcp/`, `api/webhooks/`, `api/admin/`, `api/cron/`, `api/import/`, `api/api-keys/`, `api/health/`).
- `apps/web/src/lib/` — shared libraries (Supabase clients, PostHog, email, MCP auth). Components depend on these abstractions, not on vendor SDKs directly.
- `apps/web/middleware.ts` — Supabase session refresh.
- `apps/mobile/src/` — `components/`, `db/`, `hooks/`, `lib/`, `providers/`, `theme/`.
- `apps/desktop/src/` — `components/`, `db/`, `hooks/`, `lib/`, `providers/`, `screens/`, `navigation/`, `theme/`, `types/`.
- `apps/mobile/src/db/` and `apps/desktop/src/db/` — **mirrored**: `schema.ts`, `migrations.ts`, `models/`, `sync.ts`, `index.ts`. Changes in either must be kept in lockstep.

## Data flow

Every platform eventually lands writes in the same Supabase Postgres database.

```
Web (browser)
  User edit
    -> React client component (BlockNote editor)
    -> fetch() -> Next.js API route (apps/web/src/app/api/...)
    -> createClient() (server) -> Supabase (RLS enforced by user JWT)
    -> Postgres

Mobile / Desktop
  User edit
    -> React Native screen
    -> WatermelonDB write (local SQLite, immediate)
    -> sync.ts (apps/{mobile,desktop}/src/db/sync.ts, periodic)
    -> @supabase/supabase-js push/pull
    -> Postgres
  Offline writes queue locally and replay on reconnect.

MCP clients (Claude Desktop, Cowork)
  -> /api/mcp (apps/web/src/app/api/mcp/route.ts)
  -> api-key auth (apps/web/src/lib/api/mcp-auth.ts)
  -> same data model as web API routes
```

BlockNote <-> Markdown conversion for MCP and cross-surface editing lives in [`packages/shared/src/editor/markdown-converter.ts`](../../packages/shared/src/editor/markdown-converter.ts). See [ADR 0010](../adr/0010-offline-sync-strategy.md) for sync design and [ADR 0017](../adr/0017-mcp-server-for-claude-cowork.md) for MCP.

## Shared code

`@drafto/shared` is consumed by all three apps (declared in each app's `package.json` as `"@drafto/shared": "workspace:*"`). It exports:

- Database types generated from Supabase (`Database`, `Json`) and row/insert/update helpers (`ProfileRow`, `NotebookRow`, `NoteRow`, `AttachmentRow`, `ApiKeyRow`, ...) — see [`packages/shared/src/types/`](../../packages/shared/src/types/).
- Editor converters and helpers in [`packages/shared/src/editor/`](../../packages/shared/src/editor/): `format-converter.ts` (BlockNote <-> TipTap), `markdown-converter.ts` (BlockNote <-> Markdown), `extract-text.ts`, `attachment-url.ts`, `resolve-urls.ts`, `types.ts`.
- Constants in [`packages/shared/src/constants.ts`](../../packages/shared/src/constants.ts): `MAX_TITLE_LENGTH`, `MAX_NOTEBOOK_NAME_LENGTH`, `MAX_FILE_SIZE`, `MAX_FILE_NAME_LENGTH`, `DEBOUNCE_MS`, `BUCKET_NAME`, `SIGNED_URL_EXPIRY_SECONDS`, `ATTACHMENT_URL_PREFIX`.

Anything used on more than one platform belongs here. Anything mobile/desktop-specific that needs to stay in sync (WatermelonDB schema, sync logic) lives in `apps/mobile/src/db/` and is mirrored to `apps/desktop/src/db/`.

## Platform parity rule

Drafto ships on **web**, **iOS**, **Android**, and **macOS**. Every user-facing feature must land on all four platforms or be explicitly scoped with justification (e.g. "macOS: deferred — requires native toolbar integration"). See the "Cross-Platform Feature Workflow" section in [`CLAUDE.md`](../../CLAUDE.md) for the checklist. Shared-package changes affect all platforms; mobile-db changes must also be applied to desktop-db.

## Code-style / SOLID rules (summary)

From [`CLAUDE.md`](../../CLAUDE.md) — authoritative source:

- **SRP** — one reason to change per file. Split data-fetching from UI.
- **OCP** — extend via composition/props, not editing.
- **LSP** — shared prop shapes must mean shared behavior.
- **ISP** — small, focused prop types.
- **DIP** — import abstractions from `src/lib/`, never instantiate Supabase (or other) clients directly in components.
- Strict TypeScript: no `any`, no `@ts-ignore`.
- Named exports only (except Next.js pages/layouts).
- Kebab-case file names.
- `@/` import alias for `src/` imports.
- Design system tokens only — see [ADR 0004](../adr/0004-design-system-css-variables.md) and [ADR 0014](../adr/0014-digital-atelier-design-system.md).

## Technology stack

| Layer                  | Technology                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| Web framework          | Next.js 16 (App Router, Turbopack, RSC)                                                                    |
| UI runtime             | React 19                                                                                                   |
| Language               | TypeScript (strict)                                                                                        |
| Styling (web)          | Tailwind CSS v4 + CSS-variable design tokens                                                               |
| Web editor             | BlockNote (Mantine adapter) — see [ADR 0003](../adr/0003-blocknote-editor-configuration.md)                |
| Mobile editor          | @10play/tentap-editor (TipTap-based)                                                                       |
| Backend                | Supabase (Postgres + Auth + Storage + RLS) — see [ADR 0001](../adr/0001-data-model-and-rls-strategy.md)    |
| Mobile app             | Expo SDK 55, React Native 0.83, Expo Router — see [ADR 0009](../adr/0009-mobile-app-technology-choices.md) |
| Desktop app            | React Native macOS 0.81 (no Expo) — see [ADR 0015](../adr/0015-desktop-app-technology-choice.md)           |
| Offline DB             | WatermelonDB (SQLite) — see [ADR 0010](../adr/0010-offline-sync-strategy.md)                               |
| Observability          | Sentry + PostHog (single project each, env-tagged)                                                         |
| Email                  | Resend — see [ADR 0019](../adr/0019-email-infrastructure-and-approval-flow.md)                             |
| Auth                   | Supabase Auth + Google/Apple OAuth — see [ADR 0018](../adr/0018-oauth-google-apple.md)                     |
| MCP                    | `@modelcontextprotocol/sdk` at `/api/mcp` — see [ADR 0017](../adr/0017-mcp-server-for-claude-cowork.md)    |
| Mobile/desktop release | Fastlane (local builds) — see [ADR 0016](../adr/0016-local-fastlane-builds.md)                             |
| Monorepo               | pnpm 10 workspaces + Turborepo 2                                                                           |
| Package manager        | pnpm (Node >= 22)                                                                                          |

## Where to put new code

- **New web UI primitive** -> `apps/web/src/components/ui/` (check first; likely already exists).
- **New web data access** -> `apps/web/src/lib/` (abstraction) + `apps/web/src/app/api/.../route.ts` (API) — see [ADR 0002](../adr/0002-api-route-conventions.md).
- **New shared type or editor helper** -> `packages/shared/src/` and re-export from `index.ts`.
- **New mobile + desktop data field** -> update `apps/mobile/src/db/schema.ts` and `apps/desktop/src/db/schema.ts` together, add a Supabase migration in `supabase/migrations/`, and update `@drafto/shared` types.
- **New MCP tool** -> `apps/web/src/app/api/mcp/route.ts` (see MCP Server section in `CLAUDE.md`).
- **New architectural decision** -> copy `docs/adr/0000-adr-template.md` to the next-numbered file and link it from `docs/adr/README.md`.
