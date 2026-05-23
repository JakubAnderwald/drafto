import { describe, it, expect } from "vitest";
import { ticktickItemToBlocks } from "@/lib/import/ticktick-to-blocks";
import type { TickTickItem } from "@/lib/import/ticktick-types";

function item(overrides: Partial<TickTickItem>): TickTickItem {
  return {
    folderName: "",
    listName: "Inbox",
    title: "Untitled",
    content: "",
    isCheckList: false,
    created: "2025-01-01T00:00:00.000Z",
    updated: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ticktickItemToBlocks", () => {
  it("returns an empty paragraph for empty content", () => {
    const blocks = ticktickItemToBlocks(item({ content: "" }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].content).toEqual([]);
  });

  it("converts plain text content via markdown", () => {
    const blocks = ticktickItemToBlocks(item({ content: "Hello world" }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  it("preserves markdown headings", () => {
    const blocks = ticktickItemToBlocks(item({ content: "# Heading 1\nbody" }));

    expect(blocks[0].type).toBe("heading");
  });

  it("converts checklist content into checkListItem blocks", () => {
    const blocks = ticktickItemToBlocks(
      item({
        isCheckList: true,
        content: "- [ ] Item 1\n- [x] Item 2",
      }),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("checkListItem");
    expect(blocks[0].props?.checked).toBe(false);
    expect(blocks[1].type).toBe("checkListItem");
    expect(blocks[1].props?.checked).toBe(true);
  });

  it("treats plain bullet lines as unchecked items in checklist mode", () => {
    const blocks = ticktickItemToBlocks(
      item({
        isCheckList: true,
        content: "- First\n- Second",
      }),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("checkListItem");
    expect(blocks[0].props?.checked).toBe(false);
  });

  it("treats raw lines as unchecked items in checklist mode", () => {
    const blocks = ticktickItemToBlocks(
      item({
        isCheckList: true,
        content: "Buy milk\nWalk dog",
      }),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("checkListItem");
    const firstContent = blocks[0].content as Array<{ text: string }>;
    const secondContent = blocks[1].content as Array<{ text: string }>;
    expect(firstContent[0].text).toBe("Buy milk");
    expect(secondContent[0].text).toBe("Walk dog");
  });

  it("returns a paragraph for whitespace-only content", () => {
    const blocks = ticktickItemToBlocks(item({ content: "   \n  " }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });
});
