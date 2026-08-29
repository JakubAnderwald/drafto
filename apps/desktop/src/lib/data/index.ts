export { getNotebooks, createNotebook, updateNotebook, deleteNotebook } from "./notebooks";

export {
  getNote,
  getNotes,
  createNote,
  updateNote,
  trashNote,
  restoreNote,
  getTrashedNotes,
  deleteNotePermanent,
} from "./notes";

export { pickImage, pickDocument, deleteAttachment, getSignedUrl } from "./attachments";
export type { PickedFile } from "./attachments";

export {
  queueAttachment,
  processPendingUploads,
  cleanupOrphanedFiles,
  deleteAllLocalAttachments,
} from "./attachment-queue";

export { ensureLocalIdentity } from "./local-identity";

export { openAttachment } from "./open-attachment";
export type { OpenAttachmentParams, OpenAttachmentResult } from "./open-attachment";
