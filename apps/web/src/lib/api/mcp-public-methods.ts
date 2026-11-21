/**
 * The JSON-RPC methods `/api/mcp` answers without an API key (ADR 0095): the handshake,
 * `ping` and `tools/list`. They let a client or a directory see what the server does before
 * the user has a key. None of them reads or writes user data. Every other method, `tools/call`
 * first of all, still needs `Authorization: Bearer <key>`.
 */
export const PUBLIC_MCP_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
]);

/**
 * Whether an `Authorization` header carries a key. No header, an empty one, and a `Bearer`
 * with nothing after it (what a client sends when the user left the optional key blank) all
 * count as no key, so the request is treated as key-less rather than as a bad key. Any other
 * value counts as a key, and a malformed one fails authentication with a 401.
 */
export function hasApiKey(authHeader: string | null): boolean {
  return authHeader !== null && authHeader.replace(/^\s*bearer\b/i, "").trim() !== "";
}

/**
 * The JSON body of an MCP request, read from a clone so the transport can still read the
 * request itself, or `undefined` when the body isn't JSON (or was already read). The route
 * reads it once to decide whether the request needs a key and whether it is a tool call; an
 * unparseable body needs a key, and the transport answers it with a parse error.
 */
export async function readJsonRpcBody(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}

/**
 * Whether a parsed JSON-RPC body can be served without an API key: a single request whose
 * method is public, or a non-empty batch in which every message's method is. A response
 * (no `method`), an empty batch, or anything that isn't a JSON-RPC object returns false, so
 * the route asks for a key.
 */
export function isPublicMcpMessage(message: unknown): boolean {
  const messages: unknown[] = Array.isArray(message) ? message : [message];
  return (
    messages.length > 0 &&
    messages.every(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        "method" in m &&
        typeof m.method === "string" &&
        PUBLIC_MCP_METHODS.has(m.method),
    )
  );
}
