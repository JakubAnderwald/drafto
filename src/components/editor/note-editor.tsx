"use client";

import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { Block } from "@blocknote/core";
import "@blocknote/mantine/style.css";

interface NoteEditorProps {
  initialContent?: Block[];
  onChange?: (content: Block[]) => void;
}

export function NoteEditor({ initialContent, onChange }: NoteEditorProps) {
  const editor = useCreateBlockNote({
    initialContent: initialContent && initialContent.length > 0 ? initialContent : undefined,
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
