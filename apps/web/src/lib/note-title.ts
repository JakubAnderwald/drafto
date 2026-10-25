/**
 * The title a note has until someone names it. New notes are inserted with it and
 * it is the `notes.title` column default, so other platforms and MCP clients see a
 * readable title even for a note nobody has touched.
 */
export const DEFAULT_NOTE_TITLE = "Untitled";

/**
 * What the title input shows for a stored title. The default reads as "no title
 * yet", so it renders as the input's placeholder rather than as text the user would
 * have to delete before typing.
 */
export function toTitleInputValue(stored: string | null | undefined): string {
  if (!stored || stored === DEFAULT_NOTE_TITLE) return "";
  return stored;
}

/**
 * What to store for a title typed into the input. An emptied field goes back to the
 * default instead of a blank title, which platforms without a display fallback would
 * render as nothing at all.
 */
export function toStoredTitle(input: string): string {
  return input === "" ? DEFAULT_NOTE_TITLE : input;
}

/** The title to show in a list for a stored title, falling back for a blank one. */
export function displayNoteTitle(title: string | null | undefined): string {
  return title || DEFAULT_NOTE_TITLE;
}
