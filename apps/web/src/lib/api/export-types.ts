export interface ExportEvernoteRequest {
  notebookIds: string[];
}

export interface ExportNotebookSummary {
  id: string;
  name: string;
  noteCount: number;
}

export interface ExportNotebookListResponse {
  notebooks: ExportNotebookSummary[];
}

/** Hard cap on the total bytes (raw attachment bytes) we'll assemble in one export. */
export const EXPORT_MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB

/** Hard cap on the number of notes per export — keeps the response time bounded. */
export const EXPORT_MAX_NOTES = 1000;
