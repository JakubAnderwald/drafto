import { isAttachmentUrl, resolveTipTapImageUrls } from "@drafto/shared";
import type { TipTapDoc, TipTapNode } from "@drafto/shared";

// Pure, side-effect-free helpers for the note editor's content-load path.
// Splitting this branch logic out of `note-editor-panel.tsx` keeps it unit
// testable without standing up the tentap WebView bridge — the branch behind
// the macOS "note opens blank" bug (issue #551).

type UrlResolver = (filePath: string) => Promise<string>;

/**
 * Classification of a note's stored `content` string into the action the editor
 * load path should take.
 *
 * - `empty`      — no content; clear the editor.
 * - `html`       — plain text or unrecognised JSON; render as paragraph HTML.
 * - `structured` — a BlockNote array or TipTap doc to convert and load.
 *
 * Crucially, only a genuinely empty string maps to `empty`; any non-empty
 * content is always either `html` or `structured`, never `empty`. That guards
 * the data-loss invariant — the load path must never blank a note that actually
 * has content (the 2026-04-24 / 2026-04-27 incident class).
 */
export type NoteContentLoad =
  | { kind: "empty" }
  | { kind: "html"; html: string }
  | { kind: "structured"; value: unknown };

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Convert plain text to the paragraph-per-line HTML tentap's setContent accepts. */
export function textToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`)
    .join("");
}

export function classifyNoteContent(rawContent: string): NoteContentLoad {
  if (!rawContent) return { kind: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    // Not JSON — render as plain text.
    return { kind: "html", html: textToHtml(rawContent) };
  }

  // An empty array is an empty BlockNote document — render an empty editor, not
  // the literal text "[]". `"[]"` is a real stored value (web persists it for a
  // legacy-empty doc, which then syncs to desktop); contentToTiptap([]) on
  // mobile/web maps it to an empty doc, so do the same here.
  if (Array.isArray(parsed) && parsed.length === 0) return { kind: "empty" };

  const isBlockNote =
    Array.isArray(parsed) && parsed.length > 0 && Boolean((parsed[0] as { type?: string })?.type);
  const isTipTap =
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as { type?: string }).type === "doc";

  if (!isBlockNote && !isTipTap) {
    // Valid JSON but not a recognised editor document (a bare number, an empty
    // array, an unknown object shape). Fall back to plain text rather than
    // handing setContent a doc it can't parse and silently blanking the note.
    return { kind: "html", html: textToHtml(rawContent) };
  }

  return { kind: "structured", value: parsed };
}

// Node types that carry an attachment in attrs.src (mirrors the shared resolver
// resolveTipTapImageUrls, which handles both image and file nodes).
const ATTACHMENT_NODE_TYPES = new Set(["image", "file"]);

/**
 * Whether a TipTap node tree contains any `attachment://` URL that must be
 * resolved to a signed URL before the editor can display/open it. Drives whether
 * the editor surface waits on URL resolution before mounting (so it hydrates
 * with resolved URLs in one shot) rather than mounting with unresolved
 * `attachment://` references.
 *
 * This MUST stay in lockstep with what `resolveTipTapImageUrls` actually
 * resolves — image AND file nodes (via `attrs.src`) and inline link marks (via
 * `attrs.href`, the form a non-image attachment is stored as). A narrower gate
 * would skip resolution and leave those references dead.
 */
export function hasAttachmentUrls(nodes: TipTapNode[]): boolean {
  for (const node of nodes) {
    if (
      typeof node.type === "string" &&
      ATTACHMENT_NODE_TYPES.has(node.type) &&
      typeof node.attrs?.src === "string" &&
      isAttachmentUrl(node.attrs.src)
    ) {
      return true;
    }
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (
          mark?.type === "link" &&
          typeof mark.attrs?.href === "string" &&
          isAttachmentUrl(mark.attrs.href)
        ) {
          return true;
        }
      }
    }
    if (node.content && hasAttachmentUrls(node.content)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a doc's `attachment://` image URLs to signed URLs, but never let a
 * resolution failure blank the note. On error, return the unresolved doc so
 * text and structure still render and images degrade to a placeholder. This is
 * display-only: `attachment://` is the canonical stored form, so the gated
 * autosave can persist the unresolved doc back without corruption.
 *
 * `resolveTipTapImageUrls` already tolerates per-URL failures internally (it
 * uses `Promise.allSettled`); this guard covers the rarer case where the call
 * itself throws (e.g. a malformed doc), which would otherwise route the entire
 * load into the gated `catch` and leave the editor blank.
 */
export async function resolveImageUrlsOrFallback(
  doc: TipTapDoc,
  resolver: UrlResolver,
): Promise<TipTapDoc> {
  try {
    return await resolveTipTapImageUrls(doc, resolver);
  } catch (err) {
    console.warn("[note-editor] image URL resolution failed; rendering unresolved doc", err);
    return doc;
  }
}
