import type {
  BlockNoteBlock,
  BlockNoteInlineContent,
  BlockNoteTableContent,
  TipTapDoc,
  TipTapMark,
  TipTapNode,
} from "./types";
import { isAttachmentUrl } from "./attachment-url";

// --- BlockNote -> TipTap ---

const STYLE_TO_MARK: Record<string, string> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strike",
  code: "code",
};

function inlineContentToTipTap(inlineContent: BlockNoteInlineContent[]): TipTapNode[] {
  const nodes: TipTapNode[] = [];

  for (const item of inlineContent) {
    const marks: TipTapMark[] = [];

    if (item.styles) {
      for (const [style, enabled] of Object.entries(item.styles)) {
        if (enabled && STYLE_TO_MARK[style]) {
          marks.push({ type: STYLE_TO_MARK[style] });
        }
      }
    }

    if (item.type === "link") {
      marks.push({ type: "link", attrs: { href: item.href ?? "" } });
      if (item.content && item.content.length > 0) {
        for (const child of item.content) {
          const childMarks = [...marks];
          if (child.styles) {
            for (const [style, enabled] of Object.entries(child.styles)) {
              if (enabled && STYLE_TO_MARK[style]) {
                childMarks.push({ type: STYLE_TO_MARK[style] });
              }
            }
          }
          const node: TipTapNode = { type: "text", text: child.text };
          if (childMarks.length > 0) node.marks = childMarks;
          nodes.push(node);
        }
      } else {
        const node: TipTapNode = { type: "text", text: item.text };
        if (marks.length > 0) node.marks = marks;
        nodes.push(node);
      }
    } else {
      const node: TipTapNode = { type: "text", text: item.text };
      if (marks.length > 0) node.marks = marks;
      nodes.push(node);
    }
  }

  return nodes;
}

function blockToTipTapNode(block: BlockNoteBlock): TipTapNode[] {
  switch (block.type) {
    case "paragraph": {
      const node: TipTapNode = { type: "paragraph" };
      if (Array.isArray(block.content) && block.content.length > 0) {
        node.content = inlineContentToTipTap(block.content);
      }
      return [node];
    }

    case "heading": {
      const level = (block.props?.level as number) ?? 1;
      const node: TipTapNode = {
        type: "heading",
        attrs: { level },
      };
      if (Array.isArray(block.content) && block.content.length > 0) {
        node.content = inlineContentToTipTap(block.content);
      }
      return [node];
    }

    case "bulletListItem": {
      const li: TipTapNode = { type: "listItem" };
      const innerParagraph: TipTapNode = { type: "paragraph" };
      if (Array.isArray(block.content) && block.content.length > 0) {
        innerParagraph.content = inlineContentToTipTap(block.content);
      }
      const liContent: TipTapNode[] = [innerParagraph];
      if (block.children && block.children.length > 0) {
        const nestedList = convertChildrenToList(block.children, "bulletList");
        if (nestedList) liContent.push(nestedList);
      }
      li.content = liContent;
      return [{ type: "bulletList", content: [li] }];
    }

    case "numberedListItem": {
      const li: TipTapNode = { type: "listItem" };
      const innerParagraph: TipTapNode = { type: "paragraph" };
      if (Array.isArray(block.content) && block.content.length > 0) {
        innerParagraph.content = inlineContentToTipTap(block.content);
      }
      const liContent: TipTapNode[] = [innerParagraph];
      if (block.children && block.children.length > 0) {
        const nestedList = convertChildrenToList(block.children, "orderedList");
        if (nestedList) liContent.push(nestedList);
      }
      li.content = liContent;
      return [{ type: "orderedList", content: [li] }];
    }

    case "checkListItem": {
      const checked = (block.props?.checked as boolean) ?? false;
      const taskItem: TipTapNode = {
        type: "taskItem",
        attrs: { checked },
      };
      const innerParagraph: TipTapNode = { type: "paragraph" };
      if (Array.isArray(block.content) && block.content.length > 0) {
        innerParagraph.content = inlineContentToTipTap(block.content);
      }
      taskItem.content = [innerParagraph];
      return [{ type: "taskList", content: [taskItem] }];
    }

    case "codeBlock": {
      const language = (block.props?.language as string) ?? "";
      const text =
        Array.isArray(block.content) && block.content.length > 0
          ? block.content.map((c) => c.text).join("")
          : "";
      const node: TipTapNode = {
        type: "codeBlock",
        attrs: { language },
      };
      if (text) {
        node.content = [{ type: "text", text }];
      }
      return [node];
    }

    case "image": {
      const src = (block.props?.url as string) ?? "";
      const attrs: Record<string, unknown> = { src };
      if (block.props?.caption) attrs.alt = block.props.caption;
      if (block.props?.width) attrs.width = block.props.width;
      return [{ type: "image", attrs }];
    }

    case "file": {
      // tentap's prebuilt WebView bundle has no `file` node, so we project
      // BlockNote file blocks as a paragraph whose only child is a linked
      // filename. The reverse converter detects this shape and restores the
      // `file` block on save, preserving round-trip fidelity.
      const href = (block.props?.url as string) ?? "";
      const name = (block.props?.name as string) ?? (block.props?.caption as string) ?? href;
      return [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: name,
              marks: [{ type: "link", attrs: { href } }],
            },
          ],
        },
      ];
    }

    case "table": {
      const tableContent = block.content as BlockNoteTableContent | undefined;
      if (!tableContent || tableContent.type !== "tableContent") {
        return [{ type: "table", content: [] }];
      }
      const rows: TipTapNode[] = tableContent.rows.map((row) => {
        const cells: TipTapNode[] = row.cells.map((cell) => ({
          type: "tableCell",
          content: [
            {
              type: "paragraph",
              content: cell.length > 0 ? inlineContentToTipTap(cell) : undefined,
            },
          ],
        }));
        return { type: "tableRow", content: cells };
      });
      return [{ type: "table", content: rows }];
    }

    default: {
      // Unknown block type: convert as paragraph to avoid data loss
      const node: TipTapNode = { type: "paragraph" };
      if (Array.isArray(block.content) && block.content.length > 0) {
        node.content = inlineContentToTipTap(block.content);
      }
      return [node];
    }
  }
}

function convertChildrenToList(children: BlockNoteBlock[], listType: string): TipTapNode | null {
  const items: TipTapNode[] = [];
  for (const child of children) {
    const li: TipTapNode = { type: "listItem" };
    const innerParagraph: TipTapNode = { type: "paragraph" };
    if (Array.isArray(child.content) && child.content.length > 0) {
      innerParagraph.content = inlineContentToTipTap(child.content);
    }
    const liContent: TipTapNode[] = [innerParagraph];
    if (child.children && child.children.length > 0) {
      const nestedList = convertChildrenToList(child.children, listType);
      if (nestedList) liContent.push(nestedList);
    }
    li.content = liContent;
    items.push(li);
  }
  if (items.length === 0) return null;
  return { type: listType, content: items };
}

/**
 * Merge adjacent list nodes of the same type into single lists.
 * BlockNote represents each list item as a separate block, but TipTap
 * expects them grouped under a single list node.
 */
function mergeAdjacentLists(nodes: TipTapNode[]): TipTapNode[] {
  const merged: TipTapNode[] = [];
  for (const node of nodes) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.type === node.type &&
      (node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList")
    ) {
      prev.content = [...(prev.content ?? []), ...(node.content ?? [])];
    } else {
      merged.push(node);
    }
  }
  return merged;
}

export function blocknoteToTiptap(blocks: BlockNoteBlock[]): TipTapDoc {
  const nodes: TipTapNode[] = [];
  for (const block of blocks) {
    nodes.push(...blockToTipTapNode(block));
  }
  return { type: "doc", content: mergeAdjacentLists(nodes) };
}

// --- TipTap -> BlockNote ---

const MARK_TO_STYLE: Record<string, string> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strike",
  code: "code",
};

function tipTapInlineToBlockNote(nodes: TipTapNode[]): BlockNoteInlineContent[] {
  const result: BlockNoteInlineContent[] = [];

  for (const node of nodes) {
    if (node.type !== "text" || !node.text) continue;

    const styles: Record<string, boolean> = {};
    let isLink = false;
    let href = "";

    if (node.marks) {
      for (const mark of node.marks) {
        if (mark.type === "link") {
          isLink = true;
          href = (mark.attrs?.href as string) ?? "";
        } else if (MARK_TO_STYLE[mark.type]) {
          styles[MARK_TO_STYLE[mark.type]] = true;
        }
      }
    }

    const hasStyles = Object.keys(styles).length > 0;

    if (isLink) {
      const item: BlockNoteInlineContent = {
        type: "link",
        text: node.text,
        href,
        content: [
          {
            type: "text",
            text: node.text,
            styles: hasStyles ? styles : {},
          },
        ],
      };
      result.push(item);
    } else {
      result.push({
        type: "text",
        text: node.text,
        styles: hasStyles ? styles : {},
      });
    }
  }

  return result;
}

function extractListItems(listNode: TipTapNode, blockType: string): BlockNoteBlock[] {
  const blocks: BlockNoteBlock[] = [];
  for (const item of listNode.content ?? []) {
    if (item.type !== "listItem" && item.type !== "taskItem") continue;

    const block: BlockNoteBlock = { type: blockType, content: [], children: [] };

    if (blockType === "checkListItem") {
      block.props = { checked: (item.attrs?.checked as boolean) ?? false };
    }

    for (const child of item.content ?? []) {
      if (child.type === "paragraph") {
        block.content = tipTapInlineToBlockNote(child.content ?? []);
      } else if (
        child.type === "bulletList" ||
        child.type === "orderedList" ||
        child.type === "taskList"
      ) {
        const nestedType =
          child.type === "bulletList"
            ? "bulletListItem"
            : child.type === "orderedList"
              ? "numberedListItem"
              : "checkListItem";
        block.children = extractListItems(child, nestedType);
      }
    }

    blocks.push(block);
  }
  return blocks;
}

function tryExtractFileBlock(node: TipTapNode): BlockNoteBlock | null {
  // A non-image attachment uploaded from mobile/desktop is stored as a
  // paragraph whose only child is a text node wearing a single `attachment://`
  // link mark. Restoring it to a BlockNote `file` block keeps the web editor's
  // native file rendering and keeps the canonical schema symmetric.
  const content = node.content;
  if (!content || content.length !== 1) return null;
  const only = content[0];
  if (only.type !== "text" || typeof only.text !== "string" || !only.text) return null;
  const marks = only.marks ?? [];
  if (marks.length !== 1) return null;
  const [mark] = marks;
  if (mark.type !== "link") return null;
  const href = mark.attrs?.href;
  if (typeof href !== "string" || !isAttachmentUrl(href)) return null;
  return {
    type: "file",
    props: { url: href, name: only.text },
    children: [],
  };
}

function tipTapNodeToBlocks(node: TipTapNode): BlockNoteBlock[] {
  switch (node.type) {
    case "paragraph": {
      const fileBlock = tryExtractFileBlock(node);
      if (fileBlock) return [fileBlock];
      return [
        {
          type: "paragraph",
          content: tipTapInlineToBlockNote(node.content ?? []),
          children: [],
        },
      ];
    }

    case "heading": {
      const level = (node.attrs?.level as number) ?? 1;
      return [
        {
          type: "heading",
          props: { level },
          content: tipTapInlineToBlockNote(node.content ?? []),
          children: [],
        },
      ];
    }

    case "bulletList": {
      return extractListItems(node, "bulletListItem");
    }

    case "orderedList": {
      return extractListItems(node, "numberedListItem");
    }

    case "taskList": {
      return extractListItems(node, "checkListItem");
    }

    case "codeBlock": {
      const language = (node.attrs?.language as string) ?? "";
      const text = (node.content ?? [])
        .filter((n) => n.type === "text")
        .map((n) => n.text ?? "")
        .join("");
      return [
        {
          type: "codeBlock",
          props: { language },
          content: text ? [{ type: "text", text, styles: {} }] : [],
          children: [],
        },
      ];
    }

    case "image": {
      const props: Record<string, unknown> = {};
      if (node.attrs?.src) props.url = node.attrs.src;
      if (node.attrs?.alt) props.caption = node.attrs.alt;
      if (node.attrs?.width) props.width = node.attrs.width;
      return [{ type: "image", props, children: [] }];
    }

    case "table": {
      const rows = (node.content ?? [])
        .filter((r) => r.type === "tableRow")
        .map((row) => ({
          cells: (row.content ?? [])
            .filter((c) => c.type === "tableCell" || c.type === "tableHeader")
            .map((cell) => {
              const para = (cell.content ?? []).find((n) => n.type === "paragraph");
              return para ? tipTapInlineToBlockNote(para.content ?? []) : [];
            }),
        }));
      const tableContent: BlockNoteTableContent = {
        type: "tableContent",
        rows,
      };
      return [{ type: "table", content: tableContent, children: [] }];
    }

    default: {
      // Unknown node: preserve text content as paragraph
      if (node.content) {
        const textNodes = node.content.filter((n) => n.type === "text");
        if (textNodes.length > 0) {
          return [
            {
              type: "paragraph",
              content: tipTapInlineToBlockNote(textNodes),
              children: [],
            },
          ];
        }
      }
      return [];
    }
  }
}

export function tiptapToBlocknote(doc: TipTapDoc): BlockNoteBlock[] {
  const blocks: BlockNoteBlock[] = [];
  for (const node of doc.content) {
    blocks.push(...tipTapNodeToBlocks(node));
  }
  return blocks;
}

// --- Smart format-detecting wrappers ---

function isTipTapDoc(value: unknown): value is TipTapDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "doc" &&
    Array.isArray((value as Record<string, unknown>).content)
  );
}

function isBlockNoteArray(value: unknown): value is BlockNoteBlock[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  const first = value[0] as Record<string, unknown>;
  return (
    typeof first === "object" &&
    first !== null &&
    typeof first.type === "string" &&
    first.type !== "doc"
  );
}

const EMPTY_DOC: TipTapDoc = { type: "doc", content: [] };

/**
 * Convert any stored content to TipTap format for the mobile editor.
 * - TipTap doc → passthrough
 * - BlockNote array → convert
 * - Anything else → empty doc
 */
export function contentToTiptap(content: unknown): TipTapDoc {
  if (isTipTapDoc(content)) return content;
  if (isBlockNoteArray(content)) return blocknoteToTiptap(content);
  return EMPTY_DOC;
}

/**
 * Convert any stored content to BlockNote format for the web editor.
 * - BlockNote array → passthrough
 * - TipTap doc → convert
 * - Anything else → empty array
 */
export function contentToBlocknote(content: unknown): BlockNoteBlock[] {
  if (isBlockNoteArray(content)) return content;
  if (isTipTapDoc(content)) return tiptapToBlocknote(content);
  return [];
}
