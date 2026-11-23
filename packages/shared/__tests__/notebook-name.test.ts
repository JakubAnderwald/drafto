import { describe, expect, it, vi } from "vitest";

import {
  duplicateNotebookNameMessage,
  findDuplicateNotebook,
  formatNoteCount,
  normalizeNotebookName,
} from "../src/notebooks/notebook-name";

const notebooks = [
  { id: "nb-1", name: "Project Ideas" },
  { id: "nb-2", name: "Recipes" },
];

describe("PrimeTestLab 11035 M-01 normalizeNotebookName", () => {
  it("trims, collapses inner spaces and ignores case", () => {
    expect(normalizeNotebookName("  Project   Ideas ")).toBe("project ideas");
    expect(normalizeNotebookName("PROJECT\tIDEAS")).toBe("project ideas");
  });

  it("folds case the same way whatever the device locale is", () => {
    // A Turkish-locale device lower-cases "I" to dotless "ı"; the check must not follow it.
    const turkish = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (
      this: string,
    ) {
      return this.replace(/I/g, "ı").toLowerCase();
    });
    try {
      expect(normalizeNotebookName("IDEAS")).toBe("ideas");
      expect(findDuplicateNotebook("IDEAS", [{ id: "nb-1", name: "ideas" }])).toEqual({
        id: "nb-1",
        name: "ideas",
      });
    } finally {
      turkish.mockRestore();
    }
  });

  it("treats composed and decomposed accents as the same name", () => {
    expect(normalizeNotebookName("Café")).toBe(normalizeNotebookName("Café"));
  });
});

describe("PrimeTestLab 11035 M-01 findDuplicateNotebook", () => {
  it("finds an exact duplicate", () => {
    expect(findDuplicateNotebook("Project Ideas", notebooks)).toEqual(notebooks[0]);
  });

  it("ignores case and spacing", () => {
    expect(findDuplicateNotebook("  project   IDEAS ", notebooks)).toEqual(notebooks[0]);
  });

  it("returns undefined for a free name, and for an empty one", () => {
    expect(findDuplicateNotebook("Travel", notebooks)).toBeUndefined();
    expect(findDuplicateNotebook("   ", notebooks)).toBeUndefined();
  });

  it("lets a notebook keep its name or change only its case on a rename", () => {
    expect(findDuplicateNotebook("project ideas", notebooks, "nb-1")).toBeUndefined();
    expect(findDuplicateNotebook("Project Ideas", notebooks, "nb-1")).toBeUndefined();
  });

  it("blocks renaming a notebook to another notebook's name", () => {
    expect(findDuplicateNotebook("recipes", notebooks, "nb-1")).toEqual(notebooks[1]);
  });

  it("lets an older duplicate keep its own name", () => {
    const legacy = [...notebooks, { id: "nb-3", name: "recipes" }];
    expect(findDuplicateNotebook("recipes", legacy, "nb-3")).toBeUndefined();
    expect(findDuplicateNotebook("Recipes!", legacy, "nb-3")).toBeUndefined();
  });
});

describe("PrimeTestLab 11035 M-01 duplicateNotebookNameMessage", () => {
  it("names the notebook and says what to do", () => {
    expect(duplicateNotebookNameMessage("Project Ideas")).toBe(
      'A notebook named "Project Ideas" already exists. Choose a different name.',
    );
  });
});

describe("PrimeTestLab 11035 S-03 note counts", () => {
  it("formats singular and plural counts", () => {
    expect(formatNoteCount(0)).toBe("0 notes");
    expect(formatNoteCount(1)).toBe("1 note");
    expect(formatNoteCount(3)).toBe("3 notes");
  });
});
