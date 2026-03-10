import type { APIRequestContext } from "@playwright/test";

/**
 * Patterns that identify E2E-created test data.
 * Only data matching these patterns will be cleaned up.
 */
const E2E_NOTE_PATTERNS = [
  /^E2E Test Note \d+$/,
  /^Move Me \d+$/,
  /^Trash Test \d+$/,
  /^Trash Perm \d+$/,
  /^First Note \d+$/,
  /^Second Note \d+$/,
  /^XPlat .+ \d+$/,
];

const E2E_NOTEBOOK_PATTERNS = [
  /^Target \d+$/,
  /^Test Notebook \d+$/,
  /^Renamed \d+$/,
  /^XPlat NB \d+$/,
];

function isE2ENote(title: string): boolean {
  return E2E_NOTE_PATTERNS.some((pattern) => pattern.test(title));
}

function isE2ENotebook(name: string): boolean {
  return E2E_NOTEBOOK_PATTERNS.some((pattern) => pattern.test(name));
}

interface Notebook {
  id: string;
  name: string;
}

interface Note {
  id: string;
  title: string;
}

/**
 * Clean up E2E test data via the API.
 *
 * Sequence (respects DB constraints):
 * 1. List all notebooks
 * 2. For each notebook, soft-delete any E2E-created notes
 * 3. Permanently delete all E2E-created trashed notes
 * 4. Delete E2E-created notebooks (now empty)
 */
export async function cleanupTestData(request: APIRequestContext): Promise<void> {
  // 1. List all notebooks
  const notebooksRes = await request.get("/api/notebooks");
  if (!notebooksRes.ok()) return;
  const notebooks: Notebook[] = await notebooksRes.json();

  // 2. For each notebook, find and soft-delete E2E notes
  for (const notebook of notebooks) {
    const notesRes = await request.get(`/api/notebooks/${notebook.id}/notes`);
    if (!notesRes.ok()) continue;
    const notes: Note[] = await notesRes.json();

    for (const note of notes) {
      if (isE2ENote(note.title)) {
        await request.delete(`/api/notes/${note.id}`);
      }
    }
  }

  // 3. Permanently delete all E2E trashed notes
  const trashRes = await request.get("/api/notes/trash");
  if (trashRes.ok()) {
    const trashedNotes: Note[] = await trashRes.json();
    for (const note of trashedNotes) {
      if (isE2ENote(note.title)) {
        await request.delete(`/api/notes/${note.id}/permanent`);
      }
    }
  }

  // 4. Delete E2E-created notebooks (now empty)
  for (const notebook of notebooks) {
    if (isE2ENotebook(notebook.name)) {
      await request.delete(`/api/notebooks/${notebook.id}`);
    }
  }
}
