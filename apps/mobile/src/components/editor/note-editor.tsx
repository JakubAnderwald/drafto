import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { RichText, Toolbar } from "@10play/tentap-editor";
import type { EditorBridge } from "@10play/tentap-editor";
import type { WebViewMessageEvent } from "react-native-webview";

import { useTheme } from "@/providers/theme-provider";
import { EDITOR_WEBVIEW_FILE_ACCESS_PROPS } from "@/lib/editor-webview";
import { useEditorPage } from "@/hooks/use-editor-page";
import { NOTE_HEADING_ITEMS, NOTE_TOOLBAR_ITEMS } from "@/components/editor/toolbar-items";

interface NoteEditorProps {
  editor: EditorBridge;
  /**
   * Rendered between the note body and the formatting toolbar (the attachment
   * row). The toolbar stays last so that, with the keyboard up, it sits
   * directly on top of the keyboard, and with it down, just above the bottom
   * safe-area inset.
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
  // On iOS the page loads from a file in the attachment cache, with read
  // access to the cached images (ADR-0086); until that file is checked, the
  // body stays an empty view of the editor's colour.
  const page = useEditorPage();

  return (
    <>
      {page.ready ? (
        <RichText
          editor={editor}
          style={[styles.editor, { backgroundColor: semantic.bg }]}
          onMessage={onMessage}
          exclusivelyUseCustomOnMessage={false}
          // Cached attachment images are file:// URLs in the attachment cache
          // (ADR-0086).
          {...EDITOR_WEBVIEW_FILE_ACCESS_PROPS}
          originWhitelist={[...EDITOR_WEBVIEW_FILE_ACCESS_PROPS.originWhitelist]}
          {...page.webViewProps}
        />
      ) : (
        <View
          testID="note-editor-page-loading"
          style={[styles.editor, { backgroundColor: semantic.bg }]}
        />
      )}
      {accessory}
      {/* Always shown (PrimeTestLab 11035 S-02): TenTap's default hides the
        toolbar whenever the keyboard is down or the editor is blurred, so
        formatting was out of reach while reading a note. Each formatting
        button focuses the editor before it applies (toolbar-items.ts), which
        brings the keyboard up. */}
      <Toolbar
        editor={editor}
        items={NOTE_TOOLBAR_ITEMS}
        headingItems={NOTE_HEADING_ITEMS}
        hidden={false}
      />
    </>
  );
}

const styles = StyleSheet.create({
  editor: {
    flex: 1,
  },
});
