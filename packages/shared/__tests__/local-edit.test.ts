import { describe, expect, it } from "vitest";

import { hasLocalEdit, type LocalChangeEntry } from "../src/sync/local-edit";

function change(table: string, type: string, syncStatus: string): LocalChangeEntry {
  return { type, record: { table, syncStatus } };
}

describe("hasLocalEdit", () => {
  it("is true for a user edit that still has to be pushed", () => {
    expect(hasLocalEdit([change("notes", "updated", "updated")])).toBe(true);
    expect(hasLocalEdit([change("notebooks", "created", "created")])).toBe(true);
    expect(hasLocalEdit([change("notes", "destroyed", "deleted")])).toBe(true);
    expect(hasLocalEdit([change("attachments", "created", "created")])).toBe(true);
  });

  it("is false for a sync's own writes, which leave records synced", () => {
    expect(
      hasLocalEdit([
        change("notes", "updated", "synced"),
        change("notebooks", "created", "synced"),
        change("attachments", "destroyed", "synced"),
      ]),
    ).toBe(false);
  });

  it("is false for the upload queue updating an attachment", () => {
    expect(hasLocalEdit([change("attachments", "updated", "updated")])).toBe(false);
    expect(hasLocalEdit([change("attachments", "updated", "created")])).toBe(false);
  });

  it("is true when any change in the batch qualifies", () => {
    expect(
      hasLocalEdit([
        change("attachments", "updated", "updated"),
        change("notes", "updated", "synced"),
        change("notes", "updated", "updated"),
      ]),
    ).toBe(true);
  });

  it("is false for an empty batch", () => {
    expect(hasLocalEdit([])).toBe(false);
  });
});
