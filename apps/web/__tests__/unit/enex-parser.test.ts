import { describe, it, expect } from "vitest";
import { parseEnexFile } from "@/lib/import/enex-parser";

describe("parseEnexFile", () => {
  it("parses a simple note with title and content", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export>
  <note>
    <title>My Note</title>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note><p>Hello world</p></en-note>]]></content>
    <created>20230415T120000Z</created>
    <updated>20230416T140000Z</updated>
  </note>
</en-export>`;

    const notes = parseEnexFile(xml);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("My Note");
    expect(notes[0].content).toContain("Hello world");
    expect(notes[0].created).toBe("2023-04-15T12:00:00.000Z");
    expect(notes[0].updated).toBe("2023-04-16T14:00:00.000Z");
    expect(notes[0].resources).toHaveLength(0);
  });

  it("parses multiple notes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>Note 1</title>
    <content><![CDATA[<en-note><p>First</p></en-note>]]></content>
    <created>20230101T000000Z</created>
  </note>
  <note>
    <title>Note 2</title>
    <content><![CDATA[<en-note><p>Second</p></en-note>]]></content>
    <created>20230102T000000Z</created>
  </note>
</en-export>`;

    const notes = parseEnexFile(xml);
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe("Note 1");
    expect(notes[1].title).toBe("Note 2");
  });

  it("handles notes with resources", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>Note with image</title>
    <content><![CDATA[<en-note><p>Image:</p></en-note>]]></content>
    <created>20230101T000000Z</created>
    <resource>
      <data encoding="base64">aGVsbG8=</data>
      <mime>image/png</mime>
      <resource-attributes>
        <file-name>photo.png</file-name>
      </resource-attributes>
    </resource>
  </note>
</en-export>`;

    const notes = parseEnexFile(xml);
    expect(notes).toHaveLength(1);
    expect(notes[0].resources).toHaveLength(1);
    expect(notes[0].resources[0].mime).toBe("image/png");
    expect(notes[0].resources[0].fileName).toBe("photo.png");
    expect(notes[0].resources[0].data).toBe("aGVsbG8=");
  });

  it("defaults missing fields gracefully", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <content><![CDATA[<en-note><p>No title</p></en-note>]]></content>
  </note>
</en-export>`;

    const notes = parseEnexFile(xml);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Untitled");
    expect(notes[0].created).toBeTruthy();
    expect(notes[0].updated).toBeTruthy();
  });

  it("throws on invalid XML", () => {
    expect(() => parseEnexFile("<not valid xml><<<")).toThrow("Invalid .enex file");
  });

  it("handles empty export", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export></en-export>`;

    const notes = parseEnexFile(xml);
    expect(notes).toHaveLength(0);
  });

  it("handles resources without file-name", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>Note</title>
    <content><![CDATA[<en-note></en-note>]]></content>
    <created>20230101T000000Z</created>
    <resource>
      <data encoding="base64">aGVsbG8=</data>
      <mime>image/jpeg</mime>
    </resource>
  </note>
</en-export>`;

    const notes = parseEnexFile(xml);
    expect(notes[0].resources[0].fileName).toBe("attachment.jpg");
  });

  it("parses task elements from notes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>Note with tasks</title>
    <content><![CDATA[<en-note><p>Tasks below</p></en-note>]]></content>
    <created>20230101T000000Z</created>
    <task>
      <title>Buy milk</title>
      <taskStatus>open</taskStatus>
      <taskGroupNoteLevelID>group-1</taskGroupNoteLevelID>
      <sortWeight>B</sortWeight>
    </task>
    <task>
      <title>Clean house</title>
      <taskStatus>completed</taskStatus>
      <taskGroupNoteLevelID>group-1</taskGroupNoteLevelID>
      <sortWeight>J</sortWeight>
    </task>
  </note>
</en-export>`;

    const notes = parseEnexFile(xml);
    expect(notes).toHaveLength(1);
    expect(notes[0].tasks).toHaveLength(2);
    expect(notes[0].tasks[0].title).toBe("Buy milk");
    expect(notes[0].tasks[0].checked).toBe(false);
    expect(notes[0].tasks[0].groupId).toBe("group-1");
    expect(notes[0].tasks[0].sortWeight).toBe("B");
    expect(notes[0].tasks[1].title).toBe("Clean house");
    expect(notes[0].tasks[1].checked).toBe(true);
  });

  it("returns empty tasks array when note has no tasks", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>No tasks</title>
    <content><![CDATA[<en-note><p>Plain note</p></en-note>]]></content>
    <created>20230101T000000Z</created>
  </note>
</en-export>`;

    const notes = parseEnexFile(xml);
    expect(notes[0].tasks).toEqual([]);
  });
});
