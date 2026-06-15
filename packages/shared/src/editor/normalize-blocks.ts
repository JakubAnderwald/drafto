import type {
  BlockNoteBlock,
  BlockNoteInlineContent,
  BlockNoteTableContent,
  BlockNoteTableRowCell,
} from "./types";

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
          cells: row.cells.map(normalizeTableCell),
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

function normalizeTableCell(cell: BlockNoteTableRowCell): BlockNoteTableRowCell {
  // BlockNote v0.47+ wraps cells in { type: "tableCell", content }. Older
  // content keeps the raw InlineContent[] shape. Branch on shape so the
  // walker doesn't blow up calling .map on a plain object.
  if (Array.isArray(cell)) {
    return cell.map(normalizeInline);
  }
  if (cell && typeof cell === "object" && Array.isArray(cell.content)) {
    return { ...cell, content: cell.content.map(normalizeInline) };
  }
  return cell;
}
