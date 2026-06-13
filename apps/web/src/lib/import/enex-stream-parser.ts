import { parseNoteFragment } from "@/lib/import/enex-parser";
import type { EnexNote } from "@/lib/import/types";

const NOTE_OPEN = "<note>";
const NOTE_CLOSE = "</note>";
const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";
// Longest token we scan for; we always retain this many chars at the buffer
// tail so a token split across read chunks is still detected next round.
const MAX_TOKEN_LEN = CDATA_OPEN.length;

/**
 * Pull complete `<note>…</note>` fragments out of a growing text buffer without
 * ever holding more than a single note in memory. CDATA-aware: a literal
 * `</note>` inside a `<![CDATA[ … ]]>` section (e.g. base64 attachment data or
 * note body text) does NOT end the note. State persists across reads so a huge
 * CDATA section is never re-scanned from the start (keeps it O(n), not O(n²)).
 */
export class NoteSplitter {
  private buffer = "";
  private noteStart = -1; // index of the current note's <note>, or -1
  private scanPos = 0; // how far into `buffer` we've scanned
  private inCDATA = false;

  push(chunk: string): void {
    this.buffer += chunk;
  }

  /** Return the next complete note fragment, or null if more data is needed. */
  next(): string | null {
    if (this.noteStart === -1) {
      const i = this.buffer.indexOf(NOTE_OPEN);
      if (i === -1) {
        // Drop the consumed preamble/whitespace, keeping only enough tail to
        // detect a `<note>` split across the chunk boundary.
        if (this.buffer.length > NOTE_OPEN.length) {
          this.buffer = this.buffer.slice(-(NOTE_OPEN.length - 1));
        }
        return null;
      }
      this.noteStart = i;
      this.scanPos = i + NOTE_OPEN.length;
      this.inCDATA = false;
    }

    // Scan from scanPos for this note's end, stepping over CDATA sections so a
    // literal `</note>` inside one is not mistaken for the boundary.
    for (;;) {
      if (this.inCDATA) {
        const close = this.buffer.indexOf(CDATA_CLOSE, this.scanPos);
        if (close === -1) {
          this.scanPos = Math.max(this.scanPos, this.buffer.length - (CDATA_CLOSE.length - 1));
          return null;
        }
        this.scanPos = close + CDATA_CLOSE.length;
        this.inCDATA = false;
        continue;
      }

      const cdata = this.buffer.indexOf(CDATA_OPEN, this.scanPos);
      const end = this.buffer.indexOf(NOTE_CLOSE, this.scanPos);

      if (end !== -1 && (cdata === -1 || end < cdata)) {
        const stop = end + NOTE_CLOSE.length;
        const noteXml = this.buffer.slice(this.noteStart, stop);
        this.buffer = this.buffer.slice(stop);
        this.noteStart = -1;
        this.scanPos = 0;
        return noteXml;
      }

      if (cdata !== -1 && (end === -1 || cdata < end)) {
        this.scanPos = cdata + CDATA_OPEN.length;
        this.inCDATA = true;
        continue;
      }

      // Neither a complete `</note>` nor `<![CDATA[` is present yet. Retain a
      // small tail in case a token straddles the next chunk.
      this.scanPos = Math.max(this.scanPos, this.buffer.length - (MAX_TOKEN_LEN - 1));
      return null;
    }
  }
}

/**
 * Stream-parse an Evernote .enex File one note at a time. Reads the file as a
 * stream (never `.text()` on the whole thing), so multi-hundred-MB exports
 * import without exhausting browser memory. Each yielded note is fully parsed
 * (title, content, resources, tasks) and ready to import.
 */
export async function* parseEnexStream(file: File): AsyncGenerator<EnexNote, void, unknown> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  const splitter = new NoteSplitter();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      splitter.push(decoder.decode(value, { stream: true }));
      let noteXml: string | null;
      while ((noteXml = splitter.next()) !== null) {
        yield parseNoteFragment(noteXml);
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Flush any bytes buffered by the streaming decoder, then drain the tail.
  splitter.push(decoder.decode());
  let noteXml: string | null;
  while ((noteXml = splitter.next()) !== null) {
    yield parseNoteFragment(noteXml);
  }
}
