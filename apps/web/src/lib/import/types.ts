export interface EnexResource {
  data: string; // base64-encoded
  mime: string;
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

/** Request to create one note (and, on first call, its notebook). */
export interface ImportNoteRequest {
  notebookId?: string;
  notebookName?: string;
  title: string;
  created: string; // ISO timestamp
  updated: string; // ISO timestamp
}

export interface ImportNoteResult {
  notebookId: string;
  noteId: string;
}

/** An attachment already uploaded to Storage, ready to match an en-media tag. */
export interface ImportAttachmentRef {
  md5: string; // MD5 of the binary — matches the <en-media hash> value
  url: string; // durable attachment:// URL
  name: string; // original display filename
}

/** Request to convert a note's ENML and write its content. */
export interface ImportFinalizeRequest {
  noteId: string;
  content: string; // raw ENML
  attachments: ImportAttachmentRef[];
  tasks?: EnexTask[];
}
