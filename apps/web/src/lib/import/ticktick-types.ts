export interface TickTickItem {
  folderName: string;
  listName: string;
  title: string;
  content: string;
  isCheckList: boolean;
  created: string;
  updated: string;
}

export interface TickTickGroup {
  notebookName: string;
  items: TickTickItem[];
}

export interface TickTickImportBatchRequest {
  notebookName: string;
  notebookId?: string;
  items: TickTickItem[];
}

export interface TickTickImportBatchResult {
  notebookId: string;
  notesImported: number;
  notesFailed: number;
  errors: string[];
  /** Set when the content quota refused at least one item (ADR 0090). */
  contentQuotaExceeded?: boolean;
  /** The notes-full message for those refusals; also in `errors`, once. */
  contentQuotaMessage?: string;
}
