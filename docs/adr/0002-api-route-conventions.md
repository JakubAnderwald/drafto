# 0002 — API Route Conventions

- **Status**: Accepted
- **Date**: 2026-02-24
- **Authors**: Claude (AI assistant), Jakub Anderwald

## Context

Drafto needs a consistent approach for data access between the client and server. The PRD (§5.2) specifies a "clean API layer" and notes the importance of keeping data access patterns consistent for a future offline-first path.

Key constraints:

- All data operations must go through authenticated API routes
- Components should never call Supabase directly
- Error responses need a consistent format for client-side handling
- The auth check (session + approval status) is repeated across every route

## Decision

All data access flows through Next.js API routes under `/api/`. We establish these conventions:

**Auth helper** (`src/lib/api/utils.ts`):

- `getAuthenticatedUser()` — returns `{ user, supabase }` or an error response. Every protected API route calls this first.
- This centralizes the auth check so routes don't duplicate session logic.

**Response format**:

- Success: return the resource data directly (e.g., `{ id, name, ... }` or `[...]`)
- Error: `{ error: string, status: number }` with the corresponding HTTP status code
- Helper functions: `errorResponse(message, status)` and `successResponse(data, status)`

**Route structure**:

- RESTful routes under `/api/` (e.g., `/api/notebooks`, `/api/notes/[id]`)
- Standard HTTP methods: GET (list/read), POST (create), PATCH (update), DELETE (delete)
- No direct Supabase client usage in React components

## Consequences

- **Positive**: Single point for auth logic — easy to add rate limiting, logging, or caching later.
- **Positive**: Consistent error format makes client-side error handling straightforward.
- **Positive**: API routes act as a natural boundary for a future offline-first implementation (swap API calls for local-first sync).
- **Negative**: Adds a network hop compared to direct Supabase calls from Server Components. For a small app this latency is acceptable.
- **Neutral**: Server Components could call Supabase directly for read-only operations, but we choose consistency over optimization at this stage.

## Alternatives Considered

1. **Direct Supabase calls from Server Components** — Rejected for consistency and to preserve the offline-first migration path per PRD §5.2.
2. **tRPC** — Considered for type safety, but adds complexity. The app is small enough that typed API routes with Supabase's generated types provide sufficient safety.
3. **GraphQL** — Rejected as overkill for the app's data model. REST is simpler and sufficient.
