# 0012 — Search Implementation

- **Status**: Accepted
- **Date**: 2026-03-14
- **Authors**: Jakub

## Context

Drafto has no search feature. Users must manually browse notebooks to find notes. As the number of notes grows, this becomes increasingly impractical. We need cross-notebook search covering both titles and content, accessible from the main screen of both web and mobile apps. Trashed notes should be included but clearly marked.

The note content is stored as JSONB (BlockNote/TipTap format), so we need a way to extract plain text from the JSON structure for searching.

## Decision

Use PostgreSQL `ILIKE` with a `jsonb_path_query`-based text extraction function instead of full-text search (`tsvector`/`tsquery`).

**Database layer:**

- `extract_text_from_jsonb(content jsonb)` — uses `jsonb_path_query(content, 'strict $.**.text')` to recursively extract all text values from the BlockNote/TipTap JSON, concatenated with spaces.
- `search_notes(search_query text)` — RPC function that searches `title ILIKE '%query%'` OR extracted content `ILIKE '%query%'`, scoped to `auth.uid()`. Returns up to 50 results with title matches prioritized, then ordered by `updated_at` desc.

**Shared layer:**

- `extractTextFromContent(content)` — TypeScript equivalent of the PG function for client-side use (mobile offline search).

**Web:** Server-side search via API route calling the Supabase RPC function. Search UI is a Cmd+K overlay with debounced input.

**Mobile:** Local search via WatermelonDB `Q.like()` on title and raw JSON content column. This is best-effort — substring matching on raw JSON may also match JSON keys/metadata and miss edge cases from serialization/escaping, but is adequate for typical word queries. Works offline.

## Consequences

- **Positive**: Simple implementation with no additional infrastructure. No search index to maintain. Works offline on mobile via local DB queries. Consistent text extraction logic between PG and TypeScript.
- **Negative**: `ILIKE` performs a sequential scan — not suitable for millions of rows. Content extraction is computed on each query, not precomputed. No ranking by relevance beyond title-match priority.
- **Neutral**: If search performance becomes an issue at scale, we can migrate to `tsvector`/`tsquery` with a generated column, requiring a new migration but no API changes. Migration triggers to consider: p95 search latency exceeding 500ms, individual users accumulating >10k notes, or sequential scan costs becoming visible in `pg_stat_user_tables`.

## Alternatives Considered

1. **PostgreSQL full-text search (`tsvector`/`tsquery`)** — More powerful with ranking and stemming, but requires maintaining a generated `tsvector` column and triggers. Overkill for a personal note-taking app with hundreds to low-thousands of notes per user.

2. **External search service (Algolia, Meilisearch, Typesense)** — Best search quality but adds infrastructure cost, complexity, and a sync pipeline. Not justified for current scale.

3. **Client-side only search** — Would work for mobile (WatermelonDB) but not for web where notes are fetched on demand. Would require loading all notes to the client first.
