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
   * `exclusivelyUseCustomOnMessage={false}` on <RichText>. In tentap 1.1.0 an
   * unset prop still means `true` whenever an onMessage is given
   * (`exclusivelyUseCustomOnMessage ?? true` in RichText), and exclusive mode
   * stops tentap's bridges receiving editor messages (onChange / content
   * updates and custom bridges), which breaks saving. The value stays explicit
   * so the find bar never depends on tentap's default, which has already been
   * kept only for backwards compatibility. With it false, tentap still handles
   * its messages AND this callback receives every message (callers must filter
   * for their own payloads) — used by the find bar to read match counts posted
   * from the injected engine.
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
        // No `injectedJavaScript` here: it would replace TenTap's own script,
        // which installs every bridge's CSS. The editor's stylesheet ships
        // through the core bridge instead (see editor-bridge-extensions.ts).
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
