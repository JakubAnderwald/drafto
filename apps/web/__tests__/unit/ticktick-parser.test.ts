import { describe, it, expect } from "vitest";
import { parseTickTickCsv } from "@/lib/import/ticktick-parser";

describe("parseTickTickCsv", () => {
  it("parses a basic CSV export with one task", () => {
    const csv = `"Date: 2025-12-01"\n"Version: 8.0.0"\n\nFolder Name,List Name,Title,Kind,Tags,Content,Is Check list,Created Time,Modified Time\nWork,Inbox,Buy milk,TEXT,,Some content,N,2025-11-01T10:00:00+0000,2025-11-02T11:00:00+0000`;

    const groups = parseTickTickCsv(csv);

    expect(groups).toHaveLength(1);
    expect(groups[0].notebookName).toBe("Work / Inbox");
    expect(groups[0].items).toHaveLength(1);
    expect(groups[0].items[0].title).toBe("Buy milk");
    expect(groups[0].items[0].content).toBe("Some content");
    expect(groups[0].items[0].isCheckList).toBe(false);
    expect(groups[0].items[0].folderName).toBe("Work");
    expect(groups[0].items[0].listName).toBe("Inbox");
  });

  it("groups items by folder/list combination", () => {
    const csv = `Folder Name,List Name,Title,Content\n,Inbox,Task A,content A\n,Inbox,Task B,content B\nWork,Projects,Task C,content C`;

    const groups = parseTickTickCsv(csv);

    expect(groups).toHaveLength(2);
    const inbox = groups.find((g) => g.notebookName === "Inbox");
    const work = groups.find((g) => g.notebookName === "Work / Projects");
    expect(inbox?.items).toHaveLength(2);
    expect(work?.items).toHaveLength(1);
  });

  it("detects checklist items via Kind column", () => {
    const csv = `Folder Name,List Name,Title,Kind,Content\n,Tasks,My list,CHECKLIST,- [ ] One\n- [x] Two`;

    const groups = parseTickTickCsv(csv);

    expect(groups).toHaveLength(1);
    expect(groups[0].items[0].isCheckList).toBe(true);
  });

  it("detects checklist items via Is Check list column", () => {
    const csv = `List Name,Title,Is Check list,Content\nInbox,My list,Y,line one\nline two`;

    const groups = parseTickTickCsv(csv);

    expect(groups[0].items[0].isCheckList).toBe(true);
  });

  it("handles quoted fields with commas and newlines", () => {
    const csv = `List Name,Title,Content\nInbox,"Title, with comma","Multi\nline\ncontent"`;

    const groups = parseTickTickCsv(csv);

    expect(groups[0].items[0].title).toBe("Title, with comma");
    expect(groups[0].items[0].content).toBe("Multi\nline\ncontent");
  });

  it("handles escaped quotes inside quoted fields", () => {
    const csv = `List Name,Title,Content\nInbox,"She said ""hi""",body`;

    const groups = parseTickTickCsv(csv);

    expect(groups[0].items[0].title).toBe('She said "hi"');
  });

  it("skips rows without a title", () => {
    const csv = `List Name,Title,Content\nInbox,,empty title row\nInbox,Real,actual content`;

    const groups = parseTickTickCsv(csv);

    expect(groups[0].items).toHaveLength(1);
    expect(groups[0].items[0].title).toBe("Real");
  });

  it("uses list name only when folder is empty", () => {
    const csv = `Folder Name,List Name,Title\n,Quick Notes,Task one`;

    const groups = parseTickTickCsv(csv);

    expect(groups[0].notebookName).toBe("Quick Notes");
  });

  it("falls back to Inbox when list name is missing", () => {
    const csv = `Folder Name,List Name,Title\n,,Orphan task`;

    const groups = parseTickTickCsv(csv);

    expect(groups[0].notebookName).toBe("Inbox");
  });

  it("strips a UTF-8 BOM at the start of the file", () => {
    const csv = `﻿List Name,Title\nInbox,My note`;

    const groups = parseTickTickCsv(csv);

    expect(groups).toHaveLength(1);
    expect(groups[0].items[0].title).toBe("My note");
  });

  it("throws on missing required columns", () => {
    expect(() => parseTickTickCsv("Foo,Bar\nA,B")).toThrow(/header row not found/i);
  });

  it("throws on empty input", () => {
    expect(() => parseTickTickCsv("")).toThrow(/empty/i);
  });

  it("parses timestamps to ISO format", () => {
    const csv = `List Name,Title,Created Time\nInbox,Task,2025-06-15T08:30:00+0000`;

    const groups = parseTickTickCsv(csv);

    expect(groups[0].items[0].created).toBe("2025-06-15T08:30:00.000Z");
  });

  it("falls back to current time when timestamp is missing", () => {
    const csv = `List Name,Title\nInbox,Task`;

    const groups = parseTickTickCsv(csv);

    expect(() => new Date(groups[0].items[0].created)).not.toThrow();
  });

  it("skips metadata preamble lines before the header", () => {
    const csv = `"Date: 2025-12-01"\n"Account: user@example.com"\n"Status"\n\nList Name,Title\nInbox,Real task`;

    const groups = parseTickTickCsv(csv);

    expect(groups).toHaveLength(1);
    expect(groups[0].items[0].title).toBe("Real task");
  });
});
