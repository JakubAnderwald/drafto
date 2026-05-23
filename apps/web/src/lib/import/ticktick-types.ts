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
}
