import { isAboveModal } from "@/lib/sheet-presentation";

const tabs = { key: "tabs-1", name: "(tabs)" };
const notebook = { key: "notebook-1", name: "notebooks/[id]" };
const search = { key: "search-1", name: "search" };
const note = { key: "note-1", name: "notes/[id]" };

describe("isAboveModal", () => {
  it("is true for a note opened from Search, which iOS presents as a sheet of its own", () => {
    expect(isAboveModal([tabs, search, note], note.key)).toBe(true);
  });

  it("is false for a note opened from its notebook", () => {
    expect(isAboveModal([tabs, notebook, note], note.key)).toBe(false);
  });

  it("is false for the modal itself, which has its own close button", () => {
    expect(isAboveModal([tabs, search], search.key)).toBe(false);
  });

  it("is false for a route that is not in the stack", () => {
    expect(isAboveModal([tabs, search], "missing")).toBe(false);
  });
});
