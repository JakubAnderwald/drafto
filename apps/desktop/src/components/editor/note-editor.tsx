import { StyleSheet } from "react-native";
import { RichText, Toolbar, DEFAULT_TOOLBAR_ITEMS } from "@10play/tentap-editor";
import type { EditorBridge } from "@10play/tentap-editor";

import { useTheme } from "@/providers/theme-provider";

interface NoteEditorProps {
  editor: EditorBridge;
}

export function NoteEditor({ editor }: NoteEditorProps) {
  const { semantic } = useTheme();

  return (
    <>
      <RichText editor={editor} style={[styles.editor, { backgroundColor: semantic.bg }]} />
      <Toolbar editor={editor} items={DEFAULT_TOOLBAR_ITEMS} />
    </>
  );
}

const styles = StyleSheet.create({
  editor: {
    flex: 1,
  },
});
