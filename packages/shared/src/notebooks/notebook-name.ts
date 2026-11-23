/**
 * Notebook names are unique per user, ignoring case and spacing (PrimeTestLab 11035 M-01).
 *
 * The rule lives in the apps and the API, not in a database constraint (ADR-0097): imports
 * and the default-notebook bootstrap may still create a same-named notebook, and offline
 * sync must never fail a push on one. Every platform checks the same way through these
 * helpers, so "Project Ideas", "project ideas" and " Project  Ideas " all count as one name.
 */

/** A notebook as the duplicate check needs it. */
export interface NamedNotebook {
  id: string;
  name: string;
}

/**
 * The form two names are compared in: trimmed, inner spaces collapsed, Unicode-normalized,
 * lower-cased. The lower-casing ignores the device locale (`toLowerCase`, not
 * `toLocaleLowerCase`), so a Turkish-locale phone folds "I" to "i" like the server does and
 * every platform agrees on which names clash.
 */
export function normalizeNotebookName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The notebook whose name clashes with `name`, or undefined when the name is free.
 *
 * On a rename, pass the renamed notebook's id as `excludeId`: a notebook never clashes
 * with itself, so changing only the case of its name is allowed. Keeping the name it
 * already has is always allowed too, even when an older duplicate exists elsewhere.
 */
export function findDuplicateNotebook<T extends NamedNotebook>(
  name: string,
  existing: ReadonlyArray<T>,
  excludeId?: string,
): T | undefined {
  const wanted = normalizeNotebookName(name);
  if (!wanted) return undefined;

  if (excludeId !== undefined) {
    const self = existing.find((notebook) => notebook.id === excludeId);
    if (self && normalizeNotebookName(self.name) === wanted) return undefined;
  }

  return existing.find(
    (notebook) => notebook.id !== excludeId && normalizeNotebookName(notebook.name) === wanted,
  );
}

/** What every platform shows when a name is taken. `name` is the existing notebook's name. */
export function duplicateNotebookNameMessage(name: string): string {
  return `A notebook named "${name.trim()}" already exists. Choose a different name.`;
}

/** "1 note", "3 notes": the count beside each notebook (PrimeTestLab 11035 S-03). */
export function formatNoteCount(count: number): string {
  return count === 1 ? "1 note" : `${count} notes`;
}
