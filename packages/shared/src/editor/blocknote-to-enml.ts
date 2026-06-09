import type { BlockNoteBlock, BlockNoteInlineContent, BlockNoteTableContent } from "./types";

export interface EnmlMediaEntry {
  hash: string;
  mime: string;
}

/**
 * Mapping from a block's `props.url` (e.g. `attachment://<path>` or a signed URL)
 * to the resource hash + MIME that should be referenced in the emitted ENML.
 * Resources not present in this map fall back to a textual `[Attachment]`
 * placeholder so the note still round-trips into Evernote without a dangling
 * `<en-media>` reference.
 */
export type MediaIndex = Map<string, EnmlMediaEntry>;

const HEADING_TAGS: Record<number, string> = {
  1: "h1",
  2: "h2",
  3: "h3",
};

export function blocksToEnml(blocks: BlockNoteBlock[], mediaIndex: MediaIndex): string {
  return `<en-note>${renderBlockSequence(blocks, mediaIndex)}</en-note>`;
}

function renderBlockSequence(blocks: BlockNoteBlock[], mediaIndex: MediaIndex): string {
  let out = "";
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "bulletListItem" || block.type === "numberedListItem") {
      const tag = block.type === "bulletListItem" ? "ul" : "ol";
      const items: string[] = [];
      while (i < blocks.length && blocks[i].type === block.type) {
        items.push(renderListItem(blocks[i], mediaIndex));
        i += 1;
      }
      out += `<${tag}>${items.join("")}</${tag}>`;
      continue;
    }
    out += blockToEnml(block, mediaIndex);
    i += 1;
  }
  return out;
}

function renderListItem(block: BlockNoteBlock, mediaIndex: MediaIndex): string {
  const inner = renderInline(block.content) || "&#xA0;";
  const nested = renderChildren(block.children, mediaIndex);
  return `<li>${inner}${nested}</li>`;
}

function blockToEnml(block: BlockNoteBlock, mediaIndex: MediaIndex): string {
  switch (block.type) {
    case "heading": {
      const level = clampHeadingLevel(block.props?.level);
      const tag = HEADING_TAGS[level];
      return `<${tag}>${renderInline(block.content)}</${tag}>${renderChildren(block.children, mediaIndex)}`;
    }

    case "paragraph": {
      return `<div>${renderInline(block.content) || "<br/>"}</div>${renderChildren(block.children, mediaIndex)}`;
    }

    case "bulletListItem":
    case "numberedListItem": {
      // A list item reached blockToEnml only via nested-children traversal that
      // bypassed the run grouper — render it in its own one-item list as a
      // defensive fallback. Top-level sequences flow through renderBlockSequence.
      const tag = block.type === "bulletListItem" ? "ul" : "ol";
      return `<${tag}>${renderListItem(block, mediaIndex)}</${tag}>`;
    }

    case "checkListItem": {
      const checked = block.props?.checked === true;
      return `<div><en-todo checked="${checked}"/>${renderInline(block.content)}</div>${renderChildren(block.children, mediaIndex)}`;
    }

    case "codeBlock": {
      const text = collectPlainText(block.content);
      return `<pre><code>${escapeXml(text)}</code></pre>`;
    }

    case "image":
    case "file":
    case "video":
    case "audio":
      return renderMedia(block, mediaIndex);

    case "table":
      return renderTable(block, mediaIndex);

    default: {
      // Unknown block — preserve any inline content as a div so we don't drop data.
      const inline = renderInline(block.content);
      if (inline) {
        return `<div>${inline}</div>${renderChildren(block.children, mediaIndex)}`;
      }
      return renderChildren(block.children, mediaIndex);
    }
  }
}

function renderChildren(children: BlockNoteBlock[] | undefined, mediaIndex: MediaIndex): string {
  if (!children || children.length === 0) return "";
  return renderBlockSequence(children, mediaIndex);
}

function renderMedia(block: BlockNoteBlock, mediaIndex: MediaIndex): string {
  const url = typeof block.props?.url === "string" ? block.props.url : "";
  const caption = typeof block.props?.caption === "string" ? block.props.caption : "";
  const name = typeof block.props?.name === "string" ? block.props.name : "";

  const entry = url ? mediaIndex.get(url) : undefined;
  if (entry) {
    const widthAttr =
      typeof block.props?.width === "number" && block.props.width > 0
        ? ` width="${block.props.width}"`
        : "";
    return `<div><en-media type="${escapeAttr(entry.mime)}" hash="${escapeAttr(entry.hash)}"${widthAttr}/></div>`;
  }

  // No matching attachment — fall back to a visible link / placeholder so the
  // note still imports cleanly without referencing an unknown resource.
  const label = caption || name || url || "Attachment";
  if (url) {
    return `<div><a href="${escapeAttr(url)}">${escapeXml(label)}</a></div>`;
  }
  return `<div>${escapeXml(`[${label}]`)}</div>`;
}

function renderTable(block: BlockNoteBlock, mediaIndex: MediaIndex): string {
  const tableContent = block.content as BlockNoteTableContent | undefined;
  if (!tableContent || tableContent.type !== "tableContent" || tableContent.rows.length === 0) {
    return "";
  }
  const rows = tableContent.rows
    .map((row) => {
      const cells = row.cells.map((cell) => `<td>${renderInline(cell) || "&#xA0;"}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table>${rows}</table>${renderChildren(block.children, mediaIndex)}`;
}

function renderInline(
  content: BlockNoteBlock["content"] | BlockNoteInlineContent[] | undefined,
): string {
  if (!Array.isArray(content)) return "";
  return content.map(renderInlineItem).join("");
}

function renderInlineItem(item: BlockNoteInlineContent): string {
  if (item.type === "link") {
    const href = typeof item.href === "string" ? item.href : "";
    const inner = item.content?.length
      ? item.content.map(renderInlineItem).join("")
      : escapeXml(item.text ?? "");
    return `<a href="${escapeAttr(href)}">${inner}</a>`;
  }

  const text = escapeXml(item.text ?? "");
  return wrapStyles(text, item.styles);
}

function wrapStyles(text: string, styles: Record<string, boolean> | undefined): string {
  if (!styles) return text;
  let out = text;
  if (styles.code) out = `<code>${out}</code>`;
  if (styles.bold) out = `<b>${out}</b>`;
  if (styles.italic) out = `<i>${out}</i>`;
  if (styles.underline) out = `<u>${out}</u>`;
  if (styles.strike) out = `<s>${out}</s>`;
  return out;
}

function collectPlainText(
  content: BlockNoteBlock["content"] | BlockNoteInlineContent[] | undefined,
): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const item of content) {
    if (item.type === "link" && item.content) {
      text += collectPlainText(item.content);
    } else {
      text += item.text ?? "";
    }
  }
  return text;
}

function clampHeadingLevel(level: unknown): 1 | 2 | 3 {
  if (level === 1 || level === 2 || level === 3) return level;
  if (typeof level === "number" && level >= 4) return 3;
  return 1;
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(value: string): string {
  return escapeXml(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
