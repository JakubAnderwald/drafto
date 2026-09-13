import { describe, it, expect } from "vitest";
import { buildEnex, formatEvernoteDate, type ExportedNote } from "../enex-builder";

const SAMPLE_NOTE: ExportedNote = {
  title: "Hello",
  enmlContent: "<en-note><div>Hello</div></en-note>",
  created: "2026-06-08T14:02:14Z",
  updated: "2026-06-08T14:02:14Z",
  resources: [],
};

describe("formatEvernoteDate", () => {
  it("encodes ISO-8601 to YYYYMMDDTHHMMSSZ", () => {
    expect(formatEvernoteDate("2026-06-08T15:06:32Z")).toBe("20260608T150632Z");
  });

  it("accepts a Date", () => {
    expect(formatEvernoteDate(new Date("2024-01-02T03:04:05Z"))).toBe("20240102T030405Z");
  });

  it("falls back to now for invalid input", () => {
    const out = formatEvernoteDate("not-a-date");
    expect(out).toMatch(/^\d{8}T\d{6}Z$/);
  });
});

describe("buildEnex", () => {
  it("emits the XML declaration, DOCTYPE, and en-export wrapper", () => {
    const xml = buildEnex({ notes: [SAMPLE_NOTE], exportDate: new Date("2026-06-08T15:06:32Z") });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<!DOCTYPE en-export");
    expect(xml).toContain('export-date="20260608T150632Z"');
    expect(xml).toContain('application="Drafto"');
    expect(xml).toContain("</en-export>");
  });

  it("emits one <note> per input note with title, content, created, updated, and source", () => {
    const xml = buildEnex({
      notes: [SAMPLE_NOTE, { ...SAMPLE_NOTE, title: "Second" }],
    });
    const noteCount = (xml.match(/<note>/g) ?? []).length;
    expect(noteCount).toBe(2);
    expect(xml).toContain("<title>Hello</title>");
    expect(xml).toContain("<title>Second</title>");
    expect(xml).toContain("<created>20260608T140214Z</created>");
    expect(xml).toContain("<updated>20260608T140214Z</updated>");
    expect(xml).toContain("<source>drafto</source>");
    expect(xml).toContain("<![CDATA[");
  });

  it("escapes special characters in titles", () => {
    const xml = buildEnex({
      notes: [{ ...SAMPLE_NOTE, title: "Tom & Jerry <3" }],
    });
    expect(xml).toContain("<title>Tom &amp; Jerry &lt;3</title>");
  });

  it("falls back to 'Untitled' when title is empty", () => {
    const xml = buildEnex({ notes: [{ ...SAMPLE_NOTE, title: "" }] });
    expect(xml).toContain("<title>Untitled</title>");
  });

  it("writes optional notebook label into note-attributes", () => {
    const xml = buildEnex({
      notes: [{ ...SAMPLE_NOTE, notebook: "Inbox" }],
    });
    expect(xml).toContain("<notebook>Inbox</notebook>");
  });

  it("emits one <resource> per attachment with matching hash, mime, and file-name", () => {
    const xml = buildEnex({
      notes: [
        {
          ...SAMPLE_NOTE,
          enmlContent: '<en-note><en-media type="image/png" hash="abc123"/></en-note>',
          resources: [
            {
              hash: "abc123",
              mime: "image/png",
              dataBase64: "QUJD",
              fileName: "photo.png",
              sourceUrl: "attachment://user/note/photo.png",
            },
          ],
        },
      ],
    });
    expect(xml).toContain('<data encoding="base64">QUJD</data>');
    expect(xml).toContain("<mime>image/png</mime>");
    expect(xml).toContain("<file-name>photo.png</file-name>");
    expect(xml).toContain("<source-url>attachment://user/note/photo.png</source-url>");
    // The hash referenced by <en-media> must appear on a resource block too.
    const enMediaMatch = xml.match(/<en-media\b[^>]*hash="([^"]+)"/);
    expect(enMediaMatch?.[1]).toBe("abc123");
  });

  it("wraps already-wrapped ENML once (no double <en-note>)", () => {
    const xml = buildEnex({ notes: [SAMPLE_NOTE] });
    const noteOpen = (xml.match(/<en-note>/g) ?? []).length;
    expect(noteOpen).toBe(1);
  });

  it("wraps a bare ENML fragment in <en-note>", () => {
    const xml = buildEnex({
      notes: [{ ...SAMPLE_NOTE, enmlContent: "<div>bare</div>" }],
    });
    expect(xml).toContain("<en-note><div>bare</div></en-note>");
  });
});
