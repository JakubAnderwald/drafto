import type { NextRequest } from "next/server";
import { getAuthenticatedNoteOwner, errorResponse, successResponse } from "@/lib/api/utils";
import { convertEnmlToBlocks } from "@/lib/import/enml-to-blocknote";
import type { ImportFinalizeRequest } from "@/lib/import/types";
import type { Json } from "@/lib/supabase/database.types";
import { ATTACHMENT_URL_PREFIX } from "@drafto/shared";

/**
 * Second phase of an Evernote import: convert the note's ENML to BlockNote
 * blocks and write them to the (already-created) note. Attachment bytes have
 * already been uploaded directly to Storage by the client; here we receive only
 * the small ENML string plus a map of `<en-media hash>` (MD5) → durable
 * `attachment://` URL, so the request body stays tiny regardless of attachment
 * size.
 */
export async function POST(request: NextRequest) {
  let body: ImportFinalizeRequest;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { noteId, content, attachments, tasks } = body;
  if (typeof noteId !== "string" || !noteId) {
    return errorResponse("noteId is required", 400);
  }
  if (typeof content !== "string") {
    return errorResponse("content is required", 400);
  }
  // Validate the (untrusted) tasks shape up front so a malformed payload yields
  // a deterministic 400 rather than crashing convertEnmlToBlocks into a 500.
  if (tasks !== undefined) {
    const valid =
      Array.isArray(tasks) &&
      tasks.every(
        (t) =>
          typeof t?.title === "string" &&
          typeof t?.checked === "boolean" &&
          typeof t?.groupId === "string" &&
          (t.sortWeight === undefined || typeof t.sortWeight === "string"),
      );
    if (!valid) {
      return errorResponse("tasks must be a valid task array", 400);
    }
  }

  const { data: auth, error: authError } = await getAuthenticatedNoteOwner(noteId, request);
  if (authError) return authError;

  const { supabase, user } = auth;

  // Build the en-media hash → attachment map. Skip (do NOT reject the whole
  // request for) any attachment URL that does not point inside this user's own
  // note: dropping a stray reference keeps the note's text intact, while still
  // defending against a client smuggling an attachment:// pointer to someone
  // else's file (such a URL never makes it into the saved content, so the note
  // GET route can't be tricked into signing it).
  const expectedPrefix = `${ATTACHMENT_URL_PREFIX}${user.id}/${noteId}/`;
  const attachmentMap = new Map<string, { url: string; name: string }>();
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (
        typeof att?.md5 !== "string" ||
        typeof att?.url !== "string" ||
        typeof att?.name !== "string" ||
        !att.url.startsWith(expectedPrefix)
      ) {
        continue;
      }
      attachmentMap.set(att.md5.toLowerCase(), { url: att.url, name: att.name });
    }
  }

  const blocks = convertEnmlToBlocks(content, attachmentMap, tasks);

  const { error: updateError } = await supabase
    .from("notes")
    .update({ content: blocks as unknown as Json[] })
    .eq("id", noteId)
    .eq("user_id", user.id);

  if (updateError) {
    return errorResponse(`Failed to update note content: ${updateError.message}`, 500);
  }

  return successResponse({ noteId, blockCount: blocks.length }, 200);
}
