import { spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

// The note body uses the same font stack as the desktop editor. Without it the
// WebView falls back to its default serif (Times).
export const EDITOR_FONT_CSS = `body, .ProseMirror { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; }`;

/**
 * Horizontal gutter for the note body, matching the title field's
 * `paddingHorizontal: spacing.lg` so the body lines up with the title. TenTap's
 * page CSS sets `body { padding: 0 }` and nothing else adds a gutter, so
 * without this the text and images run edge to edge. Horizontal only: TenTap
 * owns `padding-bottom` (it sets it inline to keep the caret clear of the
 * keyboard).
 */
export const EDITOR_LAYOUT_CSS = `.ProseMirror { padding-left: ${spacing.lg}px; padding-right: ${spacing.lg}px; }`;

/**
 * Colour rules for the TenTap WebView. The WebView's default stylesheet renders
 * black text, so in dark mode the body must be told to use the light
 * foreground — otherwise it reads as dark text on the dark background.
 */
export function buildEditorColorCss(semantic: SemanticColors, isDark: boolean): string {
  const base = `* { background-color: ${semantic.bg}; color: ${semantic.fg}; }`;
  if (!isDark) return base;
  return `${base}
blockquote { border-left: 3px solid ${semantic.borderStrong}; padding-left: 1rem; }
.highlight-background { background-color: ${semantic.bgMuted}; }`;
}

/**
 * Full stylesheet shipped with the editor's initial load (via
 * `CoreBridge.configureCSS`). TenTap re-applies it on every WebView load, so
 * the colours survive a WebView reload — a post-load `injectCSS` alone does not.
 */
export function buildEditorCss(semantic: SemanticColors, isDark: boolean): string {
  return `${EDITOR_FONT_CSS}\n${EDITOR_LAYOUT_CSS}\n${buildEditorColorCss(semantic, isDark)}`;
}
