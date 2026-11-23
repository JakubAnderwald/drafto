import { ATTACHMENT_URL_PREFIX } from "../constants";
import { radii, spacing, type SemanticColors } from "../design-tokens";
import { formatFileSize } from "../formatters/file-size";
import { UNIQUE_KEY_SUFFIX } from "./attachment-url";

// How a link to a non-image attachment looks in the editors (PrimeTestLab
// 11035 S-04): a small card with a file icon, the file name and its size.
//
// The native editors (TenTap's prebuilt WebView bundle) have no `file` node,
// and an unknown node blanks the whole note, so a file stays the paragraph
// with one linked file name it has always been projected to
// (format-converter.ts). The card is CSS on that link, and the size comes
// from a stylesheet built from the note's attachment rows, keyed on the
// link's href. The stored content does not change.

/** Tag of the per-note size stylesheet the native editors inject. */
export const ATTACHMENT_SIZES_CSS_TAG = "attachment-sizes";

/** Path of a Supabase signed URL to an object in the attachments bucket. */
const SIGNED_ATTACHMENT_PATH = "/storage/v1/object/sign/attachments/";

/**
 * Links to an attachment in the native editor's DOM: the signed URL a file
 * link is resolved to for display, or its stored `attachment://` URL. TipTap
 * renders a link whose protocol it does not know with an empty href, so today
 * the second only matches if that changes; the card still never applies to
 * an ordinary link or to an image (an `<img>`, never a link).
 */
export const ATTACHMENT_LINK_SELECTORS = [
  `.ProseMirror a[href^="${ATTACHMENT_URL_PREFIX}"]`,
  `.ProseMirror a[href*="${SIGNED_ATTACHMENT_PATH}"]`,
] as const;

/**
 * Lucide's "file" outline, used as a mask so it takes the card's muted colour
 * in both themes. Percent-encoded for a `data:` URL.
 */
const FILE_ICON_DATA_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'/%3E%3Cpath d='M14 2v4a2 2 0 0 0 2 2h4'/%3E%3C/svg%3E";

/** Every attachment link selector with `suffix` appended, as one selector list. */
function linkSelectorList(suffix: string): string {
  return ATTACHMENT_LINK_SELECTORS.map((selector) => `${selector}${suffix}`).join(", ");
}

/**
 * The card style for file links in the native editors, in `semantic`'s
 * colours. Mobile ships it with its theme colours (and re-injects it with
 * them on a theme switch); desktop's editor is light only.
 *
 * The descendant rule undoes mobile's `* { background-color; color }`, which
 * would otherwise paint a bold or italic file name in the page colour.
 */
export function buildAttachmentCardCss(semantic: SemanticColors): string {
  const icon = `url("${FILE_ICON_DATA_URL}") center / contain no-repeat`;
  return [
    `${linkSelectorList("")} { display: inline-block; max-width: 100%; box-sizing: border-box; padding: ${spacing.xs + spacing["2xs"]}px ${spacing.md}px; border: 1px solid ${semantic.borderStrong}; border-radius: ${radii.md}px; background-color: ${semantic.bgSubtle}; color: ${semantic.fg}; text-decoration: none; overflow-wrap: anywhere; line-height: 1.4; }`,
    `${linkSelectorList(" *")} { background-color: transparent; color: inherit; }`,
    `${linkSelectorList("::before")} { content: ""; display: inline-block; width: 1.1em; height: 1.1em; margin-right: ${spacing.sm}px; vertical-align: -0.2em; background-color: ${semantic.fgMuted}; -webkit-mask: ${icon}; mask: ${icon}; }`,
    `${linkSelectorList("::after")} { margin-left: ${spacing.sm}px; color: ${semantic.fgMuted}; white-space: nowrap; }`,
  ].join("\n");
}

/** What the size stylesheets need to know about one of a note's attachments. */
export interface AttachmentSizeInfo {
  filePath: string;
  fileSize: number | null | undefined;
  mimeType?: string | null;
}

/**
 * Characters written into a CSS string as they are. Everything else is a hex
 * escape, so no file name can end the string, the rule or a `<style>`.
 */
const CSS_STRING_SAFE_CHAR = /^[A-Za-z0-9 _\-./:%@+=,!~]$/;

/** `value` as a double-quoted CSS string. */
export function cssString(value: string): string {
  let out = '"';
  for (const char of value) {
    out += CSS_STRING_SAFE_CHAR.test(char) ? char : `\\${char.codePointAt(0)!.toString(16)} `;
  }
  return `${out}"`;
}

function encodeOrNull(encode: (value: string) => string, value: string): string | null {
  try {
    return encode(value);
  } catch {
    // A lone surrogate can't be URI-encoded; no href holds it encoded either.
    return null;
  }
}

/**
 * Substrings of a link href that identify the attachment stored at
 * `filePath`, in any form the href takes: `attachment://<path>`, or a signed
 * URL whose path may be percent-encoded (Supabase passes it through
 * `encodeURI`, and the server may have encoded its segments first). A key with
 * the unique upload suffix is matched on that suffix alone; an older key on its
 * whole path, raw and in each encoding.
 */
export function attachmentHrefFragments(filePath: string): string[] {
  const suffix = filePath.match(UNIQUE_KEY_SUFFIX);
  if (suffix) return [suffix[0]];
  const segmentEncoded = encodeOrNull(
    (path) => path.split("/").map(encodeURIComponent).join("/"),
    filePath,
  );
  const candidates = [
    filePath,
    encodeOrNull(encodeURI, filePath),
    segmentEncoded,
    segmentEncoded === null ? null : encodeOrNull(encodeURI, segmentEncoded),
  ];
  return [...new Set(candidates.filter((value): value is string => !!value))];
}

/** The attachments that get a size label, each once, with that label. */
function sizedFiles(
  attachments: readonly AttachmentSizeInfo[],
): { filePath: string; label: string }[] {
  // Images are not left out: the rules below only reach file links and file
  // blocks, never an `<img>`, and an image uploaded into a web file block is
  // shown as a card like any other file.
  const byPath = new Map<string, string>();
  for (const attachment of attachments) {
    if (!attachment.filePath || typeof attachment.fileSize !== "number") continue;
    const label = formatFileSize(attachment.fileSize);
    if (label) byPath.set(attachment.filePath, label);
  }
  return [...byPath].map(([filePath, label]) => ({ filePath, label }));
}

/**
 * One rule per sized attachment: `selectorsFor(fragment)` for each of its
 * href fragments, setting `content` to its size. Rules for longer fragments
 * come later, so where one key's fragment is part of another's, the longer
 * (more specific) match wins.
 */
function buildSizeRules(
  attachments: readonly AttachmentSizeInfo[],
  selectorsFor: (fragment: string) => readonly string[],
): string {
  return sizedFiles(attachments)
    .map(({ filePath, label }) => {
      const fragments = attachmentHrefFragments(filePath);
      return { fragments, label, length: Math.max(...fragments.map((f) => f.length)) };
    })
    .sort((a, b) => a.length - b.length)
    .map(({ fragments, label }) => {
      const selectors = fragments.flatMap((fragment) => selectorsFor(cssString(fragment)));
      return `${selectors.join(", ")} { content: ${cssString(label)}; }`;
    })
    .join("\n");
}

/**
 * The native editors' per-note size stylesheet: for each attachment with a
 * known size, a rule that writes its size after the file links to it, e.g.
 * `… a[href*="-1700000000000-0a1b2c3d"]::after { content: "1.2 MB"; }`.
 */
export function buildAttachmentSizeCss(attachments: readonly AttachmentSizeInfo[]): string {
  return buildSizeRules(attachments, (fragment) =>
    ATTACHMENT_LINK_SELECTORS.map((selector) => `${selector}[href*=${fragment}]::after`),
  );
}

/**
 * The web editor's size stylesheet. BlockNote renders a file block with its
 * URL in `data-url`. For a saved note that is the signed URL `GET
 * /api/notes/:id` resolved it to, and for a file just uploaded it may be
 * `attachment://<path>`, so each rule matches the same encoding-stable
 * fragments as the native rules (`data-url*=`) and writes the size after the
 * block's icon and name.
 */
export function buildFileBlockSizeCss(attachments: readonly AttachmentSizeInfo[]): string {
  return buildSizeRules(attachments, (fragment) => [
    `.bn-block-content[data-content-type="file"][data-url*=${fragment}] .bn-file-name-with-icon::after`,
  ]);
}
