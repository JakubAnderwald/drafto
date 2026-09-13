// BlockNote block types (web editor format)
export interface BlockNoteInlineContent {
  type: "text" | "link";
  // Required for `type: "text"`; absent on canonical `type: "link"` items
  // (those carry their text inside `content[].text` instead).
  text?: string;
  styles?: Record<string, boolean>;
  href?: string;
  content?: BlockNoteInlineContent[];
}

/**
 * Wrapped table-cell shape emitted by BlockNote v0.47+. Older content rows
 * persist a cell as `BlockNoteInlineContent[]` directly; newer content wraps
 * it in `{ type: "tableCell", content }`. Code that walks `rows[].cells[]`
 * must handle both shapes — reading `cell.content` for the wrapped form and
 * the array directly for the legacy form.
 */
export interface BlockNoteTableCell {
  type: "tableCell";
  props?: Record<string, unknown>;
  content: BlockNoteInlineContent[];
}

export type BlockNoteTableRowCell = BlockNoteInlineContent[] | BlockNoteTableCell;

export interface BlockNoteTableContent {
  type: "tableContent";
  rows: { cells: BlockNoteTableRowCell[] }[];
}

/**
 * Return the inline content carried by a table-row cell regardless of whether
 * the cell is stored in BlockNote's legacy `InlineContent[]` shape or the
 * newer wrapped `{ type: "tableCell", content }` shape.
 */
export function getTableCellInline(cell: BlockNoteTableRowCell): BlockNoteInlineContent[] {
  if (Array.isArray(cell)) return cell;
  if (cell && typeof cell === "object" && Array.isArray(cell.content)) return cell.content;
  return [];
}

export interface BlockNoteBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: BlockNoteInlineContent[] | BlockNoteTableContent;
  children?: BlockNoteBlock[];
}

// TipTap/ProseMirror document types (mobile editor format)
export interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  text?: string;
  marks?: TipTapMark[];
}

export interface TipTapDoc {
  type: "doc";
  content: TipTapNode[];
}
