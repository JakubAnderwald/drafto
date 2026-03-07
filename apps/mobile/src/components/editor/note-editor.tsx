import { StyleSheet } from "react-native";
import { RichText, Toolbar, DEFAULT_TOOLBAR_ITEMS } from "@10play/tentap-editor";
import type { EditorBridge } from "@10play/tentap-editor";

interface NoteEditorProps {
  editor: EditorBridge;
}

export function NoteEditor({ editor }: NoteEditorProps) {
  return (
    <>
      <RichText editor={editor} style={styles.editor} />
      <Toolbar editor={editor} items={DEFAULT_TOOLBAR_ITEMS} />
    </>
  );
}

const styles = StyleSheet.create({
  editor: {
    flex: 1,
    backgroundColor: "#fff",
  },
});
