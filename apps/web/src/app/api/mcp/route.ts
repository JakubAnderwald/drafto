import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authenticateMcpRequest } from "@/lib/api/mcp-auth";
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
} from "@/lib/api/mcp-tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

function createMcpServer(supabase: SupabaseClient<Database>, userId: string): McpServer {
  const server = new McpServer(
    { name: "drafto", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.tool("list_notebooks", "List all notebooks for the current user", {}, () =>
    listNotebooks(supabase, userId),
  );

  server.tool(
    "list_notes",
    "List notes in a notebook (non-trashed, ordered by last updated)",
    { notebook_id: z.string().uuid().describe("The notebook ID to list notes from") },
    ({ notebook_id }) => listNotes(supabase, userId, notebook_id),
  );

  server.tool(
    "read_note",
    "Read a note's full content as Markdown",
    { note_id: z.string().uuid().describe("The note ID to read") },
    ({ note_id }) => readNote(supabase, userId, note_id),
  );

  server.tool(
    "search_notes",
    "Full-text search across all notes (titles, content, and notebook names)",
    { query: z.string().min(1).max(200).describe("Search query") },
    ({ query }) => searchNotes(supabase, userId, query),
  );

  server.tool(
    "create_notebook",
    "Create a new notebook",
    { name: z.string().min(1).max(100).describe("Notebook name") },
    ({ name }) => createNotebook(supabase, userId, name),
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
      createNote(supabase, userId, notebook_id, title, content_markdown),
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
      updateNote(supabase, userId, note_id, title, content_markdown),
  );

  server.tool(
    "move_note",
    "Move a note to a different notebook",
    {
      note_id: z.string().uuid().describe("The note ID to move"),
      notebook_id: z.string().uuid().describe("The target notebook ID"),
    },
    ({ note_id, notebook_id }) => moveNote(supabase, userId, note_id, notebook_id),
  );

  server.tool(
    "trash_note",
    "Move a note to trash (soft-delete, recoverable for 30 days)",
    { note_id: z.string().uuid().describe("The note ID to trash") },
    ({ note_id }) => trashNote(supabase, userId, note_id),
  );

  return server;
}

export async function POST(request: Request): Promise<Response> {
  let supabase: SupabaseClient<Database>;
  let userId: string;

  try {
    const auth = await authenticateMcpRequest(request.headers.get("authorization"));
    supabase = auth.supabase;
    userId = auth.userId;
  } catch (err) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: (err as Error).message },
        id: null,
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = createMcpServer(supabase, userId);
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
