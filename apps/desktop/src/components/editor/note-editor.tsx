import { useState, useEffect } from "react";
import { StyleSheet, View, ActivityIndicator } from "react-native";
import { RichText, Toolbar, DEFAULT_TOOLBAR_ITEMS } from "@10play/tentap-editor";
import type { EditorBridge } from "@10play/tentap-editor";
import type { WebViewMessageEvent } from "react-native-webview";

import { useTheme } from "@/providers/theme-provider";
import { colors } from "@/theme/tokens";

interface NoteEditorProps {
  editor: EditorBridge;
  /**
   * Optional passthrough for raw WebView messages. We pair this with
   * `exclusivelyUseCustomOnMessage={false}` on <RichText> because that prop
   * DEFAULTS TO `true` in tentap 1.0.1 — leaving it default while supplying a
   * custom onMessage suppresses tentap's own bridge handling (editor readiness,
   * onChange, getJSON), which breaks the whole editor. With it false, tentap
   * still handles its messages AND this callback receives every message (callers
   * must filter for their own payloads) — used by the find bar to read match
   * counts posted from the injected engine.
   */
  onMessage?: (event: WebViewMessageEvent) => void;
}

export function NoteEditor({ editor, onMessage }: NoteEditorProps) {
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
        onMessage={onMessage}
        exclusivelyUseCustomOnMessage={false}
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
