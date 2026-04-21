# MCP Server

**Status:** shipped **Updated:** 2026-04-21

## What it is

Drafto exposes a remote Model Context Protocol (MCP) server at `/api/mcp`, letting Claude Desktop, Claude Cowork, claude.ai, and any other MCP client list, read, search, create, update, move, and trash notes and notebooks on behalf of an authenticated Drafto user.

## Current state

The server is live in production at `https://drafto.eu/api/mcp` and listed on the public MCP Registry under the namespace `eu.drafto/mcp`. Authentication is via user-generated API keys managed at `/settings`. Nine tools are registered in the server — see the enumeration below.

Platform coverage:

- **Web:** hosts the server route and the API-key management UI. Web is the only platform involved — mobile and desktop apps are MCP clients of their own local data, not of this server.
- **iOS / Android / macOS:** unaffected. MCP clients talk directly to the hosted web endpoint.

The route is stateless: every POST is independent, and the transport is Streamable HTTP with `enableJsonResponse: true` (no SSE, no session ID). `GET` and `DELETE` on the route return 405.

## Code paths

| Concern                               | Path                                               |
| ------------------------------------- | -------------------------------------------------- |
| MCP route (tool registry + transport) | `apps/web/src/app/api/mcp/route.ts`                |
| Tool handler implementations          | `apps/web/src/lib/api/mcp-tools.ts`                |
| Bearer-token authentication           | `apps/web/src/lib/api/mcp-auth.ts`                 |
| API-key CRUD (list, generate)         | `apps/web/src/app/api/api-keys/route.ts`           |
| API-key revoke                        | `apps/web/src/app/api/api-keys/[id]/route.ts`      |
| API-key management UI (`/settings`)   | `apps/web/src/app/settings/page.tsx`               |
| `api_keys` table + RLS                | `supabase/migrations/20260411000001_api_keys.sql`  |
| BlockNote <-> Markdown conversion     | `packages/shared/src/editor/markdown-converter.ts` |
| MCP Registry metadata                 | `server.json` (repo root)                          |
| Auth tests                            | `apps/web/__tests__/unit/mcp-auth.test.ts`         |
| Route tests                           | `apps/web/__tests__/unit/mcp-route.test.ts`        |
| Tool handler tests                    | `apps/web/__tests__/unit/mcp-tools.test.ts`        |
| API-key endpoint tests                | `apps/web/__tests__/unit/api-keys.test.ts`         |

## Related ADRs

- [0017 — MCP Server for Claude Cowork Integration](../adr/0017-mcp-server-for-claude-cowork.md)

## The nine tools

Nine tools are registered in `createMcpServer` in `apps/web/src/app/api/mcp/route.ts`. Every handler lives in `apps/web/src/lib/api/mcp-tools.ts` and returns an MCP `ToolResult` with a single `text` content item (success) or the same shape with `isError: true` (failure). Unless noted, successful JSON payloads are pretty-printed with `JSON.stringify(..., null, 2)`.

| Tool              | Purpose                                                                    | Input                                                                             | Output (text content)                                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_notebooks`  | List all notebooks owned by the caller, ordered by name.                   | `{}` (no arguments)                                                               | JSON array of `{ id, name, created_at, updated_at }`.                                                                                                                                                                      |
| `list_notes`      | List non-trashed notes in a notebook, ordered by `updated_at` descending.  | `{ notebook_id: string (uuid) }`                                                  | JSON array of `{ id, title, created_at, updated_at }`.                                                                                                                                                                     |
| `read_note`       | Read a note's full content as Markdown, prefixed with a metadata header.   | `{ note_id: string (uuid) }`                                                      | Markdown: `# <title>` header, bullet list of `Notebook`, `Created`, `Updated`, `Trashed`, a `---` separator, then the note body Markdown (converted from BlockNote JSON via `contentToBlocknote` + `blockNoteToMarkdown`). |
| `search_notes`    | Title-substring search across the caller's notes (trashed included).       | `{ query: string, 1..200 chars }`                                                 | JSON array of up to 50 matches: `{ id, title, notebook_id, is_trashed, updated_at }`. Uses a Postgres `ilike` on title — not a full-text search despite the tool description.                                              |
| `create_notebook` | Create a new notebook owned by the caller.                                 | `{ name: string, 1..100 chars }`                                                  | JSON object `{ id, name }` of the new notebook.                                                                                                                                                                            |
| `create_note`     | Create a note inside an existing notebook, optionally with Markdown body.  | `{ notebook_id: string (uuid), title: string 1..255, content_markdown?: string }` | JSON object `{ id, title }` of the new note. Markdown body (if provided) is converted via `markdownToBlockNote` before insert.                                                                                             |
| `update_note`     | Update a note's title, body, or both. At least one of the two is required. | `{ note_id: string (uuid), title?: string 1..255, content_markdown?: string }`    | JSON object `{ id, title, updated_at }`. Errors with "No fields to update" when both optional fields are omitted.                                                                                                          |
| `move_note`       | Move a note to a different notebook owned by the caller.                   | `{ note_id: string (uuid), notebook_id: string (uuid) }`                          | JSON object `{ id, title, notebook_id }`. Fails if the target notebook does not belong to the caller.                                                                                                                      |
| `trash_note`      | Soft-delete a note (sets `is_trashed = true`, `trashed_at = now()`).       | `{ note_id: string (uuid) }`                                                      | Plain-text confirmation: `Note "<title>" moved to trash.` Recoverable for 30 days per the note trash policy; permanent delete is intentionally not exposed.                                                                |

Notes on the implementation:

- Every handler scopes its Supabase query with `.eq("user_id", userId)` because auth uses the service-role client (see auth model).
- `search_notes` deliberately uses a direct `ilike` rather than the `search_notes` RPC — the RPC relies on `auth.uid()`, which is not set for service-role clients. This is documented in the comment at the top of `searchNotes`.
- `read_note` and `create_note` / `update_note` are the only tools that cross the BlockNote <-> Markdown boundary.
- Attachment upload, permanent delete, and notebook rename/delete are **not** exposed as tools by design (see ADR 0017).

## Auth model

- **Key shape:** `dk_` prefix + 48 hex characters (24 random bytes). Generated in `POST /api/api-keys` using `crypto.getRandomValues` and `crypto.subtle.digest`.
- **Storage:** Only the SHA-256 hex digest (`key_hash`) and the first 8 chars (`key_prefix`, for display) are stored in `public.api_keys`. The raw key is returned **once** from the generation endpoint and shown in the UI with a copy-to-clipboard button; revisiting `/settings` never re-displays it.
- **Transport:** Clients send `Authorization: Bearer <raw key>`. `authenticateMcpRequest` re-hashes the bearer, looks up the row by `key_hash`, rejects on `revoked_at IS NOT NULL`, and then requires `profiles.is_approved = true` for the owning user.
- **RLS:** The `api_keys` table has RLS enabled with per-user select/insert/update/delete policies that also require `public.is_approved()`. The MCP route itself uses the service-role client (bypassing RLS) and enforces ownership by explicit `user_id` filtering in every handler.
- **Side effect:** Each successful auth fires `UPDATE api_keys SET last_used_at = now()` (fire-and-forget) — surfaced as the "Last used" timestamp in `/settings`.
- **Failure response:** Auth errors are returned as JSON-RPC 2.0 errors (`code: -32000`) with HTTP status 401.

## MCP Registry

Drafto is published at `registry.modelcontextprotocol.io` as `eu.drafto/mcp`. Registry metadata is in `server.json` at the repo root; the single remote entry points to `https://drafto.eu/api/mcp` with an `Authorization` Bearer header.

Publishing an update (e.g. after adding or changing a tool):

1. Bump `version` in `server.json`.
2. Run `~/bin/mcp-publisher publish`.
3. Verify: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=drafto"`.

Registry namespace auth is DNS-based: the `drafto.eu` TXT record holds the Ed25519 public key. The matching private key lives at `~/drafto-secrets/mcp-registry-key.pem` and is never committed. If the publisher login has expired, re-authenticate:

```bash
PRIVATE_KEY="$(openssl pkey -in ~/drafto-secrets/mcp-registry-key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
~/bin/mcp-publisher login dns --domain "drafto.eu" --private-key "${PRIVATE_KEY}"
```

See the "MCP Registry" section of `CLAUDE.md` for the authoritative reference.

## Cross-platform notes

- Only the web app ships MCP-server code. The hosted server is the single source of truth for every platform's "I want my notes in Claude" experience.
- The mobile and desktop apps store notes locally in WatermelonDB and sync to Supabase; they do **not** call `/api/mcp`. MCP clients see the server's view of the Supabase data — whatever a user's most recent sync has pushed.
- `packages/shared/src/editor/markdown-converter.ts` is the only place the server and the editor (web + mobile + desktop) share. Changing BlockNote block shape without updating the converter would desync `read_note` / `create_note` / `update_note` output from what the editor renders.

## Modifying safely

**Invariants:**

- Every handler MUST filter by `user_id` — the service-role client bypasses RLS.
- The raw API key MUST NOT be persisted or logged. Only the SHA-256 hex and the 8-char prefix are stored.
- The tool count in `server.json` metadata, ADR 0017, and the README should match the number of `server.tool(...)` calls in `apps/web/src/app/api/mcp/route.ts`.
- Tool `name` strings are public contract. Renaming or removing a registered tool is a breaking change for MCP clients — bump `server.json` version and republish.
- Markdown input/output passes through `markdownToBlockNote` / `blockNoteToMarkdown` / `contentToBlocknote`. New block types in the editor require a matching converter update, or `read_note` will drop content.

**Tests that catch regressions:**

- `apps/web/__tests__/unit/mcp-auth.test.ts` — bearer parsing, key hashing, revocation, unapproved user rejection.
- `apps/web/__tests__/unit/mcp-route.test.ts` — the route rejects bad auth and wires the server + transport correctly.
- `apps/web/__tests__/unit/mcp-tools.test.ts` — handler-level tests for each of the nine tools.
- `apps/web/__tests__/unit/api-keys.test.ts` — `/api/api-keys` generate / list / revoke.
- `packages/shared/src/editor/__tests__/markdown-converter.test.ts` — round-trip conversion invariants.

**Files that must change together:**

- Adding a new tool: register it in `apps/web/src/app/api/mcp/route.ts`, implement the handler in `apps/web/src/lib/api/mcp-tools.ts`, add a test in `apps/web/__tests__/unit/mcp-tools.test.ts`, update the tool count in ADR 0017 and the enumeration table in this doc, bump `server.json` version.
- Adding a new note-facing API route (web, mobile, or desktop): per `CLAUDE.md`, evaluate whether it should also be exposed as an MCP tool and update the registry + handlers to match.
- Changing an existing API route's behavior/schema: update the corresponding MCP tool handler and its Zod input schema in the same change set so the two stay in sync.
- Adding or changing note-content-bearing DB columns or block types: update `packages/shared/src/editor/markdown-converter.ts` so `read_note`, `create_note`, and `update_note` stay lossless.

## Verify

```bash
# Unit tests (mcp-auth, mcp-route, mcp-tools, api-keys, markdown-converter).
cd apps/web && pnpm test
cd packages/shared && pnpm test

# Type + lint from the repo root.
pnpm lint && pnpm typecheck

# End-to-end smoke test: generate a key at /settings, then hit the local server.
curl -s -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq .

# Confirm the registry entry after a publish.
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=drafto"
```
