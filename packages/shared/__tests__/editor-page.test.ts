import { describe, expect, it } from "vitest";

import {
  EDITOR_PAGE_DIR_NAME,
  editorPageFileName,
  editorPageLocation,
} from "../src/editor/editor-page";
import { attachmentCacheRelativePath } from "../src/editor/attachment-url";
import { cyrb64Hex } from "../src/hash/cyrb64";

describe("editorPageFileName", () => {
  it("is an .html name made from the page's hash and length", () => {
    const html = "<html><body>editor</body></html>";
    expect(editorPageFileName(html)).toBe(
      `editor-${cyrb64Hex(html)}-${html.length.toString(36)}.html`,
    );
    expect(editorPageFileName(html)).toMatch(/^editor-[0-9a-f]{16}-[0-9a-z]+\.html$/);
  });

  it("is the same for the same page and changes when the page does", () => {
    expect(editorPageFileName("<html>a</html>")).toBe(editorPageFileName("<html>a</html>"));
    expect(editorPageFileName("<html>a</html>")).not.toBe(editorPageFileName("<html>b</html>"));
  });
});

describe("editorPageLocation", () => {
  it("puts the page in the cache's editor folder and grants read access to the cache", () => {
    expect(editorPageLocation("file:///docs/attachment-cache", "editor-1.html")).toEqual({
      uri: "file:///docs/attachment-cache/.editor/editor-1.html",
      readAccessUrl: "file:///docs/attachment-cache/",
    });
  });

  it("keeps a trailing slash the cache URL already has", () => {
    expect(editorPageLocation("file:///docs/attachment-cache/", "editor-1.html")).toEqual({
      uri: "file:///docs/attachment-cache/.editor/editor-1.html",
      readAccessUrl: "file:///docs/attachment-cache/",
    });
  });
});

describe("EDITOR_PAGE_DIR_NAME", () => {
  it("can never be a cached attachment's folder", () => {
    expect(EDITOR_PAGE_DIR_NAME.startsWith(".")).toBe(true);
    // A storage key segment with this name is renamed in the cache.
    expect(attachmentCacheRelativePath(`${EDITOR_PAGE_DIR_NAME}/a.png`).split("/")[0]).not.toBe(
      EDITOR_PAGE_DIR_NAME,
    );
  });
});
