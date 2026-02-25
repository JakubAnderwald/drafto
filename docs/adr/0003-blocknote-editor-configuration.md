# 0003 — BlockNote Editor Configuration

- **Status**: Accepted
- **Date**: 2026-02-25
- **Authors**: Claude (AI assistant), Jakub Anderwald

## Context

Drafto needs a rich-text editor that supports slash commands, headings, lists, checkboxes, and inline formatting. The PRD specifies BlockNote as the editor of choice with JSON content storage.

Key requirements:

- Slash commands for block insertion (headings, lists, checkboxes)
- Inline formatting: bold, italic, underline, strikethrough, links
- Headings: H1, H2, H3
- Lists: bullet, numbered
- Checkboxes (todo blocks)
- File attachments: images inline, other files as download links
- Auto-save with debounced writes

## Decision

We use BlockNote (`@blocknote/core`, `@blocknote/react`, `@blocknote/mantine`) with the following configuration:

- **Default block set**: All standard BlockNote blocks are enabled (paragraph, headings, lists, checkboxes, images, etc.)
- **Content format**: BlockNote's native JSON (array of `Block` objects), stored as JSONB in PostgreSQL
- **Theme**: Mantine-based theme (`@blocknote/mantine`) for consistent styling
- **Auto-save**: Debounced at 500ms using a custom `useAutoSave` hook that PATCHes the note content

## Consequences

- **Positive**: BlockNote's JSON format maps directly to JSONB storage — no serialization layer needed.
- **Convenient**: Slash commands work out of the box with the default configuration.
- **Beneficial**: Mantine theme provides polished UI without custom CSS.
- **Negative**: BlockNote adds ~200KB to the client bundle. Acceptable for a note-taking app.
- **Negative**: Content is not human-readable in the database (JSON vs Markdown/HTML). We accept this for the structured editing benefits.
- **Neutral**: Editor is client-only (`"use client"`) — server-side rendering of note content would require a separate renderer.

## Alternatives Considered

1. **TipTap** — More customizable but requires more configuration. BlockNote provides a higher-level API with less setup.
2. **Lexical (Meta)** — Lower-level, more complex setup. Better for custom editor experiences but overkill for our needs.
3. **Markdown editor (e.g., MDXEditor)** — Rejected because the PRD specifies rich-text editing with slash commands, not raw Markdown.
