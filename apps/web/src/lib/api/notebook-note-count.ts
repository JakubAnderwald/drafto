/**
 * Note counts beside each notebook (PrimeTestLab 11035 S-03).
 *
 * A notebooks query embeds `notes(count)` in its select and filters the embedded notes with
 * `.eq(NOTE_COUNT_FILTER_COLUMN, false)`. PostgREST applies a filter on an embedded resource
 * to the embedded rows before counting them, so the count leaves trashed notes out, and a
 * notebook whose notes are all trashed still comes back, with a count of 0.
 */

/** The embedded column the count filters on, with `false`: trashed notes don't count. */
export const NOTE_COUNT_FILTER_COLUMN = "notes.is_trashed";

/** A notebooks row as PostgREST returns it with `notes(count)` embedded. */
export type RowWithEmbeddedNoteCount<T> = T & { notes?: { count: number }[] | null };

/** The row without the embed, and its count as a plain `note_count`. */
export type WithNoteCount<T> = Omit<T, "notes"> & { note_count: number };

export function withNoteCount<T extends object>(
  row: RowWithEmbeddedNoteCount<T>,
): WithNoteCount<T> {
  const { notes, ...rest } = row;
  return { ...rest, note_count: notes?.[0]?.count ?? 0 } as WithNoteCount<T>;
}
