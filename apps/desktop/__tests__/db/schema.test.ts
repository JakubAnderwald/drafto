import { schema, notebooksTable, notesTable, attachmentsTable } from "@/db/schema";

describe("WatermelonDB Schema", () => {
  it("has schema version 3", () => {
    expect(schema.version).toBe(3);
  });

  it("defines 3 tables", () => {
    const tableNames = Object.keys(schema.tables);
    expect(tableNames).toHaveLength(3);
    expect(tableNames).toContain("notebooks");
    expect(tableNames).toContain("notes");
    expect(tableNames).toContain("attachments");
  });

  describe("notebooks table", () => {
    it("has correct name", () => {
      expect(notebooksTable.name).toBe("notebooks");
    });

    it("has required columns", () => {
      const columnNames = notebooksTable.columnArray.map((c) => c.name);
      expect(columnNames).toContain("remote_id");
      expect(columnNames).toContain("user_id");
      expect(columnNames).toContain("name");
      expect(columnNames).toContain("created_at");
      expect(columnNames).toContain("updated_at");
    });
  });

  describe("notes table", () => {
    it("has correct name", () => {
      expect(notesTable.name).toBe("notes");
    });

    it("has required columns", () => {
      const columnNames = notesTable.columnArray.map((c) => c.name);
      expect(columnNames).toContain("remote_id");
      expect(columnNames).toContain("notebook_id");
      expect(columnNames).toContain("user_id");
      expect(columnNames).toContain("title");
      expect(columnNames).toContain("content");
      expect(columnNames).toContain("is_trashed");
      expect(columnNames).toContain("trashed_at");
      expect(columnNames).toContain("created_at");
      expect(columnNames).toContain("updated_at");
    });

    it("has notebook_id indexed", () => {
      const notebookIdCol = notesTable.columnArray.find((c) => c.name === "notebook_id");
      expect(notebookIdCol?.isIndexed).toBe(true);
    });

    it("has content as optional", () => {
      const contentCol = notesTable.columnArray.find((c) => c.name === "content");
      expect(contentCol?.isOptional).toBe(true);
    });

    it("has trashed_at as optional", () => {
      const trashedAtCol = notesTable.columnArray.find((c) => c.name === "trashed_at");
      expect(trashedAtCol?.isOptional).toBe(true);
    });
  });

  describe("attachments table", () => {
    it("has correct name", () => {
      expect(attachmentsTable.name).toBe("attachments");
    });

    it("has required columns", () => {
      const columnNames = attachmentsTable.columnArray.map((c) => c.name);
      expect(columnNames).toContain("remote_id");
      expect(columnNames).toContain("note_id");
      expect(columnNames).toContain("user_id");
      expect(columnNames).toContain("file_name");
      expect(columnNames).toContain("file_path");
      expect(columnNames).toContain("file_size");
      expect(columnNames).toContain("mime_type");
      expect(columnNames).toContain("local_uri");
      expect(columnNames).toContain("upload_status");
      expect(columnNames).toContain("upload_error");
      expect(columnNames).toContain("created_at");
    });

    it("has note_id indexed", () => {
      const noteIdCol = attachmentsTable.columnArray.find((c) => c.name === "note_id");
      expect(noteIdCol?.isIndexed).toBe(true);
    });

    it("has local_uri as optional", () => {
      const localUriCol = attachmentsTable.columnArray.find((c) => c.name === "local_uri");
      expect(localUriCol?.isOptional).toBe(true);
    });

    it("has upload_error as optional", () => {
      const uploadErrorCol = attachmentsTable.columnArray.find((c) => c.name === "upload_error");
      expect(uploadErrorCol?.isOptional).toBe(true);
    });
  });
});
