import { Note } from "@/db/models/note";
import { Notebook } from "@/db/models/notebook";
import { Attachment } from "@/db/models/attachment";

describe("Notebook model", () => {
  it("has correct table name", () => {
    expect(Notebook.table).toBe("notebooks");
  });

  it("has has_many association to notes", () => {
    expect(Notebook.associations).toEqual({
      notes: { type: "has_many", foreignKey: "notebook_id" },
    });
  });
});

describe("Note model", () => {
  it("has correct table name", () => {
    expect(Note.table).toBe("notes");
  });

  it("has belongs_to association to notebooks", () => {
    expect(Note.associations).toEqual(
      expect.objectContaining({
        notebooks: { type: "belongs_to", key: "notebook_id" },
      }),
    );
  });

  it("has has_many association to attachments", () => {
    expect(Note.associations).toEqual(
      expect.objectContaining({
        attachments: { type: "has_many", foreignKey: "note_id" },
      }),
    );
  });
});

describe("Attachment model", () => {
  it("has correct table name", () => {
    expect(Attachment.table).toBe("attachments");
  });

  it("has belongs_to association to notes", () => {
    expect(Attachment.associations).toEqual({
      notes: { type: "belongs_to", key: "note_id" },
    });
  });
});
