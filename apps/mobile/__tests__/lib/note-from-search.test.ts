import { isOpenedFromSearch, noteFromSearchHref } from "@/lib/note-from-search";

describe("note-from-search", () => {
  it("links to the note and records that Search opened it", () => {
    expect(noteFromSearchHref("note-1")).toBe("/notes/note-1?from=search");
  });

  it("recognises a note opened from Search", () => {
    expect(isOpenedFromSearch({ id: "note-1", from: "search" })).toBe(true);
  });

  it("treats any other note as opened from its notebook", () => {
    expect(isOpenedFromSearch({ id: "note-1" })).toBe(false);
    expect(isOpenedFromSearch({ id: "note-1", from: "elsewhere" })).toBe(false);
    expect(isOpenedFromSearch(undefined)).toBe(false);
  });
});
