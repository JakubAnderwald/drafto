"use client";

import { useCallback } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { Block } from "@blocknote/core";
import "@blocknote/mantine/style.css";

interface NoteEditorProps {
  noteId: string;
  initialContent?: Block[];
  onChange?: (content: Block[]) => void;
}

export function NoteEditor({ noteId, initialContent, onChange }: NoteEditorProps) {
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
      return data.url;
    },
    [noteId],
  );

  const editor = useCreateBlockNote({
    initialContent: initialContent && initialContent.length > 0 ? initialContent : undefined,
    uploadFile,
  });

  return (
    <div className="flex-1 overflow-y-auto">
      <BlockNoteView
        editor={editor}
        onChange={() => {
          onChange?.(editor.document);
        }}
        theme="light"
      />
    </div>
  );
}
