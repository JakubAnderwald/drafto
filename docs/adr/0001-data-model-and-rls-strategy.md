# 0001 — Data Model and RLS Strategy

- **Status**: Accepted
- **Date**: 2026-02-24
- **Authors**: Claude (AI assistant), Jakub Anderwald

## Context

Drafto is a multi-user note-taking app that needs data isolation between users, an admin-approval flow for new signups, and fine-grained access control. The app uses Supabase (PostgreSQL) as its backend.

Key requirements from the PRD:

- Users can only access their own notebooks, notes, and attachments
- New users must be approved by an admin before accessing any data
- Admins can view and manage user profiles for the approval workflow
- Data should cascade-delete appropriately (user → notebooks → notes → attachments)

## Decision

We use Supabase Row Level Security (RLS) as the primary access control mechanism with the following schema:

**Tables:**

- `profiles` — extends `auth.users` with `is_approved`, `is_admin`, `display_name`
- `notebooks` — user's notebook collection (flat, no nesting)
- `notes` — notes within notebooks, with JSONB content for BlockNote editor data
- `attachments` — file metadata linked to notes

**RLS Strategy:**

- Every data table (notebooks, notes, attachments) checks both `auth.uid() = user_id` AND `profiles.is_approved = true`
- This double-check ensures unapproved users cannot access any data even if they have a valid session
- Admins have separate SELECT/UPDATE policies on `profiles` for the approval workflow
- A database trigger auto-creates a `profiles` row when a new user signs up via `auth.users`

**Content Storage:**

- Note content is stored as JSONB, matching BlockNote's native JSON format
- This avoids HTML serialization/deserialization and enables future server-side content queries

## Consequences

- **Positive**: Security is enforced at the database level, not just the application layer. Even direct API access cannot bypass RLS.
- **Positive**: The approval check in every policy means unapproved users are comprehensively blocked.
- **Positive**: JSONB storage for notes enables efficient partial updates and future search capabilities.
- **Negative**: RLS policies add a performance overhead to every query (the `is_approved` subquery). For ~5-10 users this is negligible.
- **Negative**: The duplicate approval check across all tables means policy updates require touching multiple policies.
- **Neutral**: TypeScript types are manually maintained to match the schema until `supabase gen types` is integrated into the CI pipeline.

## Alternatives Considered

1. **Application-level access control only** — Rejected because it doesn't protect against direct database access and is easier to introduce bugs when adding new endpoints.
2. **Single RLS policy without approval check** — Rejected because it would allow unapproved users to access data tables if they somehow obtained a valid session.
3. **HTML content storage** — Rejected in favor of JSONB to match BlockNote's native format and avoid serialization overhead.
