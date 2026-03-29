"use client";

import { useCallback, useRef } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { Block } from "@blocknote/core";
import "@blocknote/mantine/style.css";
import { useTheme } from "@/hooks/use-theme";
import { toAttachmentUrl, isAttachmentUrl, extractFilePath } from "@drafto/shared";

interface NoteEditorProps {
  noteId: string;
  initialContent?: Block[];
  onChange?: (content: Block[]) => void;
}

export function NoteEditor({ noteId, initialContent, onChange }: NoteEditorProps) {
  const { resolvedTheme } = useTheme();
  const uploadFile = useCallback(
    async (file: File): Promise<string> => {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`/api/notes/${noteId}/attachments`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Upload failed");
      }

      const data = await response.json();
      if (typeof data.file_path !== "string" || data.file_path.length === 0) {
        throw new Error("Upload succeeded but no file path was returned");
      }
      return toAttachmentUrl(data.file_path);
    },
    [noteId],
  );

  const urlCache = useRef(new Map<string, string>());

  const resolveFileUrl = useCallback(async (url: string): Promise<string> => {
    if (!isAttachmentUrl(url)) {
      return url;
    }

    const cached = urlCache.current.get(url);
    if (cached) {
      return cached;
    }

    const filePath = extractFilePath(url);
    const response = await fetch("/api/attachments/resolve-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath }),
    });

    if (!response.ok) {
      throw new Error("Failed to resolve attachment URL");
    }

    const data = await response.json();
    urlCache.current.set(url, data.signedUrl);
    return data.signedUrl;
  }, []);

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
