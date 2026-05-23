import type { NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import { ticktickItemToBlocks } from "@/lib/import/ticktick-to-blocks";
import type {
  TickTickImportBatchRequest,
  TickTickImportBatchResult,
  TickTickItem,
} from "@/lib/import/ticktick-types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

const MAX_BATCH_SIZE = 20;

export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;

  let body: TickTickImportBatchRequest;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
    return errorResponse("No items provided", 400);
  }

  if (body.items.length > MAX_BATCH_SIZE) {
    return errorResponse(`Maximum ${MAX_BATCH_SIZE} items per batch`, 400);
  }

  let notebookId = body.notebookId;
  if (!notebookId) {
    const name = (body.notebookName || "TickTick Import").slice(0, 200);
    const { data: notebook, error: nbError } = await supabase
      .from("notebooks")
      .insert({ name, user_id: user.id })
      .select("id")
      .single();

    if (nbError || !notebook) {
      return errorResponse("Failed to create notebook", 500);
    }
    notebookId = notebook.id;
  }

  const result: TickTickImportBatchResult = {
    notebookId,
    notesImported: 0,
    notesFailed: 0,
    errors: [],
  };

  for (const item of body.items) {
    try {
      await importItem(supabase, user.id, notebookId, item);
      result.notesImported++;
    } catch (err) {
      result.notesFailed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      result.errors.push(`"${item.title}": ${message}`);
    }
  }

  return successResponse(result, 200);
}

async function importItem(
  supabase: SupabaseClient<Database>,
  userId: string,
  notebookId: string,
  item: TickTickItem,
): Promise<void> {
  const blocks = ticktickItemToBlocks(item);

  const { error: insertError } = await supabase.from("notes").insert({
    title: item.title.slice(0, 500),
    content: blocks as unknown as Json[],
    notebook_id: notebookId,
    user_id: userId,
    created_at: item.created,
    updated_at: item.updated,
  });

  if (insertError) {
    throw new Error(`Failed to create note: ${insertError.message}`);
  }
}
