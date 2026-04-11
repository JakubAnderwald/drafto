"use client";

import { useCallback } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { Block } from "@blocknote/core";
import "@blocknote/mantine/style.css";
import { useTheme } from "@/hooks/use-theme";
import { toAttachmentUrl, MAX_FILE_SIZE, BUCKET_NAME } from "@drafto/shared";
import { useAttachmentUrlResolver } from "@/components/editor/use-attachment-url-resolver";
import { createClient } from "@/lib/supabase/client";

interface NoteEditorProps {
  noteId: string;
  initialContent?: Block[];
  onChange?: (content: Block[]) => void;
}

export function NoteEditor({ noteId, initialContent, onChange }: NoteEditorProps) {
  const { resolvedTheme } = useTheme();
  const uploadFile = useCallback(
    async (file: File): Promise<string> => {
      if (file.size === 0) {
        throw new Error("File is empty");
      }
      if (file.size > MAX_FILE_SIZE) {
        throw new Error("File size exceeds 25MB limit");
      }

      // Step 1: Request a signed upload URL from the server
      const urlResponse = await fetch(`/api/notes/${noteId}/attachments/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
        }),
      });

      if (!urlResponse.ok) {
        const error = await urlResponse.json().catch(() => null);
        throw new Error(error?.error || `Failed to prepare upload (${urlResponse.status})`);
      }

      const { token, filePath } = await urlResponse.json();

      // Step 2: Upload the file directly to Supabase Storage (bypasses Vercel size limit)
      const supabase = createClient();
      const { error: uploadError } = await supabase.storage
        .from(BUCKET_NAME)
        .uploadToSignedUrl(filePath, token, file, {
          contentType: file.type || "application/octet-stream",
        });

      if (uploadError) {
        throw new Error(`Upload failed: ${uploadError.message}`);
      }

      // Step 3: Confirm the upload and create the attachment record
      const confirmResponse = await fetch(`/api/notes/${noteId}/attachments/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
        }),
      });

      if (!confirmResponse.ok) {
        const error = await confirmResponse.json().catch(() => null);
        throw new Error(error?.error || `Failed to confirm upload (${confirmResponse.status})`);
      }

      const data = await confirmResponse.json();
      if (typeof data.file_path !== "string" || data.file_path.length === 0) {
        throw new Error("Upload succeeded but no file path was returned");
      }
      return toAttachmentUrl(data.file_path);
    },
    [noteId],
  );

  const resolveFileUrl = useAttachmentUrlResolver();

  const editor = useCreateBlockNote({
    initialContent: initialContent && initialContent.length > 0 ? initialContent : undefined,
    uploadFile,
    resolveFileUrl,
  });

  return (
    <div data-testid="editor-scroll-container" className="min-h-0 flex-1 overflow-y-auto">
      <BlockNoteView
        editor={editor}
        onChange={() => {
          onChange?.(editor.document);
        }}
        theme={resolvedTheme}
      />
    </div>
  );
}
