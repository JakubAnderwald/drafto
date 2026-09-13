import { describe, it, expect } from "vitest";
import { NoteSplitter, parseEnexStream } from "@/lib/import/enex-stream-parser";

/** Feed chunks into a splitter and collect every complete note fragment. */
function collect(chunks: string[]): string[] {
  const splitter = new NoteSplitter();
  const out: string[] = [];
  for (const chunk of chunks) {
    splitter.push(chunk);
    let note: string | null;
    while ((note = splitter.next()) !== null) out.push(note);
  }
  return out;
}

/** A minimal File-like whose stream() emits the given text (avoids jsdom File.stream gaps). */
function fileFrom(text: string): File {
  return {
    stream: () => new Response(text).body as ReadableStream<Uint8Array>,
  } as unknown as File;
}

describe("NoteSplitter", () => {
  it("splits two notes in a single chunk", () => {
    const xml = "<en-export><note><title>A</title></note><note><title>B</title></note></en-export>";
    const notes = collect([xml]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toBe("<note><title>A</title></note>");
    expect(notes[1]).toBe("<note><title>B</title></note>");
  });

  it("reassembles a note split across chunk boundaries (mid-tag)", () => {
    const notes = collect(["<en-export><no", "te><tit", "le>Hi</title></no", "te></en-export>"]);
    expect(notes).toEqual(["<note><title>Hi</title></note>"]);
  });

  it("does NOT treat a </note> inside CDATA as the note end", () => {
    const xml =
      "<en-export><note><title>T</title><content><![CDATA[<en-note></note></en-note>]]></content></note></en-export>";
    const notes = collect([xml]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("<![CDATA[<en-note></note></en-note>]]>");
  });

  it("handles a CDATA close token split across chunks", () => {
    // The `]]>` straddles the boundary, and a `</note>` literal sits inside CDATA.
    const notes = collect([
      "<note><content><![CDATA[data</note>more]",
      "]",
      ">]]end</content></note>",
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("data</note>more");
    expect(notes[0]).toContain("]]end");
  });

  it("discards preamble and yields nothing until a complete note arrives", () => {
    const splitter = new NoteSplitter();
    splitter.push('<?xml version="1.0"?><en-export><note><tit');
    expect(splitter.next()).toBeNull();
    splitter.push("le>X</title></note>");
    expect(splitter.next()).toBe("<note><title>X</title></note>");
    expect(splitter.next()).toBeNull();
  });
});

describe("parseEnexStream", () => {
  it("yields fully parsed notes from a streamed file", async () => {
    const enex = `<?xml version="1.0"?>
<en-export>
  <note>
    <title>Note One</title>
    <content><![CDATA[<en-note><p>Hello</p></en-note>]]></content>
    <created>20230101T000000Z</created>
    <resource>
      <data encoding="base64">aGVsbG8=</data>
      <mime>image/png</mime>
      <resource-attributes><file-name>pic.png</file-name></resource-attributes>
    </resource>
  </note>
  <note>
    <title>Note Two</title>
    <content><![CDATA[<en-note><p>World</p></en-note>]]></content>
    <created>20230102T000000Z</created>
  </note>
</en-export>`;

    const notes = [];
    for await (const note of parseEnexStream(fileFrom(enex))) {
      notes.push(note);
    }

    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe("Note One");
    expect(notes[0].content).toContain("Hello");
    expect(notes[0].resources).toHaveLength(1);
    expect(notes[0].resources[0].fileName).toBe("pic.png");
    expect(notes[1].title).toBe("Note Two");
    expect(notes[1].resources).toHaveLength(0);
  });
});
