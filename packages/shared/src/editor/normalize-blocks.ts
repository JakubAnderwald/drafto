import type { BlockNoteBlock, BlockNoteInlineContent, BlockNoteTableContent } from "./types";

/**
 * Normalize a BlockNote block tree so it conforms to the canonical inline
 * schema BlockNote validates against on editor mount.
 *
 * The Evernote importer historically emitted link inline content in a flat
 * shape — `{ type: "link", text, href, styles }` — that BlockNote rejects.
 * The canonical shape is `{ type: "link", href, content: [{ type: "text",
 * text, styles }] }`. Loading malformed content into `useCreateBlockNote`
 * throws, which trips the Next.js global error boundary. This normalizer
 * rewrites flat-link items into the canonical shape so existing notes
 * self-heal on load. It is idempotent and safe to call on every fetch.
 */
export function normalizeBlocks(blocks: BlockNoteBlock[]): BlockNoteBlock[] {
  return blocks.map(normalizeBlock);
}

function normalizeBlock(block: BlockNoteBlock): BlockNoteBlock {
  const next: BlockNoteBlock = { ...block };
  if (block.content) {
    if (Array.isArray(block.content)) {
      next.content = block.content.map(normalizeInline);
    } else if (isTableContent(block.content)) {
      next.content = {
        ...block.content,
        rows: block.content.rows.map((row) => ({
          cells: row.cells.map((cell) => cell.map(normalizeInline)),
        })),
      };
    }
  }
  if (block.children) {
    next.children = block.children.map(normalizeBlock);
  }
  return next;
}

function normalizeInline(item: BlockNoteInlineContent): BlockNoteInlineContent {
  if (item.type !== "link") return item;
  if (Array.isArray(item.content) && item.content.length > 0) return item;
  // Flat-link → canonical: pull `text`/`styles` into a nested StyledText.
  return {
    type: "link",
    href: item.href ?? "",
    content: [
      {
        type: "text",
        text: item.text ?? "",
        styles: item.styles ?? {},
      },
    ],
  };
}

function isTableContent(
  content: BlockNoteInlineContent[] | BlockNoteTableContent,
): content is BlockNoteTableContent {
  return !Array.isArray(content) && content.type === "tableContent";
}
