export interface OutlineEntry {
  id: string;
  title: string;
}

export interface NumberedOutlineEntry extends OutlineEntry {
  number: number;
}

/**
 * Looks up a section in a document's outline, so a page's headings and its table of
 * contents are numbered and titled from the same list and cannot drift apart.
 */
export function outlineEntry(
  outline: readonly OutlineEntry[],
  id: OutlineEntry["id"],
): NumberedOutlineEntry {
  const index = outline.findIndex((entry) => entry.id === id);
  if (index === -1) throw new Error(`Unknown document section: ${id}`);
  return { ...outline[index], number: index + 1 };
}
