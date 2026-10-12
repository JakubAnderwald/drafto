import { CoreBridge, TenTapStartKit } from "@10play/tentap-editor";

import { EDITOR_CSS } from "@/lib/editor-css";

/**
 * The editor's bridge extensions: TenTap's starter kit plus our stylesheet on
 * the core bridge, the same way the mobile editor ships its CSS.
 *
 * The stylesheet used to be passed to `<RichText>` as `injectedJavaScript`.
 * That prop replaces TenTap's own injected script, which is what installs each
 * bridge's CSS, so on macOS images were never capped to the editor width and
 * blockquotes, task lists and the placeholder went unstyled. Through
 * `configureCSS` it is injected alongside them instead.
 *
 * Module-level so `useEditorBridge` sees one stable array.
 */
export const EDITOR_BRIDGE_EXTENSIONS = [...TenTapStartKit, CoreBridge.configureCSS(EDITOR_CSS)];
