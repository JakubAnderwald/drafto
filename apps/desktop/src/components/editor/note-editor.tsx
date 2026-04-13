import { useState, useEffect } from "react";
import { StyleSheet, View, ActivityIndicator } from "react-native";
import { RichText, Toolbar, DEFAULT_TOOLBAR_ITEMS } from "@10play/tentap-editor";
import type { EditorBridge } from "@10play/tentap-editor";

import { useTheme } from "@/providers/theme-provider";
import { colors } from "@/theme/tokens";

interface NoteEditorProps {
  editor: EditorBridge;
}

export function NoteEditor({ editor }: NoteEditorProps) {
  const { semantic } = useTheme();

  // Defer WebView rendering to the next frame to avoid native init crashes on macOS.
  // The WKWebView + RN bridge initialization can crash with nil dictionary values
  // if triggered synchronously during the component tree mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 100);
    return () => clearTimeout(timer);
  }, []);

  if (!mounted) {
    return (
      <View style={[styles.editor, styles.loading]}>
        <ActivityIndicator size="small" color={colors.primary[600]} />
      </View>
    );
  }

  return (
    <>
      <RichText
        editor={editor}
        style={[styles.editor, { backgroundColor: semantic.bg }]}
        scrollEnabled={true}
        injectedJavaScript={`
          (function() {
            var style = document.createElement('style');
            style.textContent = 'body, .ProseMirror { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a; }';
            document.head.appendChild(style);
          })();
        `}
      />
      <Toolbar editor={editor} items={DEFAULT_TOOLBAR_ITEMS} />
    </>
  );
}

const styles = StyleSheet.create({
  editor: {
    flex: 1,
  },
  loading: {
    alignItems: "center",
    justifyContent: "center",
  },
});
