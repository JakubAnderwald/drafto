import { type NextRequest } from "next/server";

import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";

interface SearchNoteResult {
  id: string;
  title: string;
  notebook_id: string;
  is_trashed: boolean;
  trashed_at: string | null;
  updated_at: string;
  content_snippet: string;
}

export async function GET(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;
  const { supabase } = auth;

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";

  if (!q) {
    return errorResponse("Query parameter 'q' is required", 400);
  }

  if (q.length > 200) {
    return errorResponse("Query parameter 'q' must be 200 characters or less", 400);
  }

  // search_notes RPC not in generated types — Database.Functions is Record<string, never>
  const { data, error } = (await supabase.rpc(
    "search_notes" as never,
    {
      search_query: q,
    } as never,
  )) as { data: SearchNoteResult[] | null; error: { message: string } | null };

  if (error) {
    console.error("search_notes RPC failed", error);
    return errorResponse("Failed to search notes", 500);
  }

  return successResponse(data);
}
