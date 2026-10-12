import { spacing } from "@/theme/tokens";

// The note body's font stack, matching the mobile editor. Without it the
// WebView falls back to its default serif (Times).
export const EDITOR_FONT_CSS = `body, .ProseMirror { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a; }`;

/**
 * Horizontal gutter for the note body, lined up with the title above it (the
 * panel header's `paddingHorizontal: spacing["2xl"]`). TenTap's page CSS sets
 * `body { padding: 0 }`, so without it the text and images touch the panel
 * edge. Horizontal only: TenTap owns `padding-bottom`.
 */
export const EDITOR_LAYOUT_CSS = `.ProseMirror { padding-left: ${spacing["2xl"]}px; padding-right: ${spacing["2xl"]}px; }`;

/**
 * Stylesheet shipped with the editor through `CoreBridge.configureCSS`, so
 * TenTap injects it together with every bridge's own CSS (image max-width,
 * blockquote, task list, placeholder) on each WebView load.
 */
export const EDITOR_CSS = `${EDITOR_FONT_CSS}\n${EDITOR_LAYOUT_CSS}`;
