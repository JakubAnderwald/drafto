export interface EnexResource {
  data: string; // base64-encoded
  mime: string;
  hash: string; // MD5 hash for en-media matching
  fileName: string;
}

export interface EnexTask {
  title: string;
  checked: boolean; // derived from taskStatus === "completed"
  groupId: string; // taskGroupNoteLevelID — matches placeholder div in ENML
  sortWeight?: string; // for ordering within a group
}

export interface EnexNote {
  title: string;
  content: string; // raw ENML string
  created: string; // ISO timestamp
  updated: string; // ISO timestamp
  resources: EnexResource[];
  tasks: EnexTask[];
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
