import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTE_TITLE,
  displayNoteTitle,
  toStoredTitle,
  toTitleInputValue,
} from "@/lib/note-title";

describe("DEFAULT_NOTE_TITLE", () => {
  it("matches the title new notes are created with", () => {
    expect(DEFAULT_NOTE_TITLE).toBe("Untitled");
  });
});

describe("toTitleInputValue", () => {
  it("shows the default title as an empty field, so typing replaces it", () => {
    expect(toTitleInputValue("Untitled")).toBe("");
  });

  it("shows an empty title as an empty field", () => {
    expect(toTitleInputValue("")).toBe("");
  });

  it("shows a missing title as an empty field", () => {
    expect(toTitleInputValue(null)).toBe("");
    expect(toTitleInputValue(undefined)).toBe("");
  });

  it("keeps a real title as typed", () => {
    expect(toTitleInputValue("Groceries")).toBe("Groceries");
  });

  it("only treats the exact default as no title", () => {
    expect(toTitleInputValue("Untitled draft")).toBe("Untitled draft");
    expect(toTitleInputValue("untitled")).toBe("untitled");
  });
});

describe("toStoredTitle", () => {
  it("stores the default title for an emptied field", () => {
    expect(toStoredTitle("")).toBe("Untitled");
  });

  it("stores a typed title as is", () => {
    expect(toStoredTitle("Groceries")).toBe("Groceries");
  });

  it("round-trips the default title through the input", () => {
    expect(toStoredTitle(toTitleInputValue(DEFAULT_NOTE_TITLE))).toBe(DEFAULT_NOTE_TITLE);
  });
});

describe("displayNoteTitle", () => {
  it("falls back to the default for an empty title", () => {
    expect(displayNoteTitle("")).toBe("Untitled");
  });

  it("falls back to the default for a missing title", () => {
    expect(displayNoteTitle(null)).toBe("Untitled");
    expect(displayNoteTitle(undefined)).toBe("Untitled");
  });

  it("shows a stored title as is, including the default", () => {
    expect(displayNoteTitle("Groceries")).toBe("Groceries");
    expect(displayNoteTitle("Untitled")).toBe("Untitled");
  });
});
