import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { RichText, Toolbar, DEFAULT_TOOLBAR_ITEMS } from "@10play/tentap-editor";
import type { EditorBridge } from "@10play/tentap-editor";

import { useTheme } from "@/providers/theme-provider";

interface NoteEditorProps {
  editor: EditorBridge;
  /**
   * Rendered between the note body and the formatting toolbar (the attachment
   * row). The toolbar stays last so that, with the keyboard up, it sits
   * directly on top of the keyboard.
   */
  accessory?: ReactNode;
}

export function NoteEditor({ editor, accessory }: NoteEditorProps) {
  const { semantic } = useTheme();

  return (
    <>
      <RichText editor={editor} style={[styles.editor, { backgroundColor: semantic.bg }]} />
      {accessory}
      <Toolbar editor={editor} items={DEFAULT_TOOLBAR_ITEMS} />
    </>
  );
}

const styles = StyleSheet.create({
  editor: {
    flex: 1,
  },
});
