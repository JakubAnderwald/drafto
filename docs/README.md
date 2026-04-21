# Drafto Documentation Index

Entry point for engineers (and coding agents) working in this repo. For the user-facing overview read the repo [README.md](../README.md). For day-to-day working rules (worktrees, SOLID, testing checklist, production safety) read [CLAUDE.md](../CLAUDE.md).

## Where to find things

| If you want to…                                            | Go to                              |
| ---------------------------------------------------------- | ---------------------------------- |
| Understand what a feature does and where it lives in code  | [`features/`](./features/)         |
| Understand the system shape (monorepo, data flow, envs)    | [`architecture/`](./architecture/) |
| Run tests, builds, releases, migrations, or set up a box   | [`operations/`](./operations/)     |
| Understand why a technology / pattern was chosen           | [`adr/`](./adr/README.md)          |
| Read historical plans (completed, superseded — do not use) | [`archive/`](./archive/)           |

## Features

One brief per functional area. Each brief lists the current state, code paths on every platform, related ADRs, and how to verify a change.

- [`features/auth.md`](./features/auth.md) — email/password + OAuth, approval flow, RLS boundary
- [`features/notes-and-notebooks.md`](./features/notes-and-notebooks.md) — data model, CRUD API, soft delete, trash
- [`features/editor.md`](./features/editor.md) — BlockNote editor, auto-save, Markdown conversion
- [`features/offline-sync.md`](./features/offline-sync.md) — WatermelonDB on mobile + desktop, sync loop, conflict rules
- [`features/search.md`](./features/search.md) — full-text search across notes
- [`features/evernote-import.md`](./features/evernote-import.md) — `.enex` parsing and import pipeline
- [`features/mcp-server.md`](./features/mcp-server.md) — remote MCP at `/api/mcp`, API keys, tool reference, registry
- [`features/design-system.md`](./features/design-system.md) — tokens, primitives, cross-platform parity
- [`features/email-and-approval.md`](./features/email-and-approval.md) — transactional email via Resend + approval pipeline
- [`features/mobile-desktop-apps.md`](./features/mobile-desktop-apps.md) — how iOS / Android / macOS fit together

## Architecture

- [`architecture/overview.md`](./architecture/overview.md) — monorepo map, platform parity rules, data flow
- [`architecture/environments.md`](./architecture/environments.md) — dev / prod Supabase projects, migration workflow
- [`architecture/testing.md`](./architecture/testing.md) — test matrix by platform and test type

## Operations

- [`operations/local-dev-setup.md`](./operations/local-dev-setup.md) — first-time machine setup
- [`operations/builds-and-releases.md`](./operations/builds-and-releases.md) — Fastlane for iOS / Android / macOS, versioning, release notes
- [`operations/migrations.md`](./operations/migrations.md) — Supabase migration workflow, production safety rails

## ADRs

See [`adr/README.md`](./adr/README.md) for the full index. Twenty decisions, append-only.

## Conventions for agents writing docs

- Features docs follow a fixed template (status, current state, code paths, ADRs, cross-platform notes, modifying safely, verify). Keep them navigational — link to ADRs for rationale, link to operations for commands; do not repeat.
- ADRs are append-only. If a decision reverses, file a new ADR and mark the old one `Superseded by NNNN`.
- Historical plans live in [`archive/`](./archive/). Never edit archived content; never treat it as source of truth.
