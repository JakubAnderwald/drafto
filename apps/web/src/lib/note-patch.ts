/**
 * An in-place change to a single row of the note list, published by whichever
 * component observed it (the editor panel) and consumed by the list. Kept here
 * rather than on either component so neither has to depend on the other.
 *
 * Applying a patch avoids a full list refetch, which — because the note list and
 * the open editor share one `refreshTrigger` — would otherwise re-suspend the
 * editor the user is currently typing in.
 */
export type NoteListPatch =
  { noteId: string; updatedAt: string; title?: string } | { noteId: string; removed: true };
