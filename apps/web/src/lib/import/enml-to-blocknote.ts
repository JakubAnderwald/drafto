import { parseHTML } from "linkedom";

import type { EnexTask } from "@/lib/import/types";

interface InlineContent {
  type: "text" | "link";
  text: string;
  styles?: Record<string, boolean>;
  href?: string;
}

interface Block {
  type: string;
  content?: InlineContent[] | TableContent;
  props?: Record<string, unknown>;
  children?: Block[];
}

interface TableContent {
  type: "tableContent";
  rows: { cells: InlineContent[][] }[];
}

/**
 * Convert ENML (Evernote Markup Language) to BlockNote blocks.
 * Uses linkedom for server-side DOM parsing.
 */
export function convertEnmlToBlocks(
  enml: string,
  attachmentUrlMap: Map<string, string>,
  tasks?: EnexTask[],
): Block[] {
  if (!enml.trim()) {
    return [createParagraph([])];
  }

  // Build task group map for modern Evernote task format
  const taskMap = new Map<string, EnexTask[]>();
  const orphanTasks: EnexTask[] = [];
  if (tasks) {
    for (const task of tasks) {
      if (task.groupId) {
        const group = taskMap.get(task.groupId) || [];
        group.push(task);
        taskMap.set(task.groupId, group);
      } else {
        orphanTasks.push(task);
      }
    }
    // Sort tasks within each group by sortWeight
    for (const group of taskMap.values()) {
      group.sort((a, b) => (a.sortWeight ?? "").localeCompare(b.sortWeight ?? ""));
    }
  }

  // Strip XML declaration and DOCTYPE
  const cleaned = enml
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "")
    .trim();

  const { document } = parseHTML(`<body>${cleaned}</body>`);
  const root = document.querySelector("en-note") || document.body;

  const blocks = processChildren(root, attachmentUrlMap, taskMap);

  // Append orphan tasks (tasks without a groupId) at the end
  for (const task of orphanTasks) {
    blocks.push({
      type: "checkListItem",
      props: { checked: task.checked },
      content: [{ type: "text", text: task.title, styles: {} }],
    });
  }

  return blocks.length > 0 ? blocks : [createParagraph([])];
}

function processChildren(
  parent: Element,
  attachmentUrlMap: Map<string, string>,
  taskMap: Map<string, EnexTask[]>,
): Block[] {
  const blocks: Block[] = [];

  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      // Text node
      const text = (node as Text).textContent?.trim() || "";
      if (text) {
        blocks.push(createParagraph([{ type: "text", text, styles: {} }]));
      }
    } else if (node.nodeType === 1) {
      const el = node as Element;
      const tag = el.tagName.toLowerCase();

      const converted = convertElement(el, tag, attachmentUrlMap, taskMap);
      if (converted) {
        if (Array.isArray(converted)) {
          blocks.push(...converted);
        } else {
          blocks.push(converted);
        }
      }
    }
  }

  return blocks;
}

function convertElement(
  el: Element,
  tag: string,
  attachmentUrlMap: Map<string, string>,
  taskMap: Map<string, EnexTask[]>,
): Block | Block[] | null {
  switch (tag) {
    case "div": {
      // Check for Evernote task group placeholder
      const style = el.getAttribute("style") || "";
      if (style.includes("--en-task-group:true")) {
        const idMatch = style.match(/--en-id:\s*([^;]+)/);
        const groupId = idMatch?.[1]?.trim() || "";
        const groupTasks = taskMap.get(groupId) || [];
        if (groupTasks.length > 0) {
          return groupTasks.map((task) => ({
            type: "checkListItem",
            props: { checked: task.checked },
            content: [{ type: "text", text: task.title, styles: {} }],
          }));
        }
        return null; // empty task group, skip
      }
      // Fall through to standard block handling
      const inline = extractInlineContent(el);
      if (inline.length === 0) {
        const childBlocks = processChildren(el, attachmentUrlMap, taskMap);
        return childBlocks.length > 0 ? childBlocks : null;
      }
      return createParagraph(inline);
    }

    case "p":
    case "span": {
      const inline = extractInlineContent(el);
      if (inline.length === 0) {
        const childBlocks = processChildren(el, attachmentUrlMap, taskMap);
        return childBlocks.length > 0 ? childBlocks : null;
      }
      return createParagraph(inline);
    }

    case "h1":
      return createHeading(extractInlineContent(el), 1);
    case "h2":
      return createHeading(extractInlineContent(el), 2);
    case "h3":
      return createHeading(extractInlineContent(el), 3);

    case "ul":
      return convertList(el, "bulletListItem", attachmentUrlMap, taskMap);
    case "ol":
      return convertList(el, "numberedListItem", attachmentUrlMap, taskMap);

    case "en-todo": {
      // Linkedom parses <en-todo/> as non-void, so text content is inside the element
      const checked = el.getAttribute("checked") === "true";
      const content = extractInlineContent(el);
      return {
        type: "checkListItem",
        props: { checked },
        content: content.length > 0 ? content : [{ type: "text", text: "", styles: {} }],
      };
    }

    case "en-media":
      return convertEnMedia(el, attachmentUrlMap);

    case "table": {
      const unwrapped = tryUnwrapLayoutTable(el, attachmentUrlMap, taskMap);
      if (unwrapped !== null) return unwrapped;
      return convertTable(el);
    }

    case "br":
      return null;

    case "hr":
      return createParagraph([{ type: "text", text: "---", styles: {} }]);

    case "blockquote": {
      const inline = extractInlineContent(el);
      return createParagraph(inline);
    }

    default: {
      // For unknown elements, try to extract inline content
      const inline = extractInlineContent(el);
      if (inline.length > 0) {
        return createParagraph(inline);
      }
      return processChildren(el, attachmentUrlMap, taskMap);
    }
  }
}

function convertList(
  listEl: Element,
  blockType: string,
  attachmentUrlMap: Map<string, string>,
  taskMap: Map<string, EnexTask[]>,
): Block[] {
  const items: Block[] = [];

  for (const child of Array.from(listEl.children)) {
    if (child.tagName.toLowerCase() === "li") {
      const inline = extractListItemContent(child);
      const nestedBlocks = processNestedLists(child, attachmentUrlMap, taskMap);

      items.push({
        type: blockType,
        content: inline.length > 0 ? inline : [{ type: "text", text: "", styles: {} }],
        children: nestedBlocks.length > 0 ? nestedBlocks : undefined,
      });
    }
  }

  return items;
}

function processNestedLists(
  li: Element,
  attachmentUrlMap: Map<string, string>,
  taskMap: Map<string, EnexTask[]>,
): Block[] {
  const nested: Block[] = [];
  for (const child of Array.from(li.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      const type = tag === "ul" ? "bulletListItem" : "numberedListItem";
      nested.push(...convertList(child, type, attachmentUrlMap, taskMap));
    }
  }
  return nested;
}

/**
 * Extract inline content from a list item element.
 * Unlike extractInlineContent, this treats <div> children as inline containers
 * because Evernote wraps list item text in <div> tags: <li><div>text</div></li>
 */
function extractListItemContent(li: Element): InlineContent[] {
  const result: InlineContent[] = [];

  for (const node of Array.from(li.childNodes)) {
    if (node.nodeType === 3) {
      const text = (node as Text).textContent || "";
      if (text) {
        result.push({ type: "text", text, styles: {} });
      }
    } else if (node.nodeType === 1) {
      const childEl = node as Element;
      const tag = childEl.tagName.toLowerCase();

      if (tag === "div") {
        // Evernote wraps li text in <div> — extract inline content from within
        result.push(...extractInlineContent(childEl));
      } else if (["ul", "ol", "table", "en-media"].includes(tag)) {
        continue; // handled by processNestedLists
      } else {
        const styles = getInlineStyles(childEl);
        if (tag === "a") {
          const href = childEl.getAttribute("href") || "";
          const text = childEl.textContent || "";
          result.push({ type: "link", text, href, styles });
        } else if (tag === "br") {
          result.push({ type: "text", text: "\n", styles: {} });
        } else {
          const innerContent = extractInlineContent(childEl);
          for (const item of innerContent) {
            result.push({ ...item, styles: { ...item.styles, ...styles } });
          }
        }
      }
    }
  }

  return result;
}

function convertEnMedia(el: Element, attachmentUrlMap: Map<string, string>): Block | null {
  const hash = el.getAttribute("hash") || "";
  const type = el.getAttribute("type") || "";
  const url = attachmentUrlMap.get(hash);

  if (!url) {
    return createParagraph([
      { type: "text", text: `[Attachment: ${type || "unknown"}]`, styles: {} },
    ]);
  }

  if (type.startsWith("image/")) {
    return {
      type: "image",
      props: {
        url,
        caption: "",
        width: parseInt(el.getAttribute("width") || "0", 10) || undefined,
      },
    };
  }

  // Non-image attachment — render as text link
  return createParagraph([
    {
      type: "link",
      text: `[Attachment: ${type}]`,
      href: url,
      styles: {},
    },
  ]);
}

function convertTable(tableEl: Element): Block {
  const rows: { cells: InlineContent[][] }[] = [];

  const trElements = tableEl.querySelectorAll("tr");
  for (const tr of trElements) {
    const cells: InlineContent[][] = [];
    const cellElements = tr.querySelectorAll("td, th");
    for (const cell of cellElements) {
      cells.push(extractCellInlineContent(cell));
    }
    if (cells.length > 0) {
      rows.push({ cells });
    }
  }

  return {
    type: "table",
    content: { type: "tableContent", rows },
  };
}

const BLOCK_TAGS = new Set([
  "ul",
  "ol",
  "div",
  "p",
  "table",
  "en-media",
  "en-todo",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "hr",
]);

/**
 * Detect tables used purely for layout (Evernote often wraps a column of
 * lists in a single-column table). When detected, unwrap each cell's
 * children into top-level blocks so lists/divs render naturally instead of
 * being lost inside cells (BlockNote table cells only allow inline content).
 *
 * Heuristic: no <th>, every <tr> has at most one <td>, and every non-empty
 * cell contains only block-level children (no meaningful inline text).
 * Returns null when the table doesn't match — caller falls back to a real table.
 */
function tryUnwrapLayoutTable(
  tableEl: Element,
  attachmentUrlMap: Map<string, string>,
  taskMap: Map<string, EnexTask[]>,
): Block[] | null {
  if (tableEl.querySelector("th")) return null;

  const rows = tableEl.querySelectorAll("tr");
  if (rows.length === 0) return null;

  const cells: Element[] = [];
  for (const tr of rows) {
    const tds = tr.querySelectorAll("td");
    if (tds.length > 1) return null;
    if (tds.length === 1) cells.push(tds[0]);
  }

  for (const cell of cells) {
    if (!isBlockOnlyCell(cell)) return null;
  }

  const blocks: Block[] = [];
  for (const cell of cells) {
    blocks.push(...processChildren(cell, attachmentUrlMap, taskMap));
  }
  return blocks;
}

function isBlockOnlyCell(cell: Element): boolean {
  for (const node of Array.from(cell.childNodes)) {
    if (node.nodeType === 3) {
      // Inline text in a cell disqualifies it from layout-table treatment.
      if ((node as Text).textContent?.trim()) return false;
    } else if (node.nodeType === 1) {
      const tag = (node as Element).tagName.toLowerCase();
      // <br> alone (e.g. <div><br/></div>) is fine; any other inline tag means
      // the cell mixes inline content and shouldn't be unwrapped.
      if (tag === "br") continue;
      if (!BLOCK_TAGS.has(tag)) return false;
    }
  }
  return true;
}

/**
 * Extract inline content from a table cell. Unlike extractInlineContent,
 * this recurses into block-level children (divs, paragraphs, lists) so their
 * text isn't silently dropped. Lists are flattened with bullet/number prefixes
 * and newline separators.
 */
function extractCellInlineContent(cell: Element): InlineContent[] {
  const parts: InlineContent[][] = [];

  for (const node of Array.from(cell.childNodes)) {
    if (node.nodeType === 3) {
      const text = (node as Text).textContent || "";
      if (text.trim()) parts.push([{ type: "text", text, styles: {} }]);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const childEl = node as Element;
    const tag = childEl.tagName.toLowerCase();

    if (tag === "ul" || tag === "ol") {
      const ordered = tag === "ol";
      let n = 0;
      for (const li of Array.from(childEl.children)) {
        if (li.tagName.toLowerCase() !== "li") continue;
        n += 1;
        const prefix = ordered ? `${n}. ` : "• ";
        const inner = extractCellInlineContent(li);
        if (inner.length === 0) {
          parts.push([{ type: "text", text: prefix, styles: {} }]);
        } else {
          parts.push([{ type: "text", text: prefix, styles: {} }, ...inner]);
        }
      }
    } else if (tag === "div" || tag === "p" || tag === "blockquote") {
      const inner = extractCellInlineContent(childEl);
      if (inner.length > 0) parts.push(inner);
    } else if (tag === "table" || tag === "en-media") {
      // Genuinely unrepresentable as inline; skip.
      continue;
    } else if (tag === "br") {
      parts.push([{ type: "text", text: "\n", styles: {} }]);
    } else {
      // Inline tag — apply the same logic extractInlineContent uses per element.
      const styles = getInlineStyles(childEl);
      if (tag === "a") {
        parts.push([
          {
            type: "link",
            text: childEl.textContent || "",
            href: childEl.getAttribute("href") || "",
            styles,
          },
        ]);
      } else {
        const inner = extractInlineContent(childEl);
        if (inner.length > 0) {
          parts.push(inner.map((item) => ({ ...item, styles: { ...item.styles, ...styles } })));
        }
      }
    }
  }

  if (parts.length === 0) return [];

  const result: InlineContent[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) result.push({ type: "text", text: "\n", styles: {} });
    result.push(...parts[i]);
  }
  return result;
}

function extractInlineContent(el: Element): InlineContent[] {
  const result: InlineContent[] = [];

  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      // Text node
      const text = (node as Text).textContent || "";
      if (text) {
        result.push({ type: "text", text, styles: {} });
      }
    } else if (node.nodeType === 1) {
      const childEl = node as Element;
      const tag = childEl.tagName.toLowerCase();

      // Skip block-level elements and en-todo in inline extraction
      if (["ul", "ol", "div", "table", "en-media", "en-todo"].includes(tag)) {
        continue;
      }

      const styles = getInlineStyles(childEl);
      const innerContent = extractInlineContent(childEl);

      if (tag === "a") {
        const href = childEl.getAttribute("href") || "";
        const text = childEl.textContent || "";
        result.push({ type: "link", text, href, styles });
      } else if (tag === "br") {
        result.push({ type: "text", text: "\n", styles: {} });
      } else {
        // Merge styles into inner content
        for (const item of innerContent) {
          result.push({
            ...item,
            styles: { ...item.styles, ...styles },
          });
        }
      }
    }
  }

  return result;
}

function getInlineStyles(el: Element): Record<string, boolean> {
  const tag = el.tagName.toLowerCase();
  const styles: Record<string, boolean> = {};

  if (tag === "b" || tag === "strong") styles.bold = true;
  if (tag === "i" || tag === "em") styles.italic = true;
  if (tag === "u") styles.underline = true;
  if (tag === "s" || tag === "strike" || tag === "del") styles.strike = true;
  if (tag === "code") styles.code = true;

  return styles;
}

function createParagraph(content: InlineContent[]): Block {
  return { type: "paragraph", content };
}

function createHeading(content: InlineContent[], level: number): Block {
  return {
    type: "heading",
    props: { level },
    content,
  };
}
