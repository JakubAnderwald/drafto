// BlockNote block types (web editor format)
export interface BlockNoteInlineContent {
  type: "text" | "link";
  text: string;
  styles?: Record<string, boolean>;
  href?: string;
  content?: BlockNoteInlineContent[];
}

export interface BlockNoteTableContent {
  type: "tableContent";
  rows: { cells: BlockNoteInlineContent[][] }[];
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
