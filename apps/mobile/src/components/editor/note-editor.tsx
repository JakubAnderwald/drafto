import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { RichText, Toolbar, DEFAULT_TOOLBAR_ITEMS } from "@10play/tentap-editor";
import type { EditorBridge } from "@10play/tentap-editor";
import type { WebViewMessageEvent } from "react-native-webview";

import { useTheme } from "@/providers/theme-provider";
import { EDITOR_WEBVIEW_FILE_ACCESS_PROPS } from "@/lib/editor-webview";

interface NoteEditorProps {
  editor: EditorBridge;
  /**
   * Rendered between the note body and the formatting toolbar (the attachment
   * row). The toolbar stays last so that, with the keyboard up, it sits
   * directly on top of the keyboard.
   */
  accessory?: ReactNode;
  /**
   * Receives every WebView message as well (callers filter for their own, such
   * as the image render status). `exclusivelyUseCustomOnMessage={false}` keeps
   * TenTap's bridges receiving theirs: in tentap 1.1.0 an unset value means
   * exclusive mode once an onMessage is given, which would break saving.
   */
  onMessage?: (event: WebViewMessageEvent) => void;
}

export function NoteEditor({ editor, accessory, onMessage }: NoteEditorProps) {
  const { semantic } = useTheme();

  return (
    <>
      <RichText
        editor={editor}
        style={[styles.editor, { backgroundColor: semantic.bg }]}
        onMessage={onMessage}
        exclusivelyUseCustomOnMessage={false}
        // Cached attachment images are file:// URLs under the editor's base
        // URL (ADR-0086).
        {...EDITOR_WEBVIEW_FILE_ACCESS_PROPS}
        originWhitelist={[...EDITOR_WEBVIEW_FILE_ACCESS_PROPS.originWhitelist]}
      />
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
