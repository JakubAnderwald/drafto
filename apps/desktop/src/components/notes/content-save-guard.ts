import { migrateSignedUrlsToAttachmentUrls, tiptapToBlocknote } from "@drafto/shared";
import type { TipTapDoc } from "@drafto/shared";

// Pure helpers that keep the note editor from writing back content the note
// already holds (issue #654). Loading a note into the tentap WebView makes it
// emit a content-update for the setContent() itself; saving that echo bumped
// `updated_at` — re-sorting the note list and syncing a "modification" to
// every device — even though nobody edited anything. Splitting the comparison
// out of `note-editor-panel.tsx` keeps it unit testable without the WebView.

/**
 * Upper bound on remembered per-note baselines. The map only needs the notes
 * whose saves can still be in flight (the open note plus a just-flushed one),
 * so a small cap keeps a long session from holding every note it ever opened.
 */
export const MAX_CONTENT_BASELINES = 16;

/**
 * A note's stored `content` as it was loaded into the editor, paired with the
 * serialisations of it a save may write back without changing anything: the
 * converter's own for structured and empty content (known before the editor
 * has the doc, so it holds even when the editor can't be read back) and the
 * editor's read-back from the WebView (which also covers legacy plain text and
 * what ProseMirror normalises on load, such as merging adjacent text runs).
 * Stored content authored elsewhere (web BlockNote ids and default props,
 * legacy plain text, marks ProseMirror re-orders) is never byte-identical to
 * either, which is why comparing against the stored value alone is not enough.
 */
export interface ContentBaseline {
  stored: string | null;
  serializations: string[];
}

/**
 * The single editor-JSON → stored-string pipeline. Every content write and
 * every baseline goes through it, so equal documents always produce equal
 * strings. Signed URLs are rewritten to `attachment://` so expiring tokens
 * never reach the DB (display-side resolution happens on note load).
 */
export function serializeEditorContent(doc: TipTapDoc): string {
  return JSON.stringify(migrateSignedUrlsToAttachmentUrls(tiptapToBlocknote(doc)));
}

/**
 * `serializeEditorContent` of `doc` as the editor holds it once loaded:
 * ProseMirror never keeps an empty document, it fills it with one empty
 * paragraph, so that is what reading the editor back would serialise.
 */
export function serializeLoadedDoc(doc: TipTapDoc): string {
  return serializeEditorContent(
    doc.content.length > 0 ? doc : { type: "doc", content: [{ type: "paragraph" }] },
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJsonValue(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]),
    )
  );
}

/**
 * True when two stored `content` strings hold the same data. Equal JSON whose
 * object keys are in a different order counts as the same: a sync pull stores
 * `JSON.stringify` of the server's jsonb, which re-sorts keys (a text node
 * comes back as `{"text","type",...}`), so a note the editor saved returns
 * from the server as different bytes with the same meaning. Anything that is
 * not JSON (legacy plain text) must match exactly.
 */
export function sameStoredContent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === right) return true;
  if (left === null || right === null) return false;
  const parsedLeft = parseJson(left);
  const parsedRight = parseJson(right);
  return (
    parsedLeft !== undefined && parsedRight !== undefined && sameJsonValue(parsedLeft, parsedRight)
  );
}

/**
 * True when a content save would write back what the note already holds:
 * the stored content itself, or one of the note's baseline serialisations —
 * but only while the stored row is still the one the baseline was taken
 * against. Once anything really changes the row (this editor's own save, or a
 * sync pull bringing another device's edit) the baseline no longer proves the
 * payload is persisted, so a revert to the loaded text, for instance, is
 * written.
 */
export function isNoOpContentSave(
  baselines: ReadonlyMap<string, ContentBaseline>,
  payload: { noteId: string; content: string },
  storedContent: string | null | undefined,
): boolean {
  if (sameStoredContent(payload.content, storedContent)) return true;
  const baseline = baselines.get(payload.noteId);
  return (
    baseline !== undefined &&
    sameStoredContent(baseline.stored, storedContent) &&
    baseline.serializations.some((serialized) => sameStoredContent(serialized, payload.content))
  );
}

/**
 * Record `baseline` for a note, evicting the least recently recorded notes
 * beyond `limit`. Re-inserting moves the note to the newest position (Map
 * iteration order is insertion order).
 */
export function rememberContentBaseline(
  baselines: Map<string, ContentBaseline>,
  noteId: string,
  baseline: ContentBaseline,
  limit: number = MAX_CONTENT_BASELINES,
): void {
  baselines.delete(noteId);
  baselines.set(noteId, baseline);
  for (const oldest of baselines.keys()) {
    if (baselines.size <= limit) break;
    baselines.delete(oldest);
  }
}

/**
 * Run `task` once every earlier task queued for the same note has settled.
 * The no-op check reads the stored content (which also decides whether the
 * baseline still applies), and that only reflects a save once its write has
 * committed. If two saves for one note overlapped (an edit whose write is
 * still queued behind a sync, then a revert), the revert would compare against
 * pre-edit state, look like a no-op, and the stale edit would land. Different
 * notes still write independently. A rejected task does not block the queue;
 * its error still reaches its own caller.
 */
export function queueNoteWrite(
  queues: Map<string, Promise<void>>,
  noteId: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = queues.get(noteId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  queues.set(noteId, run);
  const release = () => {
    if (queues.get(noteId) === run) queues.delete(noteId);
  };
  run.then(release, release);
  return run;
}
