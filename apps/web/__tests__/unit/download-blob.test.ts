/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { downloadBlob, filenameFromContentDisposition } from "@/lib/export/download-blob";

describe("filenameFromContentDisposition", () => {
  it("extracts a quoted filename", () => {
    expect(filenameFromContentDisposition('attachment; filename="My-Notebook.enex"')).toBe(
      "My-Notebook.enex",
    );
  });

  it("extracts an unquoted filename", () => {
    expect(filenameFromContentDisposition("attachment; filename=plain.enex")).toBe("plain.enex");
  });

  it("returns null when no filename present", () => {
    expect(filenameFromContentDisposition("attachment")).toBeNull();
    expect(filenameFromContentDisposition(null)).toBeNull();
  });
});

describe("downloadBlob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom provides DOM APIs but not createObjectURL/revokeObjectURL
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:fake-url"),
      writable: true,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
  });

  it("creates an anchor, clicks it, and revokes the object URL", () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const blob = new Blob(["data"], { type: "application/enex+xml" });
    downloadBlob(blob, "drafto-export.enex");

    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalled();

    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
  });
});
