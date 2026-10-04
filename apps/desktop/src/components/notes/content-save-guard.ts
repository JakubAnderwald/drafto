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
 * editor's serialisation of it (read back from the WebView). Stored content
 * authored elsewhere (web BlockNote ids and default props, legacy plain text,
 * marks ProseMirror re-orders) is never byte-identical to that serialisation,
 * which is why comparing against the stored value alone is not enough.
 */
export interface ContentBaseline {
  stored: string | null;
  serialized: string;
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
 * True when a content save would write back what the note already holds:
 * either the exact stored string, or the note's baseline — but only while the
 * stored row is still the one the baseline was taken against. Once anything
 * changes the row (this editor's own save, or a sync pull underneath an open
 * note) the baseline no longer proves the payload is persisted, so a revert to
 * the loaded text, for instance, is written.
 */
export function isNoOpContentSave(
  baselines: ReadonlyMap<string, ContentBaseline>,
  payload: { noteId: string; content: string },
  storedContent: string | null | undefined,
): boolean {
  if (payload.content === storedContent) return true;
  const baseline = baselines.get(payload.noteId);
  return (
    baseline !== undefined &&
    baseline.stored === (storedContent ?? null) &&
    baseline.serialized === payload.content
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
