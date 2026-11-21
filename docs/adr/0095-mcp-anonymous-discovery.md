# 0095 — Key-less Discovery on the MCP Server

- **Status**: Accepted
- **Date**: 2026-11-21
- **Authors**: Jakub Anderwald (with Claude Code)
- **Amends**: [0017](./0017-mcp-server-for-claude-cowork.md) (which requests need an API key)

## Context

`POST /api/mcp` used to authenticate every request before the MCP transport saw it, so a client with no API key got a 401 even for `initialize` and `tools/list`. Nobody could see what Drafto's server does without first signing up and making a key.

The MCP Registry lists Drafto as `eu.drafto/mcp`, and directories built on the registry probe each remote server. mcptry, one of them, scored Drafto 58/100 and named this as the main gap (up to +30). It counts a server as "working without sign-in" when `initialize` and `tools/list` answer without a token, and an agent choosing a server needs the same thing. The MCP spec allows a server to serve discovery without auth and to require auth only for tool calls.

## Decision

`/api/mcp` answers a fixed allowlist of methods without an API key: `initialize`, `notifications/initialized`, `ping` and `tools/list` (`PUBLIC_MCP_METHODS` in `apps/web/src/lib/api/mcp-public-methods.ts`). No `Authorization` header, an empty one and a bare `Bearer` (what a client sends when the user left the optional key blank) all count as no key (`hasApiKey`). The route decides:

- **A key is sent:** authenticate it before reading the body. A wrong, revoked or unapproved key gets a 401 whatever the method, so a bad key fails loudly at the handshake rather than at the first tool call, and a junk key costs no body parse.
- **No key, and every message in the body is on the allowlist** (a single request or a non-empty batch): serve it with `auth = null`. `authenticateMcpRequest` never runs, so no service-role client is made and no database call happens.
- **No key and anything else** (`tools/call`, a batch holding one, another method, or a body that isn't JSON): 401, with a message that says where to get a key (`MCP_SIGN_IN_MESSAGE`).

`createMcpServer(auth)` registers the same eleven tools in both cases, so `tools/list` shows the same tools with or without a key. Each handler runs through `withAuth`, which returns a sign-in error (`signInRequired()` in `mcp-tools.ts`) without auth. The route's gate stops a key-less tool call first; `withAuth` is a backstop in case a later route change lets one through.

The server now names itself fully in `initialize`: `title`, `websiteUrl`, an `icons` entry (`https://drafto.eu/mcp-icon.png`, served from `apps/web/public/`) and `instructions` that say where to get a key. `server.json` carries the same `websiteUrl` and `icons` for the registry, marks the `Authorization` header as optional (tool calls still need it), and its version matches `SERVER_VERSION` in the route. A unit test checks that they match.

The 401 response keeps its shape, a JSON-RPC `-32000` error with no `WWW-Authenticate` resource metadata. Drafto has no OAuth server, so advertising one would only make clients run discovery that fails.

## Consequences

- **Positive:** directories and agents can see the tool list and server info before a user has a key, which raises Drafto's listing score and makes it easier to choose.
- **Positive:** a key-less discovery request costs no database call and needs no secret, so the endpoint can also be tested in CI and locally without a service-role key.
- **Negative:** anyone can read the tool list, input schemas and descriptions. They describe the public API and hold no user data, so this exposes nothing that isn't already in the repo.
- **Negative:** a client added without a key now connects and lists tools, then gets a 401 at its first tool call instead of at the handshake. The fix for the user is the same (add a key from `/settings`), and the server's `instructions` say so.
- **Neutral:** a key-less discovery request costs a serverless invocation, about the same as the 401 it used to get. The activity day (ADR 0088) is unaffected: it is recorded only for an authenticated `tools/call`.

## Alternatives Considered

1. **Keep auth on every request.** It costs the listing score and gives agents nothing to judge the server by. Rejected.
2. **OAuth 2.1 with dynamic client registration.** It would let clients sign users in without pasting a key, but needs an authorization server, consent screens and token storage. ADR 0017 already rejected it as too much for this app, and discovery doesn't need it.
3. **Serve discovery for any request whose key fails.** It's friendlier to a client with a stale key, but it hides a wrong key until the first tool call, and clients with bad keys already retry often (see the middleware matcher notes). Rejected in favour of failing loudly.
4. **Expose some read tools without a key.** There is no public data to read: every tool is scoped to a user's notes.
