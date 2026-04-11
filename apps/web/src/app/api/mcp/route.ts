import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authenticateMcpRequest } from "@/lib/api/mcp-auth";
import { blockNoteToMarkdown, markdownToBlockNote, contentToBlocknote } from "@drafto/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

function createMcpServer(supabase: SupabaseClient<Database>, userId: string): McpServer {
  const server = new McpServer(
    { name: "drafto", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // --- list_notebooks ---
  server.tool("list_notebooks", "List all notebooks for the current user", {}, async () => {
    const { data, error } = await supabase
      .from("notebooks")
      .select("id, name, created_at, updated_at")
      .eq("user_id", userId)
      .order("name");

    if (error)
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  });

  // --- list_notes ---
  server.tool(
    "list_notes",
    "List notes in a notebook (non-trashed, ordered by last updated)",
    { notebook_id: z.string().uuid().describe("The notebook ID to list notes from") },
    async ({ notebook_id }) => {
      const { data, error } = await supabase
        .from("notes")
        .select("id, title, created_at, updated_at")
        .eq("notebook_id", notebook_id)
        .eq("user_id", userId)
        .eq("is_trashed", false)
        .order("updated_at", { ascending: false });

      if (error)
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  // --- read_note ---
  server.tool(
    "read_note",
    "Read a note's full content as Markdown",
    { note_id: z.string().uuid().describe("The note ID to read") },
    async ({ note_id }) => {
      const { data: note, error } = await supabase
        .from("notes")
        .select("id, title, content, notebook_id, is_trashed, created_at, updated_at")
        .eq("id", note_id)
        .eq("user_id", userId)
        .single();

      if (error || !note) {
        return { content: [{ type: "text", text: "Error: Note not found" }], isError: true };
      }

      // Get notebook name
      const { data: notebook } = await supabase
        .from("notebooks")
        .select("name")
        .eq("id", note.notebook_id)
        .single();

      // Convert content to Markdown
      const blocks = contentToBlocknote(note.content);
      const contentMarkdown = blockNoteToMarkdown(blocks);

      const header = [
        `# ${note.title}`,
        ``,
        `- **Notebook**: ${notebook?.name ?? "Unknown"}`,
        `- **Created**: ${note.created_at}`,
        `- **Updated**: ${note.updated_at}`,
        `- **Trashed**: ${note.is_trashed ? "Yes" : "No"}`,
        ``,
        `---`,
        ``,
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: header + contentMarkdown,
          },
        ],
      };
    },
  );

  // --- search_notes ---
  server.tool(
    "search_notes",
    "Full-text search across all notes (titles, content, and notebook names)",
    { query: z.string().min(1).max(200).describe("Search query") },
    async ({ query }) => {
      const { data, error } = await supabase.rpc(
        "search_notes" as never,
        {
          search_query: query,
          requesting_user_id: userId,
        } as never,
      );

      if (error)
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  // --- create_notebook ---
  server.tool(
    "create_notebook",
    "Create a new notebook",
    { name: z.string().min(1).max(100).describe("Notebook name") },
    async ({ name }) => {
      const { data, error } = await supabase
        .from("notebooks")
        .insert({ user_id: userId, name: name.trim() })
        .select("id, name")
        .single();

      if (error)
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  // --- create_note ---
  server.tool(
    "create_note",
    "Create a new note in a notebook with optional Markdown content",
    {
      notebook_id: z.string().uuid().describe("The notebook ID to create the note in"),
      title: z.string().min(1).max(255).describe("Note title"),
      content_markdown: z.string().optional().describe("Note content in Markdown format"),
    },
    async ({ notebook_id, title, content_markdown }) => {
      // Verify notebook ownership
      const { data: notebook, error: nbError } = await supabase
        .from("notebooks")
        .select("id")
        .eq("id", notebook_id)
        .eq("user_id", userId)
        .single();

      if (nbError || !notebook) {
        return { content: [{ type: "text", text: "Error: Notebook not found" }], isError: true };
      }

      const content = content_markdown
        ? (markdownToBlockNote(content_markdown) as unknown as Json)
        : null;

      const { data: note, error } = await supabase
        .from("notes")
        .insert({
          notebook_id,
          user_id: userId,
          title: title.trim(),
          content,
        })
        .select("id, title")
        .single();

      if (error)
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(note, null, 2),
          },
        ],
      };
    },
  );

  // --- update_note ---
  server.tool(
    "update_note",
    "Update a note's title and/or content (provide Markdown for content)",
    {
      note_id: z.string().uuid().describe("The note ID to update"),
      title: z.string().min(1).max(255).optional().describe("New title"),
      content_markdown: z.string().optional().describe("New content in Markdown format"),
    },
    async ({ note_id, title, content_markdown }) => {
      const update: Record<string, unknown> = {};
      if (title !== undefined) update.title = title.trim();
      if (content_markdown !== undefined)
        update.content = markdownToBlockNote(content_markdown) as unknown as Json;

      if (Object.keys(update).length === 0) {
        return { content: [{ type: "text", text: "Error: No fields to update" }], isError: true };
      }

      const { data, error } = await supabase
        .from("notes")
        .update(update)
        .eq("id", note_id)
        .eq("user_id", userId)
        .select("id, title, updated_at")
        .single();

      if (error)
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  // --- move_note ---
  server.tool(
    "move_note",
    "Move a note to a different notebook",
    {
      note_id: z.string().uuid().describe("The note ID to move"),
      notebook_id: z.string().uuid().describe("The target notebook ID"),
    },
    async ({ note_id, notebook_id }) => {
      // Verify target notebook ownership
      const { data: notebook, error: nbError } = await supabase
        .from("notebooks")
        .select("id")
        .eq("id", notebook_id)
        .eq("user_id", userId)
        .single();

      if (nbError || !notebook) {
        return {
          content: [{ type: "text", text: "Error: Target notebook not found" }],
          isError: true,
        };
      }

      const { data, error } = await supabase
        .from("notes")
        .update({ notebook_id })
        .eq("id", note_id)
        .eq("user_id", userId)
        .select("id, title, notebook_id")
        .single();

      if (error)
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  // --- trash_note ---
  server.tool(
    "trash_note",
    "Move a note to trash (soft-delete, recoverable for 30 days)",
    { note_id: z.string().uuid().describe("The note ID to trash") },
    async ({ note_id }) => {
      const { data, error } = await supabase
        .from("notes")
        .update({ is_trashed: true, trashed_at: new Date().toISOString() })
        .eq("id", note_id)
        .eq("user_id", userId)
        .select("id, title")
        .single();

      if (error)
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };

      return {
        content: [
          {
            type: "text",
            text: `Note "${data.title}" moved to trash.`,
          },
        ],
      };
    },
  );

  return server;
}

export async function POST(request: Request): Promise<Response> {
  // Authenticate via API key
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

  // Create stateless MCP transport (no session persistence needed for serverless)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true, // simpler for serverless — no SSE needed
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

// MCP requires GET for SSE streams — return method not allowed in stateless mode
export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ error: "Method not allowed. Use POST for MCP requests." }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}

// MCP DELETE for session termination — not needed in stateless mode
export async function DELETE(): Promise<Response> {
  return new Response(JSON.stringify({ error: "Method not allowed. Stateless server." }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}
