import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { after } from "next/server";
import { z } from "zod";
import { authenticateMcpRequest } from "@/lib/api/mcp-auth";
import type { McpAuthResult } from "@/lib/api/mcp-auth";
import {
  KEYLESS_MAX_BODY_BYTES,
  hasApiKey,
  isPublicMcpMessage,
  readJsonRpcBody,
} from "@/lib/api/mcp-public-methods";
import { isMcpToolCall, recordMcpActivity } from "@/lib/api/record-mcp-activity";
import {
  listNotebooks,
  listNotes,
  readNote,
  searchNotes,
  createNotebook,
  createNote,
  updateNote,
  moveNote,
  trashNote,
  renameNotebook,
  deleteNotebook,
  MCP_API_KEY_URL,
  MCP_SIGN_IN_MESSAGE,
  signInRequired,
} from "@/lib/api/mcp-tools";
import type { ToolResult } from "@/lib/api/mcp-tools";
import { removeUserOrphanedAttachments } from "@/lib/storage/remove-orphaned-attachments";

/** Keep in step with `version` in the repo-root `server.json` (the MCP Registry entry). */
const SERVER_VERSION = "1.2.0";

/**
 * The MCP server for one request. <auth> is the API key's owner, or null for a key-less
 * request, which the route only lets through for the handshake, `ping` and `tools/list`
 * (ADR 0095). Every tool is registered either way, so `tools/list` shows the same tools with
 * or without a key; each handler runs through `withAuth`, so without one it returns a
 * sign-in error and never touches the database.
 */
function createMcpServer(auth: McpAuthResult | null): McpServer {
  const server = new McpServer(
    {
      name: "drafto",
      title: "Drafto",
      version: SERVER_VERSION,
      websiteUrl: "https://drafto.eu",
      icons: [{ src: "https://drafto.eu/mcp-icon.png", mimeType: "image/png", sizes: ["512x512"] }],
    },
    {
      capabilities: { tools: {} },
      instructions: `Drafto notes and notebooks. Listing the tools needs no key; calling one needs a Drafto API key from ${MCP_API_KEY_URL}, sent as "Authorization: Bearer <key>".`,
    },
  );

  const withAuth = (run: (owner: McpAuthResult) => Promise<ToolResult>): Promise<ToolResult> =>
    auth ? run(auth) : Promise.resolve(signInRequired());

  server.tool("list_notebooks", "List all notebooks for the current user", {}, () =>
    withAuth(({ supabase, userId }) => listNotebooks(supabase, userId)),
  );

  server.tool(
    "list_notes",
    "List notes in a notebook (non-trashed, ordered by last updated)",
    { notebook_id: z.string().uuid().describe("The notebook ID to list notes from") },
    ({ notebook_id }) =>
      withAuth(({ supabase, userId }) => listNotes(supabase, userId, notebook_id)),
  );

  server.tool(
    "read_note",
    "Read a note's full content as Markdown",
    { note_id: z.string().uuid().describe("The note ID to read") },
    ({ note_id }) => withAuth(({ supabase, userId }) => readNote(supabase, userId, note_id)),
  );

  server.tool(
    "search_notes",
    "Full-text search across all notes (titles, content, and notebook names)",
    { query: z.string().min(1).max(200).describe("Search query") },
    ({ query }) => withAuth(({ supabase, userId }) => searchNotes(supabase, userId, query)),
  );

  server.tool(
    "create_notebook",
    "Create a new notebook",
    { name: z.string().min(1).max(100).describe("Notebook name") },
    ({ name }) => withAuth(({ supabase, userId }) => createNotebook(supabase, userId, name)),
  );

  server.tool(
    "create_note",
    "Create a new note in a notebook with optional Markdown content",
    {
      notebook_id: z.string().uuid().describe("The notebook ID to create the note in"),
      title: z.string().min(1).max(255).describe("Note title"),
      content_markdown: z.string().optional().describe("Note content in Markdown format"),
    },
    ({ notebook_id, title, content_markdown }) =>
      withAuth(({ supabase, userId }) =>
        createNote(supabase, userId, notebook_id, title, content_markdown),
      ),
  );

  server.tool(
    "update_note",
    "Update a note's title and/or content (provide Markdown for content)",
    {
      note_id: z.string().uuid().describe("The note ID to update"),
      title: z.string().min(1).max(255).optional().describe("New title"),
      content_markdown: z.string().optional().describe("New content in Markdown format"),
    },
    ({ note_id, title, content_markdown }) =>
      withAuth(({ supabase, userId }) =>
        updateNote(supabase, userId, note_id, title, content_markdown),
      ),
  );

  server.tool(
    "move_note",
    "Move a note to a different notebook",
    {
      note_id: z.string().uuid().describe("The note ID to move"),
      notebook_id: z.string().uuid().describe("The target notebook ID"),
    },
    ({ note_id, notebook_id }) =>
      withAuth(({ supabase, userId }) => moveNote(supabase, userId, note_id, notebook_id)),
  );

  server.tool(
    "trash_note",
    "Move a note to trash (soft-delete, recoverable for 30 days)",
    { note_id: z.string().uuid().describe("The note ID to trash") },
    ({ note_id }) => withAuth(({ supabase, userId }) => trashNote(supabase, userId, note_id)),
  );

  server.tool(
    "rename_notebook",
    "Rename a notebook (trims the name; rejects an empty name)",
    {
      notebook_id: z.string().uuid().describe("The notebook ID to rename"),
      name: z.string().min(1).max(100).describe("New notebook name"),
    },
    ({ notebook_id, name }) =>
      withAuth(({ supabase, userId }) => renameNotebook(supabase, userId, notebook_id, name)),
  );

  server.tool(
    "delete_notebook",
    "Delete an empty notebook (refuses if it still holds non-trashed notes)",
    { notebook_id: z.string().uuid().describe("The notebook ID to delete") },
    ({ notebook_id }) =>
      withAuth(async ({ supabase, userId }) => {
        const result = await deleteNotebook(supabase, userId, notebook_id);
        // The notebook's trashed notes went with it (ON DELETE CASCADE); remove their
        // files once the response is sent.
        if (!result.isError) after(() => removeUserOrphanedAttachments(userId, "web-mcp"));
        return result;
      }),
  );

  return server;
}

function unauthorized(message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  // The activity day is the day the call arrived, not the day `after` gets to run it.
  const receivedAt = new Date();
  const authHeader = request.headers.get("authorization");

  // A request that sends a key is authenticated before its body is read, so a wrong, revoked
  // or unapproved key gets its 401 whatever the method: a bad key fails loudly, and costs no
  // body parse.
  let auth: McpAuthResult | null = null;
  if (hasApiKey(authHeader)) {
    try {
      auth = await authenticateMcpRequest(authHeader);
    } catch (err) {
      return unauthorized((err as Error).message);
    }
  }

  // Without a key, the handshake, `ping` and `tools/list` are answered anyway, so a client or
  // a directory can see what Drafto offers before the user has a key (ADR 0095). Anything else
  // gets a 401 that says where to get one.
  // A key-less body is capped, since anyone can send one; a body over the cap reads as
  // undefined, which isn't public, so it gets the 401.
  const body = await readJsonRpcBody(request, auth ? undefined : KEYLESS_MAX_BODY_BYTES);
  if (!auth && !isPublicMcpMessage(body)) {
    return unauthorized(MCP_SIGN_IN_MESSAGE);
  }

  // Count the day the call arrived as a `web-mcp` activity day for this user (ADR 0088), but
  // only when it runs a tool: the handshake and `tools/list` happen whenever an assistant with
  // the connector starts a session, whether or not the user asks it for anything in Drafto.
  // `after` runs the write once the response has gone out, so it never delays the reply, and
  // recordMcpActivity never throws, so it can't change it either. A key-less request never
  // gets here with a tool call.
  if (auth && isMcpToolCall(body)) {
    const { supabase, userId } = auth;
    after(() => recordMcpActivity(supabase, userId, receivedAt));
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = createMcpServer(auth);
  await server.connect(transport);

  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
    await transport.close();
  }
}

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ error: "Method not allowed. Use POST for MCP requests." }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}

export async function DELETE(): Promise<Response> {
  return new Response(JSON.stringify({ error: "Method not allowed. Stateless server." }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}
