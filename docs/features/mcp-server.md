# MCP Server

**Status:** shipped **Updated:** 2026-11-22

## What it is

Drafto exposes a remote Model Context Protocol (MCP) server at `/api/mcp`, letting Claude Desktop, Claude Cowork, claude.ai, and any other MCP client list, read, search, create, update, move, and trash notes and to create, list, rename, and delete notebooks on behalf of an authenticated Drafto user.

## Current state

The server is live in production at `https://drafto.eu/api/mcp` and listed on the public MCP Registry under the namespace `eu.drafto/mcp`. Tool calls authenticate with user-generated API keys managed at `/settings`; the handshake, `ping` and `tools/list` answer without a key, so clients and directories can see what the server does first ([ADR-0095](../adr/0095-mcp-anonymous-discovery.md)). Eleven tools are registered in the server — see the enumeration below.

Platform coverage:

- **Web:** hosts the server route and the API-key management UI. Web is the only platform involved — mobile and desktop apps are MCP clients of their own local data, not of this server.
- **iOS / Android / macOS:** unaffected. MCP clients talk directly to the hosted web endpoint.

The route is stateless: every POST is independent, and the transport is Streamable HTTP with `enableJsonResponse: true` (no SSE, no session ID). `GET` and `DELETE` on the route return 405.

## Code paths

| Concern                               | Path                                                             |
| ------------------------------------- | ---------------------------------------------------------------- |
| MCP route (tool registry + transport) | `apps/web/src/app/api/mcp/route.ts`                              |
| Tool handler implementations          | `apps/web/src/lib/api/mcp-tools.ts`                              |
| Bearer-token authentication           | `apps/web/src/lib/api/mcp-auth.ts`                               |
| Methods served without a key          | `apps/web/src/lib/api/mcp-public-methods.ts`                     |
| `web-mcp` activity day                | `apps/web/src/lib/api/record-mcp-activity.ts`                    |
| API-key CRUD (list, generate)         | `apps/web/src/app/api/api-keys/route.ts`                         |
| API-key revoke                        | `apps/web/src/app/api/api-keys/[id]/route.ts`                    |
| API-key management UI (`/settings`)   | `apps/web/src/components/settings/settings-content.tsx`          |
| `api_keys` table + RLS                | `supabase/migrations/20260411000001_api_keys.sql`                |
| BlockNote <-> Markdown conversion     | `packages/shared/src/editor/markdown-converter.ts`               |
| MCP Registry metadata                 | `server.json` (repo root)                                        |
| Server icon (registry + `initialize`) | `apps/web/public/mcp-icon.png`                                   |
| mcptry maintainer claim               | `apps/web/public/.well-known/mcptry-verify.txt`                  |
| Auth tests                            | `apps/web/__tests__/unit/mcp-auth.test.ts`                       |
| Route tests                           | `apps/web/__tests__/unit/mcp-route.test.ts`                      |
| Key-less method tests                 | `apps/web/__tests__/unit/mcp-public-methods.test.ts`             |
| Key-less discovery, real SDK          | `apps/web/__tests__/integration/mcp-anonymous-discovery.test.ts` |
| Key-less discovery E2E                | `apps/web/e2e/mcp-anonymous-discovery.spec.ts`                   |
| Activity-day tests                    | `apps/web/__tests__/unit/record-mcp-activity.test.ts`            |
| Tool handler tests                    | `apps/web/__tests__/unit/mcp-tools.test.ts`                      |
| API-key endpoint tests                | `apps/web/__tests__/unit/api-keys.test.ts`                       |

## Related ADRs

- [0017 — MCP Server for Claude Cowork Integration](../adr/0017-mcp-server-for-claude-cowork.md)
- [0088 — Activity Days Instead of Event Analytics](../adr/0088-activity-days-instead-of-event-analytics.md) (the `web-mcp` activity day)
- [0095 — Key-less Discovery on the MCP Server](../adr/0095-mcp-anonymous-discovery.md)

## The eleven tools

Eleven tools are registered in `createMcpServer` in `apps/web/src/app/api/mcp/route.ts`. Every handler lives in `apps/web/src/lib/api/mcp-tools.ts` and returns an MCP `ToolResult` with a single `text` content item (success) or the same shape with `isError: true` (failure). Unless noted, successful JSON payloads are pretty-printed with `JSON.stringify(..., null, 2)`.

| Tool              | Purpose                                                                              | Input                                                                             | Output (text content)                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_notebooks`  | List all notebooks owned by the caller, ordered by name.                             | `{}` (no arguments)                                                               | JSON array of `{ id, name, created_at, updated_at }`.                                                                                                                                                                                                                                                                                  |
| `list_notes`      | List non-trashed notes in a notebook, ordered by `updated_at` descending.            | `{ notebook_id: string (uuid) }`                                                  | JSON array of `{ id, title, created_at, updated_at }`.                                                                                                                                                                                                                                                                                 |
| `read_note`       | Read a note's full content as Markdown, prefixed with a metadata header.             | `{ note_id: string (uuid) }`                                                      | Markdown: `# <title>` header, bullet list of `Notebook`, `Created`, `Updated`, `Trashed`, a `---` separator, then the note body Markdown (converted from BlockNote JSON via `contentToBlocknote` + `blockNoteToMarkdown`).                                                                                                             |
| `search_notes`    | Title-substring search across the caller's notes (trashed included).                 | `{ query: string, 1..200 chars }`                                                 | JSON array of up to 50 matches: `{ id, title, notebook_id, is_trashed, updated_at }`. Uses a Postgres `ilike` on title — not a full-text search despite the tool description.                                                                                                                                                          |
| `create_notebook` | Create a new notebook owned by the caller.                                           | `{ name: string, 1..100 chars }`                                                  | JSON object `{ id, name }` of the new notebook. Refuses a name the caller already has, ignoring case and spacing, with `Error: A notebook named "<name>" already exists. Choose a different name.` ([ADR-0097](../adr/0097-notebook-names-unique-per-user-in-app.md)).                                                                 |
| `create_note`     | Create a note inside an existing notebook, optionally with Markdown body.            | `{ notebook_id: string (uuid), title: string 1..255, content_markdown?: string }` | JSON object `{ id, title }` of the new note. Markdown body (if provided) is converted via `markdownToBlockNote` before insert.                                                                                                                                                                                                         |
| `update_note`     | Update a note's title, body, or both. At least one of the two is required.           | `{ note_id: string (uuid), title?: string 1..255, content_markdown?: string }`    | JSON object `{ id, title, updated_at }`. Errors with "No fields to update" when both optional fields are omitted.                                                                                                                                                                                                                      |
| `move_note`       | Move a note to a different notebook owned by the caller.                             | `{ note_id: string (uuid), notebook_id: string (uuid) }`                          | JSON object `{ id, title, notebook_id }`. Fails if the target notebook does not belong to the caller.                                                                                                                                                                                                                                  |
| `trash_note`      | Soft-delete a note (sets `is_trashed = true`, `trashed_at = now()`).                 | `{ note_id: string (uuid) }`                                                      | Plain-text confirmation: `Note "<title>" moved to trash.` Recoverable for 30 days per the note trash policy; permanent delete is intentionally not exposed.                                                                                                                                                                            |
| `rename_notebook` | Rename a notebook owned by the caller (mirrors `PATCH /api/notebooks/[id]`).         | `{ notebook_id: string (uuid), name: string 1..100 }`                             | JSON object `{ id, name }` of the renamed notebook. Trims the name and rejects an empty name, or one another of the caller's notebooks has (same error as `create_notebook`; changing only the case of its own name is allowed); an owner-scoped existence check returns `Error: Notebook not found` for a missing/not-owned notebook. |
| `delete_notebook` | Delete an empty notebook owned by the caller (mirrors `DELETE /api/notebooks/[id]`). | `{ notebook_id: string (uuid) }`                                                  | Plain-text confirmation: `Notebook "<name>" deleted.` Refuses with a clear error if the notebook still holds non-trashed notes; returns `Error: Notebook not found` for a missing/not-owned notebook.                                                                                                                                  |

Notes on the implementation:

- Every handler scopes its Supabase query with `.eq("user_id", userId)` because auth uses the service-role client (see auth model).
- `search_notes` deliberately uses a direct `ilike` rather than the `search_notes` RPC — the RPC relies on `auth.uid()`, which is not set for service-role clients. This is documented in the comment at the top of `searchNotes`.
- `read_note` and `create_note` / `update_note` are the only tools that cross the BlockNote <-> Markdown boundary.
- `rename_notebook` and `delete_notebook` mirror `PATCH` / `DELETE /api/notebooks/[id]`. Both run an explicit owner-scoped existence check first, because an `UPDATE` / `DELETE` on a missing or not-owned row affects 0 rows without raising a Supabase error — without the pre-check the tool would falsely report success. `delete_notebook` also mirrors the web route's guard refusing to delete a notebook that still holds non-trashed notes. Like the web route, once the notebook is deleted it removes the caller's attachment files whose note is gone (its trashed notes cascade with it), in `after()` with the service role (see [notes-and-notebooks.md](./notes-and-notebooks.md)).
- Attachment upload and permanent _note_ delete are **not** exposed as tools by design (see ADR 0017).

## Auth model

- **Key-less discovery:** without a key (`hasApiKey`: no `Authorization` header, an empty one, or a bare `Bearer`, which a client sends when the user left the optional key blank), the route serves a request whose every message is `initialize`, `notifications/initialized`, `ping` or `tools/list` (`PUBLIC_MCP_METHODS`), with `createMcpServer(null)`. It never calls `authenticateMcpRequest`, so it makes no database call and needs no service-role key. The same eleven tools are registered, so `tools/list` looks the same with or without a key; each handler runs through `withAuth` and returns a sign-in error without one, as a backstop. A key-less `tools/call`, any other method, a batch holding one or a body that isn't JSON gets a 401 whose message (`MCP_SIGN_IN_MESSAGE`) says where to get a key. A request that sends a key is authenticated before its body is read, so a wrong key gets a 401 whatever the method and costs no body parse; a bad key shows up at the handshake ([ADR-0095](../adr/0095-mcp-anonymous-discovery.md)). The route reads a clone of the body once (`readJsonRpcBody`) for this check and the activity-day check below. A key-less body is capped at `KEYLESS_MAX_BODY_BYTES` (64 KiB, refused by `Content-Length` or while streaming), since anyone can send one; an over-cap body counts as not public and gets the 401.
- **Key shape:** `dk_` prefix + 48 hex characters (24 random bytes). Generated in `POST /api/api-keys` using `crypto.getRandomValues` and `crypto.subtle.digest`.
- **Storage:** Only the SHA-256 hex digest (`key_hash`) and the first 8 chars (`key_prefix`, for display) are stored in `public.api_keys`. The raw key is returned **once** from the generation endpoint and shown in the UI with a copy-to-clipboard button; revisiting `/settings` never re-displays it.
- **Transport:** Clients send `Authorization: Bearer <raw key>`. `authenticateMcpRequest` re-hashes the bearer, looks up the row by `key_hash`, rejects on `revoked_at IS NOT NULL`, and then requires `profiles.is_approved = true` for the owning user.
- **RLS:** The `api_keys` table has RLS enabled with per-user select/insert/update/delete policies that also require `public.is_approved()`. The MCP route itself uses the service-role client (bypassing RLS) and enforces ownership by explicit `user_id` filtering in every handler.
- **Side effect:** Each successful auth fires `UPDATE api_keys SET last_used_at = now()` (fire-and-forget) — surfaced as the "Last used" timestamp in `/settings`.
- **Activity day:** Each authenticated tool call (`tools/call`, alone or in a batch) also records that the user used Drafto that UTC day through an AI assistant, so weekly active users count MCP-only users ([product metrics](./product-metrics.md#activity-days-usage_daily), [ADR-0088](../adr/0088-activity-days-instead-of-event-analytics.md)). The handshake (`initialize`, `notifications/initialized`) and `tools/list` record nothing: an assistant with the connector enabled sends them whenever a session starts, before the user asks it for anything in Drafto. After `authenticateMcpRequest` succeeds, the route checks the body it read with `isMcpToolCall` (the transport still reads the original), and for a tool call schedules `recordMcpActivity(supabase, userId)` with Next's `after()`, so it runs once the response has been sent. It upserts `(user_id, today UTC, 'web-mcp')` into `usage_daily` with `onConflict: "user_id,day,client"` and `ignoreDuplicates`, so only the day's first tool call adds a row. The route can't use the `record_activity` RPC that the apps call: it queries as the service role, where `auth.uid()` is null. The write is best-effort: an error goes to Sentry and never changes the response. A 401 records nothing. Only the day and the client are stored, never the tool, the note or the arguments.
- **Failure response:** Auth errors are returned as JSON-RPC 2.0 errors (`code: -32000`) with HTTP status 401. There's no `WWW-Authenticate` resource metadata: Drafto has no OAuth server, so advertising one would only send clients into discovery that fails.
- **Server info:** `initialize` returns `title`, `websiteUrl`, `icons` and `instructions` (where to get a key). `SERVER_VERSION` in the route must match `version` in `server.json`; `mcp-route.test.ts` checks that it does.

## MCP Registry

Drafto is published at `registry.modelcontextprotocol.io` as `eu.drafto/mcp`. Registry metadata is in `server.json` at the repo root: `websiteUrl` (`https://drafto.eu`), an `icons` entry (`https://drafto.eu/mcp-icon.png`, served from `apps/web/public/`, so publish only after the icon is deployed), and a single remote entry pointing to `https://drafto.eu/api/mcp` with an optional `Authorization` Bearer header (optional because listing tools works without it; tool calls need it).

Publishing an update (e.g. after adding or changing a tool):

1. Bump `version` in `server.json`, and `SERVER_VERSION` in `apps/web/src/app/api/mcp/route.ts` to match.
2. Run `~/bin/mcp-publisher publish`.
3. Verify: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=drafto"`.

mcptry (a directory built on the registry) lists the server at `mcptry.com/server/eu.drafto/mcp`. The listing is claimed by a file: `apps/web/public/.well-known/mcptry-verify.txt` holds the `mcptry-verify=…` line from the claim page. It isn't a secret, only proof that we control drafto.eu. The middleware matcher skips that path, and `PUBLIC_ROUTES` lists it too, because mcptry fetches it signed out. Keep the file: mcptry may re-check it.

Registry namespace auth is DNS-based: the `drafto.eu` TXT record holds the Ed25519 public key. The matching private key lives at `~/drafto-secrets/mcp-registry-key.pem` and is never committed. If the publisher login has expired, re-authenticate:

```bash
PRIVATE_KEY="$(openssl pkey -in ~/drafto-secrets/mcp-registry-key.pem -noout -text | awk '/^priv:/{f=1;next} /^pub:/{f=0} f' | tr -d ' :\n')"
~/bin/mcp-publisher login dns --domain "drafto.eu" --private-key "${PRIVATE_KEY}"
```

The `awk` takes the hex lines between `priv:` and `pub:`, which works however many lines OpenSSL wraps the key over (OpenSSL 4 uses two, older versions three). The key must come out as 64 hex characters.

See the "MCP Server (Claude Cowork Integration)" section of `CLAUDE.md` for the authoritative reference.

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
- `apps/web/__tests__/unit/mcp-route.test.ts` — the route rejects bad auth and wires the server + transport correctly; it serves the handshake, `ping` and `tools/list` without a key and 401s everything else, every handler refuses to run without a key, and the server's version matches `server.json`; an authenticated tool call schedules the activity day after the response, while a 401, the handshake, `tools/list` and a body that isn't JSON don't, and the transport can still read the body.
- `apps/web/__tests__/unit/mcp-public-methods.test.ts` — which bodies count as key-less, and that the body is read from a clone.
- `apps/web/__tests__/integration/mcp-anonymous-discovery.test.ts` — with the real SDK: key-less `initialize` (server info), `tools/list` (all eleven tools and their schemas) and `ping`, and a key-less `tools/call` gets a 401.
- `apps/web/e2e/mcp-anonymous-discovery.spec.ts` — the same against the running app, plus the icon.
- `apps/web/__tests__/unit/record-mcp-activity.test.ts` — the `usage_daily` upsert (today's UTC day, `web-mcp`, duplicates ignored), that an error is reported to Sentry instead of thrown, and which JSON-RPC messages count as a tool call.
- `apps/web/__tests__/unit/mcp-tools.test.ts` — handler-level tests for each of the eleven tools.
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

# Key-less discovery: lists the eleven tools; the same body with tools/call gets a 401.
curl -s -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'

# End-to-end smoke test: generate a key at /settings, then hit the local server.
curl -s -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq .

# Confirm the registry entry after a publish.
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=drafto"
```
