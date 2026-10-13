import {
  getTableCellInline,
  type BlockNoteBlock,
  type BlockNoteInlineContent,
  type BlockNoteTableContent,
  type BlockNoteTableRowCell,
} from "./types";

// --- Escaping (shared by both directions so they can't drift apart) ---

// CommonMark: a backslash before ASCII punctuation is an escape; before
// anything else it is a literal backslash.
const ASCII_PUNCTUATION = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

function isPunctuation(ch: string | undefined): boolean {
  return ch !== undefined && ASCII_PUNCTUATION.has(ch);
}

/**
 * Backslash-escape every character `shouldEscape` selects. A backslash is
 * escaped only where the parser would otherwise read it as an escape: before
 * punctuation, or at the end, where the next node's syntax follows it.
 */
function escapeMarkdown(text: string, shouldEscape: (ch: string, i: number) => boolean): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const escape =
      ch === "\\" ? i === text.length - 1 || isPunctuation(text[i + 1]) : shouldEscape(ch, i);
    out += escape ? `\\${ch}` : ch;
  }
  return out;
}

function unescapeMarkdown(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && isPunctuation(text[i + 1])) {
      out += text[i + 1];
      i++;
    } else {
      out += text[i];
    }
  }
  return out;
}

// Plain text: escape exactly the characters parseInlineMarkdown treats as syntax.
function escapeInlineText(text: string): string {
  return escapeMarkdown(text, (ch, i) => {
    if (ch === "~") {
      // Only `~~` is strikethrough. A `~` at either edge could pair with a
      // neighbouring node's delimiter, so those are escaped too.
      return i === 0 || i === text.length - 1 || text[i - 1] === "~" || text[i + 1] === "~";
    }
    return ch === "*" || ch === "`" || ch === "[" || ch === "]";
  });
}

// Image captions and file names: the brackets around them are syntax, and a
// backtick would open a code span that hides the closing `]`.
function escapeLinkLabel(text: string): string {
  return escapeMarkdown(text, (ch) => ch === "[" || ch === "]" || ch === "`");
}

/**
 * Link / image / attachment destination. Anything that would end a bare
 * destination early (parentheses, whitespace) is wrapped in `<...>`, and so
 * is an empty one (an image block before its upload finishes), since a bare
 * `()` is not read as a destination.
 */
function formatDestination(href: string): string {
  if (!href || /[\s()<>]/.test(href)) {
    return `<${escapeMarkdown(href, (ch) => ch === "<" || ch === ">")}>`;
  }
  return escapeMarkdown(href, () => false);
}

/**
 * Plain text at the start of a paragraph line that the block parser would
 * otherwise read as a heading, list item, table row or image (a `!` that
 * ends the text right before a link). Leading whitespace is dropped first:
 * parseLine strips it as indent either way, and kept, two spaces or a tab
 * would nest the paragraph under the block before it.
 */
function escapeLineStart(markdown: string): string {
  return markdown
    .replace(/^\s+/, "")
    .replace(/^(?=(?:#{1,6}|[-+])\s|\||!\[)/, "\\")
    .replace(/^(\d+)\.(?=\s)/, "$1\\.");
}

// A fence one backtick longer than any run inside the code, so no code line can close it.
function codeFence(code: string): string {
  // reduce, not Math.max(...runs): a large block can have more runs than a call takes arguments.
  const longestRun = (code.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

// --- BlockNote -> Markdown ---

function inlineContentToMarkdown(inlineContent: BlockNoteInlineContent[]): string {
  return inlineContent.map(inlineItemToMarkdown).join("");
}

function inlineItemToMarkdown(item: BlockNoteInlineContent): string {
  let text: string;
  // Whitespace at the edges of a styled node, emitted outside its delimiters.
  let leading = "";
  let trailing = "";
  if (item.type === "link" && item.content?.length) {
    text = item.content.map(inlineItemToMarkdown).join("");
  } else {
    let raw = item.text ?? "";
    if (item.styles?.code) {
      // Code spans are literal (escapes inside them are not processed) and keep their spaces.
      text = raw;
    } else {
      if (item.styles?.bold || item.styles?.italic || item.styles?.strike) {
        // `* x*` is not emphasis, and at the start of a line it reads as a
        // bullet, so a delimiter must touch the text it wraps.
        const trimmed = raw.trim();
        leading = raw.slice(0, raw.length - raw.trimStart().length);
        trailing = raw.slice(leading.length + trimmed.length);
        raw = trimmed;
      }
      text = escapeInlineText(raw);
    }
    // An empty styled node would emit bare delimiters (`****`) that re-parse as text.
    if (!raw && item.type !== "link") return leading + trailing;
  }

  if (item.styles) {
    if (item.styles.code) text = `\`${text}\``;
    if (item.styles.bold) text = `**${text}**`;
    if (item.styles.italic) text = `*${text}*`;
    if (item.styles.strike) text = `~~${text}~~`;
    // underline has no standard Markdown — skip
  }

  if (item.type === "link" && item.href) {
    text = `[${text}](${formatDestination(item.href)})`;
  }

  return leading + text + trailing;
}

// GFM: a `|` inside a cell is escaped, code spans included; the parser
// strips that escape before reading the cell's inline Markdown.
function tableCellToMarkdown(cell: BlockNoteTableRowCell): string {
  return inlineContentToMarkdown(getTableCellInline(cell)).replace(/\|/g, "\\|");
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
      lines.push(`${prefix}${escapeLineStart(text)}`);
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
      const fence = codeFence(text);
      lines.push(`${prefix}${fence}${language}`);
      lines.push(text);
      lines.push(`${prefix}${fence}`);
      break;
    }

    case "image": {
      const url = (block.props?.url as string) ?? "";
      const caption = (block.props?.caption as string) ?? "";
      lines.push(`${prefix}![${escapeLinkLabel(caption)}](${formatDestination(url)})`);
      break;
    }

    case "file": {
      const url = (block.props?.url as string) ?? "";
      // `||` so an explicit empty-string name falls through to caption/url;
      // `??` would emit `[](url)` and produce invisible link text.
      const name = (block.props?.name as string) || (block.props?.caption as string) || url;
      lines.push(`${prefix}[${escapeLinkLabel(name)}](${formatDestination(url)})`);
      break;
    }

    case "table": {
      const tableContent = block.content as BlockNoteTableContent | undefined;
      if (tableContent?.type === "tableContent" && tableContent.rows.length > 0) {
        for (let i = 0; i < tableContent.rows.length; i++) {
          const row = tableContent.rows[i];
          // BlockNote cells may be raw InlineContent[] (legacy) or wrapped
          // { type: "tableCell", content } (v0.47+); normalise via the helper.
          const cells = row.cells.map(tableCellToMarkdown);
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
      if (text) lines.push(`${prefix}${escapeLineStart(text)}`);
      break;
    }
  }

  // Render nested children with increased indent
  if (block.children && block.children.length > 0) {
    block.children.forEach((child, i) => {
      // Siblings are joined without a blank line, so two tables in a row
      // would read back as one table.
      if (child.type === "table" && block.children?.[i - 1]?.type === "table") lines.push("");
      lines.push(blockToMarkdown(child, indent + 1));
    });
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

type Styles = Record<string, boolean>;

// Longest first, so `***both***` is one bold+italic span rather than `**`
// plus stray `*` text.
const DELIMITERS = ["***", "**", "*", "~~"] as const;
type Delimiter = (typeof DELIMITERS)[number];

const DELIMITER_STYLES: Record<Delimiter, Styles> = {
  "***": { bold: true, italic: true },
  "**": { bold: true },
  "*": { italic: true },
  "~~": { strike: true },
};

// Index of the backtick closing a code span opened at `start`, or -1.
function findCodeSpanEnd(text: string, start: number): number {
  const end = text.indexOf("`", start + 1);
  return end > start + 1 ? end : -1;
}

/**
 * First unescaped `delimiter` after at least one character of content,
 * skipping code spans so a delimiter inside `code` never closes the span.
 */
function findClosingDelimiter(text: string, delimiter: string, contentStart: number): number {
  for (let i = contentStart; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "`") {
      const end = findCodeSpanEnd(text, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (i > contentStart && text.startsWith(delimiter, i)) return i;
  }
  return -1;
}

interface DelimitedSpan {
  delimiter: Delimiter;
  inner: string;
  end: number;
}

function parseDelimitedAt(text: string, start: number): DelimitedSpan | null {
  for (const delimiter of DELIMITERS) {
    if (!text.startsWith(delimiter, start)) continue;
    const contentStart = start + delimiter.length;
    const close = findClosingDelimiter(text, delimiter, contentStart);
    if (close !== -1) {
      return { delimiter, inner: text.slice(contentStart, close), end: close + delimiter.length };
    }
  }
  return null;
}

// Index of the `]` closing a link label that starts at `from`, or -1.
function findLabelEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "`") {
      const end = findCodeSpanEnd(text, i);
      if (end !== -1) i = end;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/**
 * Destination starting just after `(`: either `<...>` or a bare run with
 * balanced parentheses. Returns the unescaped href and the index after `)`.
 */
function parseDestination(text: string, from: number): { href: string; end: number } | null {
  if (text[from] === "<") {
    for (let i = from + 1; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\") {
        i++;
      } else if (ch === "<" || ch === "\n") {
        return null;
      } else if (ch === ">") {
        if (text[i + 1] !== ")") return null;
        return { href: unescapeMarkdown(text.slice(from + 1, i)), end: i + 2 };
      }
    }
    return null;
  }

  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      if (depth > 0) {
        depth--;
      } else {
        if (i === from) return null;
        return { href: unescapeMarkdown(text.slice(from, i)), end: i + 1 };
      }
    }
  }
  return null;
}

interface LinkMatch {
  label: string;
  href: string;
  end: number;
}

// `[label](destination)` starting at `start`; `label` is still escaped.
function parseLinkAt(text: string, start: number): LinkMatch | null {
  if (text[start] !== "[") return null;
  const labelEnd = findLabelEnd(text, start + 1);
  if (labelEnd === -1 || text[labelEnd + 1] !== "(") return null;
  const destination = parseDestination(text, labelEnd + 2);
  if (!destination) return null;
  return { label: text.slice(start + 1, labelEnd), ...destination };
}

/**
 * Parse inline Markdown. Delimiter spans and link labels are parsed
 * recursively, so their content can carry further styles; `styles` holds the
 * styles of the spans enclosing `text`.
 */
function parseInlineMarkdown(
  text: string,
  styles: Styles = {},
  inLink = false,
): BlockNoteInlineContent[] {
  const result: BlockNoteInlineContent[] = [];
  let plain = "";
  const flushPlain = () => {
    if (plain) result.push({ type: "text", text: plain, styles: { ...styles } });
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\" && isPunctuation(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const end = findCodeSpanEnd(text, i);
      if (end !== -1) {
        flushPlain();
        result.push({
          type: "text",
          text: text.slice(i + 1, end),
          styles: { ...styles, code: true },
        });
        i = end + 1;
        continue;
      }
    }

    // Links can't nest, so a `[` inside link text is literal.
    if (ch === "[" && !inLink) {
      const link = parseLinkAt(text, i);
      if (link) {
        flushPlain();
        const content = parseInlineMarkdown(link.label, styles, true);
        result.push({
          type: "link",
          text: content.map((c) => c.text ?? "").join(""),
          href: link.href,
          content,
        });
        i = link.end;
        continue;
      }
    }

    if (ch === "*" || ch === "~") {
      const span = parseDelimitedAt(text, i);
      if (span) {
        flushPlain();
        const spanStyles = { ...styles, ...DELIMITER_STYLES[span.delimiter] };
        // A loop, not push(...nodes): a long span can hold more nodes than a call takes arguments.
        for (const node of parseInlineMarkdown(span.inner, spanStyles, inLink)) result.push(node);
        i = span.end;
        continue;
      }
    }

    plain += ch;
    i++;
  }

  flushPlain();
  return result;
}

// A line of backticks at least as long as the opening fence closes a code block.
function isClosingFence(line: string, fenceLength: number): boolean {
  const match = line.match(/^\s*(`+)\s*$/);
  return match !== null && match[1].length >= fenceLength;
}

/**
 * Split a `| a | b |` row on unescaped pipes. GFM strips `\|` back to `|`
 * before a cell's inline Markdown is read; every other backslash is left for
 * parseInlineMarkdown. Only `\|` is consumed, so `\\|` is a backslash plus an
 * escaped pipe, exactly reversing tableCellToMarkdown, whose code spans keep
 * their backslashes unescaped. The trailing pipe is optional.
 */
function splitTableRow(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  cells.shift(); // before the leading pipe
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop(); // after a trailing pipe
  return cells;
}

function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function parseTableLine(line: string): ParsedLine | null {
  const parsed = parseLine(line);
  return parsed.content.startsWith("|") ? parsed : null;
}

/**
 * Convert Markdown text to BlockNote blocks.
 * Supports headings, paragraphs, bullet/numbered/check lists, code blocks, images, and inline styles.
 * Indented lines nest under the nearest less-indented block, matching the
 * 2-space-per-level indent blockNoteToMarkdown emits for `children`.
 */
export function markdownToBlockNote(markdown: string): BlockNoteBlock[] {
  const lines = markdown.split("\n");
  const blocks: BlockNoteBlock[] = [];
  // Blocks that can still receive children, outermost first.
  const ancestors: { block: BlockNoteBlock; indent: number }[] = [];

  const attachBlock = (block: BlockNoteBlock, indent: number) => {
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].indent >= indent) {
      ancestors.pop();
    }
    const parent = ancestors[ancestors.length - 1];
    if (parent) {
      parent.block.children = [...(parent.block.children ?? []), block];
    } else {
      blocks.push(block);
    }
    ancestors.push({ block, indent });
  };

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    const { indent, content } = parseLine(line);

    // Fenced code block. Content lines are read verbatim, indentation included.
    const codeMatch = content.match(/^(`{3,})(\w*)/);
    if (codeMatch) {
      const fenceLength = codeMatch[1].length;
      const language = codeMatch[2] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !isClosingFence(lines[i], fenceLength)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const text = codeLines.join("\n");
      attachBlock(
        {
          type: "codeBlock",
          props: { language },
          content: text ? [{ type: "text", text, styles: {} }] : [],
          children: [],
        },
        indent,
      );
      continue;
    }

    // Heading
    const headingMatch = content.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      attachBlock(
        {
          type: "heading",
          props: { level: headingMatch[1].length },
          content: parseInlineMarkdown(headingMatch[2]),
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Image. Text after it on the same line makes the line a paragraph, so it isn't dropped.
    const imageMatch = content.startsWith("!") ? parseLinkAt(content, 1) : null;
    if (imageMatch && content.slice(imageMatch.end).trim() === "") {
      const props: Record<string, unknown> = { url: imageMatch.href };
      const caption = unescapeMarkdown(imageMatch.label);
      if (caption) props.caption = caption;
      attachBlock({ type: "image", props, children: [] }, indent);
      i++;
      continue;
    }

    // Standalone attachment file link: [name](attachment://...)
    // The forward direction (blockToMarkdown) emits file blocks in this exact
    // shape, so reading it back without restoring the file block would silently
    // downgrade it to a paragraph and break web's native attachment rendering.
    const fileMatch = parseLinkAt(content, 0);
    if (
      fileMatch &&
      fileMatch.href.startsWith("attachment://") &&
      content.slice(fileMatch.end).trim() === ""
    ) {
      attachBlock(
        {
          type: "file",
          props: { url: fileMatch.href, name: unescapeMarkdown(fileMatch.label) },
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Check list item
    const checkMatch = content.match(/^-\s+\[([ xX])\]\s+(.*)/);
    if (checkMatch) {
      attachBlock(
        {
          type: "checkListItem",
          props: { checked: checkMatch[1] !== " " },
          content: parseInlineMarkdown(checkMatch[2]),
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Bullet list item
    const bulletMatch = content.match(/^[-*+]\s+(.*)/);
    if (bulletMatch) {
      attachBlock(
        {
          type: "bulletListItem",
          content: parseInlineMarkdown(bulletMatch[1]),
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Numbered list item
    const numberedMatch = content.match(/^\d+\.\s+(.*)/);
    if (numberedMatch) {
      attachBlock(
        {
          type: "numberedListItem",
          content: parseInlineMarkdown(numberedMatch[1]),
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Table: consecutive `|` lines at this block's indent
    if (content.startsWith("|")) {
      const tableRows: string[][] = [];
      let row = parseTableLine(lines[i]);
      while (row && row.indent === indent) {
        tableRows.push(splitTableRow(row.content.trim()));
        i++;
        row = i < lines.length ? parseTableLine(lines[i]) : null;
      }
      // GFM: the delimiter row (| --- | --- |) is the table's second line, with
      // or without a trailing pipe. A `---` row anywhere else is data.
      if (tableRows.length > 1 && isDelimiterRow(tableRows[1])) {
        tableRows.splice(1, 1);
      }
      const tableContent: BlockNoteTableContent = {
        type: "tableContent",
        rows: tableRows.map((cells) => ({
          cells: cells.map((cell) => parseInlineMarkdown(cell.trim())),
        })),
      };
      attachBlock({ type: "table", content: tableContent, children: [] }, indent);
      continue;
    }

    // Default: paragraph
    attachBlock(
      {
        type: "paragraph",
        content: parseInlineMarkdown(content),
        children: [],
      },
      indent,
    );
    i++;
  }

  return blocks;
}
