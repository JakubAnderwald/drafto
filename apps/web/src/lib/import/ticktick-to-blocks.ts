import type { BlockNoteBlock } from "@drafto/shared";
import { markdownToBlockNote } from "@drafto/shared";
import type { TickTickItem } from "@/lib/import/ticktick-types";

export function ticktickItemToBlocks(item: TickTickItem): BlockNoteBlock[] {
  if (!item.content.trim()) {
    return [emptyParagraph()];
  }

  if (item.isCheckList) {
    return checklistBlocks(item.content);
  }

  return markdownToBlockNote(item.content);
}

function checklistBlocks(content: string): BlockNoteBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: BlockNoteBlock[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const markdownMatch = line.match(/^-\s+\[([ xX])\]\s+(.*)/);
    if (markdownMatch) {
      blocks.push(checkBlock(markdownMatch[1].toLowerCase() === "x", markdownMatch[2].trim()));
      continue;
    }

    const ticktickMatch = line.match(/^([-*])\s+(.*)/);
    if (ticktickMatch) {
      blocks.push(checkBlock(false, ticktickMatch[2].trim()));
      continue;
    }

    blocks.push(checkBlock(false, line));
  }

  if (blocks.length === 0) {
    return [emptyParagraph()];
  }

  return blocks;
}

function checkBlock(checked: boolean, text: string): BlockNoteBlock {
  return {
    type: "checkListItem",
    props: { checked },
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

function emptyParagraph(): BlockNoteBlock {
  return {
    type: "paragraph",
    content: [],
    children: [],
  };
}
