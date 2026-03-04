"use client";

import { useCallback } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { Block } from "@blocknote/core";
import type { Theme } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";

const draftoTheme: Theme = {
  colors: {
    editor: { text: "var(--fg)", background: "var(--bg)" },
    menu: { text: "var(--fg)", background: "var(--bg)" },
    tooltip: { text: "var(--fg)", background: "var(--bg-muted)" },
    hovered: { text: "var(--fg)", background: "var(--bg-muted)" },
    selected: { text: "var(--fg-on-primary)", background: "var(--ring)" },
    disabled: { text: "var(--fg-subtle)", background: "var(--bg-muted)" },
    shadow: "var(--border)",
    border: "var(--border)",
    sideMenu: "var(--fg-subtle)",
  },
  borderRadius: 6,
  fontFamily: "var(--font-sans, Arial, Helvetica, sans-serif)",
};

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
      if (typeof data.url !== "string" || data.url.length === 0) {
        throw new Error("Upload succeeded but no file URL was returned");
      }
      return data.url;
    },
    [noteId],
  );

  const editor = useCreateBlockNote({
    initialContent: initialContent && initialContent.length > 0 ? initialContent : undefined,
    uploadFile,
  });

  return (
    <div data-testid="editor-scroll-container" className="min-h-0 flex-1 overflow-y-auto">
      <BlockNoteView
        editor={editor}
        onChange={() => {
          onChange?.(editor.document);
        }}
        theme={draftoTheme}
      />
    </div>
  );
}
