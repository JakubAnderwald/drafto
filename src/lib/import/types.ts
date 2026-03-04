export interface EnexResource {
  data: string; // base64-encoded
  mime: string;
  hash: string; // MD5 hash for en-media matching
  fileName: string;
}

export interface EnexNote {
  title: string;
  content: string; // raw ENML string
  created: string; // ISO timestamp
  updated: string; // ISO timestamp
  resources: EnexResource[];
}

export interface ImportBatchRequest {
  notebookName?: string;
  notebookId?: string;
  notes: EnexNote[];
}

export interface ImportBatchResult {
  notebookId: string;
  notesImported: number;
  notesFailed: number;
  errors: string[];
}
