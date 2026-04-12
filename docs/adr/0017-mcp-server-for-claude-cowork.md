# 0017 — MCP Server for Claude Cowork Integration

- **Status**: Accepted
- **Date**: 2026-04-11
- **Authors**: Jakub

## Context

Claude Cowork (Anthropic's agentic AI tool) supports connecting to third-party apps via Remote MCP (Model Context Protocol) servers. Making Drafto's notes accessible from Claude Cowork enables AI-assisted note-taking workflows — Claude can read, search, create, and update notes directly.

The integration needs to authenticate users securely, respect existing RLS policies, and fit into the Vercel serverless deployment model.

## Decision

Build a remote MCP server as a Next.js API route at `/api/mcp` within the existing `apps/web/` application. Authentication uses API keys (hashed with SHA-256, stored in a new `api_keys` table). The MCP transport uses stateless Streamable HTTP with JSON responses (no SSE).

Key design choices:

- **Hosted in existing app**: Shares Supabase config, env vars, and Vercel deployment — no new infrastructure
- **API key auth**: Users generate keys from a settings page; simpler than full OAuth 2.1 while still secure
- **Service role client**: Used for API key lookup, with explicit `user_id` filtering in all queries
- **Stateless transport**: Each request is independent — fits Vercel serverless functions perfectly
- **Markdown conversion**: BlockNote JSONB content is converted to/from Markdown for Claude to read and write

Nine MCP tools are exposed: list_notebooks, list_notes, read_note, search_notes, create_notebook, create_note, update_note, move_note, trash_note. Permanent delete and attachment upload are intentionally excluded.

## Consequences

- **Positive**: Drafto notes are accessible from Claude Desktop, Claude Cowork, claude.ai, and any MCP client. No new infrastructure to maintain.
- **Positive**: API key auth is simple for users — generate a key, paste it into Claude settings, done.
- **Negative**: API keys are long-lived and don't auto-expire. Mitigation: revocation UI, `last_used_at` tracking.
- **Negative**: Service role key required in production environment variables. Mitigation: only used server-side for key lookup, validated via t3-env.
- **Neutral**: Markdown conversion is lossy for complex formatting (e.g., nested tables, image dimensions) but sufficient for AI interaction.

## Alternatives Considered

1. **Full OAuth 2.1**: Would require authorization server endpoints (`/authorize`, `/token`, PKCE, consent screens). Too much engineering for a personal/small-team app. Could be added later if needed.

2. **Separate MCP service** (`apps/mcp/`): Would require its own Vercel project, duplicate Supabase config, and separate deployment. Unnecessary complexity when a single API route suffices.

3. **Local MCP server only**: Would limit usage to Claude Desktop on the user's machine. Remote MCP works across all Claude clients.

4. **Supabase access tokens as auth**: Tokens expire and require refresh management. API keys are simpler for machine-to-machine auth.
