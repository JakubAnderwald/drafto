import type { BlockNoteBlock, BlockNoteInlineContent, BlockNoteTableContent } from "./types";

// --- BlockNote -> Markdown ---

function inlineContentToMarkdown(inlineContent: BlockNoteInlineContent[]): string {
  return inlineContent.map(inlineItemToMarkdown).join("");
}

function inlineItemToMarkdown(item: BlockNoteInlineContent): string {
  let text =
    item.type === "link" && item.content?.length
      ? item.content.map(inlineItemToMarkdown).join("")
      : item.text;

  if (item.styles) {
    if (item.styles.code) text = `\`${text}\``;
    if (item.styles.bold) text = `**${text}**`;
    if (item.styles.italic) text = `*${text}*`;
    if (item.styles.strike) text = `~~${text}~~`;
    // underline has no standard Markdown — skip
  }

  if (item.type === "link" && item.href) {
    text = `[${text}](${item.href})`;
  }

  return text;
}

function blockToMarkdown(block: BlockNoteBlock, indent: number): string {
  const prefix = "  ".repeat(indent);
  const lines: string[] = [];

  switch (block.type) {
    case "heading": {
      const level = (block.props?.level as number) ?? 1;
      const hashes = "#".repeat(Math.min(level, 6));
      const text = Array.isArray(block.content) ? inlineContentToMarkdown(block.content) : "";
      lines.push(`${prefix}${hashes} ${text}`);
      break;
    }

    case "paragraph": {
      const text = Array.isArray(block.content) ? inlineContentToMarkdown(block.content) : "";
      lines.push(`${prefix}${text}`);
      break;
    }

    case "bulletListItem": {
      const text = Array.isArray(block.content) ? inlineContentToMarkdown(block.content) : "";
      lines.push(`${prefix}- ${text}`);
      break;
    }

    case "numberedListItem": {
      const text = Array.isArray(block.content) ? inlineContentToMarkdown(block.content) : "";
      lines.push(`${prefix}1. ${text}`);
      break;
    }

    case "checkListItem": {
      const checked = (block.props?.checked as boolean) ?? false;
      const text = Array.isArray(block.content) ? inlineContentToMarkdown(block.content) : "";
      lines.push(`${prefix}- [${checked ? "x" : " "}] ${text}`);
      break;
    }

    case "codeBlock": {
      const language = (block.props?.language as string) ?? "";
      const text =
        Array.isArray(block.content) && block.content.length > 0
          ? block.content.map((c) => c.text).join("")
          : "";
      lines.push(`${prefix}\`\`\`${language}`);
      lines.push(text);
      lines.push(`${prefix}\`\`\``);
      break;
    }

    case "image": {
      const url = (block.props?.url as string) ?? "";
      const caption = (block.props?.caption as string) ?? "";
      lines.push(`${prefix}![${caption}](${url})`);
      break;
    }

    case "file": {
      const url = (block.props?.url as string) ?? "";
      // `||` so an explicit empty-string name falls through to caption/url;
      // `??` would emit `[](url)` and produce invisible link text.
      const name = (block.props?.name as string) || (block.props?.caption as string) || url;
      lines.push(`${prefix}[${name}](${url})`);
      break;
    }

    case "table": {
      const tableContent = block.content as BlockNoteTableContent | undefined;
      if (tableContent?.type === "tableContent" && tableContent.rows.length > 0) {
        for (let i = 0; i < tableContent.rows.length; i++) {
          const row = tableContent.rows[i];
          const cells = row.cells.map((cell) => inlineContentToMarkdown(cell));
          lines.push(`${prefix}| ${cells.join(" | ")} |`);
          if (i === 0) {
            lines.push(`${prefix}| ${cells.map(() => "---").join(" | ")} |`);
          }
        }
      }
      break;
    }

    default: {
      // Unknown block type: render as paragraph to avoid data loss
      const text = Array.isArray(block.content) ? inlineContentToMarkdown(block.content) : "";
      if (text) lines.push(`${prefix}${text}`);
      break;
    }
  }

  // Render nested children with increased indent
  if (block.children && block.children.length > 0) {
    for (const child of block.children) {
      lines.push(blockToMarkdown(child, indent + 1));
    }
  }

  return lines.join("\n");
}

/**
 * Convert BlockNote blocks to Markdown text.
 */
export function blockNoteToMarkdown(blocks: BlockNoteBlock[]): string {
  return blocks.map((block) => blockToMarkdown(block, 0)).join("\n\n");
}

// --- Markdown -> BlockNote ---

interface ParsedLine {
  indent: number;
  content: string;
}

function parseLine(line: string): ParsedLine {
  const match = line.match(/^(\s*)(.*)/);
  const raw = match?.[1] ?? "";
  // Normalize indent: 2 spaces or 1 tab = 1 level
  const indent = Math.floor(raw.replace(/\t/g, "  ").length / 2);
  return { indent, content: match?.[2] ?? "" };
}

function parseInlineMarkdown(text: string): BlockNoteInlineContent[] {
  const result: BlockNoteInlineContent[] = [];
  // Regex to match markdown inline patterns: links, bold, italic, code, strikethrough
  const regex =
    /(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(\~\~(.+?)\~\~)|([^[`*~]+|[[\`*~])/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match[1]) {
      // Link: [text](url)
      const linkText = match[2];
      const href = match[3];
      result.push({
        type: "link",
        text: linkText,
        href,
        content: [{ type: "text", text: linkText, styles: {} }],
      });
    } else if (match[4]) {
      // Inline code: `code`
      result.push({ type: "text", text: match[5], styles: { code: true } });
    } else if (match[6]) {
      // Bold: **text**
      result.push({ type: "text", text: match[7], styles: { bold: true } });
    } else if (match[8]) {
      // Italic: *text*
      result.push({ type: "text", text: match[9], styles: { italic: true } });
    } else if (match[10]) {
      // Strikethrough: ~~text~~
      result.push({ type: "text", text: match[11], styles: { strike: true } });
    } else if (match[12]) {
      // Plain text
      const plain = match[12];
      if (plain) {
        result.push({ type: "text", text: plain, styles: {} });
      }
    }
  }

  if (result.length === 0 && text) {
    result.push({ type: "text", text, styles: {} });
  }

  return result;
}

/**
 * Convert Markdown text to BlockNote blocks.
 * Supports headings, paragraphs, bullet/numbered/check lists, code blocks, images, and inline styles.
 */
export function markdownToBlockNote(markdown: string): BlockNoteBlock[] {
  const lines = markdown.split("\n");
  const blocks: BlockNoteBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    const codeMatch = line.match(/^```(\w*)/);
    if (codeMatch) {
      const language = codeMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const text = codeLines.join("\n");
      blocks.push({
        type: "codeBlock",
        props: { language },
        content: text ? [{ type: "text", text, styles: {} }] : [],
        children: [],
      });
      continue;
    }

    const { content } = parseLine(line);

    // Heading
    const headingMatch = content.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        props: { level: headingMatch[1].length },
        content: parseInlineMarkdown(headingMatch[2]),
        children: [],
      });
      i++;
      continue;
    }

    // Image
    const imageMatch = content.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imageMatch) {
      const props: Record<string, unknown> = { url: imageMatch[2] };
      if (imageMatch[1]) props.caption = imageMatch[1];
      blocks.push({ type: "image", props, children: [] });
      i++;
      continue;
    }

    // Standalone attachment file link: [name](attachment://...)
    // The forward direction (blockToMarkdown) emits file blocks in this exact
    // shape, so reading it back without restoring the file block would silently
    // downgrade it to a paragraph and break web's native attachment rendering.
    const fileMatch = content.match(/^\[([^\]]*)\]\((attachment:\/\/[^)]+)\)\s*$/);
    if (fileMatch) {
      blocks.push({
        type: "file",
        props: { url: fileMatch[2], name: fileMatch[1] },
        children: [],
      });
      i++;
      continue;
    }

    // Check list item
    const checkMatch = content.match(/^-\s+\[([ xX])\]\s+(.*)/);
    if (checkMatch) {
      blocks.push({
        type: "checkListItem",
        props: { checked: checkMatch[1] !== " " },
        content: parseInlineMarkdown(checkMatch[2]),
        children: [],
      });
      i++;
      continue;
    }

    // Bullet list item
    const bulletMatch = content.match(/^[-*+]\s+(.*)/);
    if (bulletMatch) {
      blocks.push({
        type: "bulletListItem",
        content: parseInlineMarkdown(bulletMatch[1]),
        children: [],
      });
      i++;
      continue;
    }

    // Numbered list item
    const numberedMatch = content.match(/^\d+\.\s+(.*)/);
    if (numberedMatch) {
      blocks.push({
        type: "numberedListItem",
        content: parseInlineMarkdown(numberedMatch[1]),
        children: [],
      });
      i++;
      continue;
    }

    // Table (starts with |)
    if (content.startsWith("|")) {
      const tableRows: BlockNoteInlineContent[][][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const rowText = lines[i].trim();
        // Skip separator rows (| --- | --- |)
        if (rowText.match(/^\|[\s\-:|]+\|$/)) {
          i++;
          continue;
        }
        const cells = rowText
          .split("|")
          .slice(1, -1) // Remove empty first/last from leading/trailing |
          .map((cell) => parseInlineMarkdown(cell.trim()));
        tableRows.push(cells);
        i++;
      }
      if (tableRows.length > 0) {
        const tableContent: BlockNoteTableContent = {
          type: "tableContent",
          rows: tableRows.map((cells) => ({ cells })),
        };
        blocks.push({ type: "table", content: tableContent, children: [] });
      }
      continue;
    }

    // Default: paragraph
    blocks.push({
      type: "paragraph",
      content: parseInlineMarkdown(content),
      children: [],
    });
    i++;
  }

  return blocks;
}
