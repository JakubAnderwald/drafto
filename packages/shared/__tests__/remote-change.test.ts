import { describe, expect, it } from "vitest";

import { isVisibleRemoteChange } from "../src/sync/remote-change";

import { jsonbReordered } from "./helpers/jsonb";

const CONTENT = JSON.stringify([
  {
    id: "block-1",
    type: "paragraph",
    props: { textColor: "default" },
    content: [{ type: "text", text: "hello", styles: {} }],
    children: [],
  },
]);

const LOCAL_NOTE = {
  id: "note-1",
  _status: "synced",
  _changed: "",
  title: "Groceries",
  content: CONTENT,
  notebook_id: "nb-1",
  is_trashed: false,
  trashed_at: null,
  updated_at: 1_000,
};

describe("isVisibleRemoteChange", () => {
  describe("notes", () => {
    it("ignores the echo of this device's own push: reordered jsonb and a new updated_at", () => {
      const echo = { ...LOCAL_NOTE, content: jsonbReordered(CONTENT), updated_at: 2_000 };
      expect(echo.content).not.toBe(CONTENT); // precondition: the bytes really differ
      expect(isVisibleRemoteChange("notes", LOCAL_NOTE, echo)).toBe(false);
    });

    it("ignores columns the user cannot see", () => {
      const resolved = { ...LOCAL_NOTE, trashed_at: 5_000, updated_at: 9_000, user_id: "u" };
      expect(isVisibleRemoteChange("notes", LOCAL_NOTE, resolved)).toBe(false);
    });

    it("counts a title change", () => {
      expect(isVisibleRemoteChange("notes", LOCAL_NOTE, { ...LOCAL_NOTE, title: "Shopping" })).toBe(
        true,
      );
    });

    it("counts a content change", () => {
      const edited = CONTENT.replace("hello", "hello world");
      expect(isVisibleRemoteChange("notes", LOCAL_NOTE, { ...LOCAL_NOTE, content: edited })).toBe(
        true,
      );
    });

    it("counts content appearing or disappearing", () => {
      const empty = { ...LOCAL_NOTE, content: null };
      expect(isVisibleRemoteChange("notes", empty, LOCAL_NOTE)).toBe(true);
      expect(isVisibleRemoteChange("notes", LOCAL_NOTE, empty)).toBe(true);
    });

    it("counts a move to another notebook", () => {
      expect(
        isVisibleRemoteChange("notes", LOCAL_NOTE, { ...LOCAL_NOTE, notebook_id: "nb-2" }),
      ).toBe(true);
    });

    it("counts trashing and restoring", () => {
      const trashed = { ...LOCAL_NOTE, is_trashed: true };
      expect(isVisibleRemoteChange("notes", LOCAL_NOTE, trashed)).toBe(true);
      expect(isVisibleRemoteChange("notes", trashed, LOCAL_NOTE)).toBe(true);
    });

    it("treats missing text and booleans like their empty values", () => {
      const sparse = { id: "note-1", content: null };
      const filled = { id: "note-1", title: "", notebook_id: "", is_trashed: false, content: null };
      expect(isVisibleRemoteChange("notes", sparse, filled)).toBe(false);
    });

    it("is false when the resolved record kept the local column the device changed", () => {
      // WatermelonDB keeps locally changed columns, so a dirty local note and
      // the echo of its previous push resolve to the local values.
      const dirty = { ...LOCAL_NOTE, _status: "updated", _changed: "title", title: "Draft 2" };
      const resolved = { ...dirty, content: jsonbReordered(CONTENT), updated_at: 3_000 };
      expect(isVisibleRemoteChange("notes", dirty, resolved)).toBe(false);
    });
  });

  describe("notebooks", () => {
    const notebook = { id: "nb-1", name: "Work", updated_at: 1_000 };

    it("counts a rename", () => {
      expect(isVisibleRemoteChange("notebooks", notebook, { ...notebook, name: "Home" })).toBe(
        true,
      );
    });

    it("ignores an updated_at-only echo", () => {
      expect(isVisibleRemoteChange("notebooks", notebook, { ...notebook, updated_at: 2_000 })).toBe(
        false,
      );
    });
  });

  it("never counts attachments, which are immutable", () => {
    const attachment = { id: "att-1", upload_status: "pending", local_uri: "file:///a.png" };
    const pulled = { ...attachment, upload_status: "uploaded", local_uri: null };
    expect(isVisibleRemoteChange("attachments", attachment, pulled)).toBe(false);
  });
});
