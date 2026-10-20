/**
 * Names the E2E suites give the notebooks and notes they create. Each is followed by a
 * timestamp: `Date.now()` in the Playwright specs (13 digits), `date +%s` in the
 * Maestro and macOS runners (10 digits). One list covers both notebook names and note
 * titles, so a name that moves from one to the other stays covered.
 *
 * `__tests__/unit/e2e-cleanup-patterns.test.ts` fails when a Playwright spec, Maestro flow
 * or macOS runner script builds a timestamped name that none of these match. Add its
 * prefix here when that happens.
 */
const E2E_NAME_PREFIXES = [
  // Playwright specs (apps/web/e2e)
  "Target",
  "Move Source",
  "Test Notebook",
  "Renamed",
  "Export NB",
  "Import NB",
  "SSR NB",
  "SSR Note",
  "E2E Test Note",
  "Move Me",
  "Trash Test",
  "Trash Perm",
  "First Note",
  "Second Note",
  "Export Test Note",
  "SearchTest",
  // Maestro flows (apps/mobile/e2e), which sign in as the same account. They rename NB2
  // to NB2R and SECOND to RENAMED; the old names stay for flows that fail before that.
  "NB",
  "NB2",
  "NB2R",
  "SECOND",
  "RENAMED",
  "Search NB",
  "Attach NB",
  "OffNB",
  "Note",
  "NoteF",
  "Findable",
  "Attach",
  "OffNote",
  "OffNest",
  // The macOS runner (apps/desktop/e2e/run-e2e.sh)
  "E2E Notebook",
] as const;

const TIMESTAMP = String.raw`\d{10,13}`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const E2E_NAME_PATTERNS: readonly RegExp[] = [
  ...E2E_NAME_PREFIXES.map((prefix) => new RegExp(`^${escapeRegExp(prefix)} ${TIMESTAMP}$`)),
  // The sync specs: `XPlat NB`, `XPlat Sync Edited`, `XPlat Round-Trip`, …
  new RegExp(`^XPlat .+ ${TIMESTAMP}$`),
];

export function isE2EName(name: string): boolean {
  return E2E_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Before #724, the import spec imported `fixtures/sample.enex` under the name the dialog
 * filled in, so every run left a notebook called `sample` holding the fixture's notes. The
 * spec now imports under `Import NB <timestamp>`; this rule clears the old ones. A `sample`
 * notebook counts as E2E data only while every note in it is the fixture's, untitled or
 * E2E-named.
 */
const LEGACY_IMPORT_NOTEBOOK = "sample";
const LEGACY_IMPORT_NOTE_TITLES: ReadonlySet<string> = new Set([
  "Welcome to Drafto",
  "Second Note",
  "Untitled",
]);

/** Whether a notebook is E2E data, given the titles of the notes in it. */
export function isE2ENotebook(name: string, noteTitles: readonly string[]): boolean {
  if (isE2EName(name)) return true;
  return (
    name === LEGACY_IMPORT_NOTEBOOK &&
    noteTitles.every((title) => LEGACY_IMPORT_NOTE_TITLES.has(title) || isE2EName(title))
  );
}

/**
 * How long an E2E-named row must sit untouched before the pre-run purge deletes it.
 * Every spec names its data with a fresh timestamp and finds it again within the same
 * run, and the longest-lived E2E data (the orchestrated cross-platform script) lives for
 * minutes, so a day of inactivity means no run still needs the row.
 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface NotebookRow {
  id: string;
  name: string;
  updated_at: string;
}

export interface NoteRow {
  id: string;
  notebook_id: string;
  title: string;
  updated_at: string;
}

export interface StaleSelection {
  /** Every notebook and note that is E2E data, stale or not. */
  e2eNotebookIds: string[];
  e2eNoteIds: string[];
  /** The E2E notebooks to purge. */
  notebookIds: string[];
  /** The E2E notes to purge outside those notebooks, which take their notes with them. */
  noteIds: string[];
}

/**
 * Picks the E2E data nothing has touched since `cutoff`. The `handle_updated_at`
 * triggers bump `updated_at` on every update, but writing a note doesn't touch its
 * notebook, so a notebook also needs every note in it to be stale: a live note, whatever
 * its title, keeps its notebook. An unparseable timestamp counts as live.
 */
export function selectStale(
  rows: { notebooks: readonly NotebookRow[]; notes: readonly NoteRow[] },
  cutoff: Date,
): StaleSelection {
  const cutoffMs = cutoff.getTime();
  const isStale = (updatedAt: string) => Date.parse(updatedAt) < cutoffMs;

  const titlesByNotebook = new Map<string, string[]>();
  const liveNotebookIds = new Set<string>();
  for (const note of rows.notes) {
    const titles = titlesByNotebook.get(note.notebook_id) ?? [];
    titles.push(note.title);
    titlesByNotebook.set(note.notebook_id, titles);
    if (!isStale(note.updated_at)) liveNotebookIds.add(note.notebook_id);
  }

  const e2eNotebooks = rows.notebooks.filter((notebook) =>
    isE2ENotebook(notebook.name, titlesByNotebook.get(notebook.id) ?? []),
  );
  const notebookIds = e2eNotebooks
    .filter((notebook) => isStale(notebook.updated_at) && !liveNotebookIds.has(notebook.id))
    .map((notebook) => notebook.id);

  const purgedNotebookIds = new Set(notebookIds);
  const e2eNotes = rows.notes.filter((note) => isE2EName(note.title));
  const noteIds = e2eNotes
    .filter((note) => isStale(note.updated_at) && !purgedNotebookIds.has(note.notebook_id))
    .map((note) => note.id);

  return {
    e2eNotebookIds: e2eNotebooks.map((notebook) => notebook.id),
    e2eNoteIds: e2eNotes.map((note) => note.id),
    notebookIds,
    noteIds,
  };
}
