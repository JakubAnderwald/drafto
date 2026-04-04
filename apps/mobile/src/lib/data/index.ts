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

export { queueAttachment, processPendingUploads, cleanupOrphanedFiles } from "./attachment-queue";
export type { UploadResult } from "./attachment-queue";

export { openAttachment } from "./open-attachment";
export type { OpenAttachmentParams, OpenAttachmentResult } from "./open-attachment";

export {
  getCachedSignedUrl,
  invalidateCachedSignedUrl,
  clearSignedUrlCache,
  getCachedSignedUrlSync,
} from "./signed-url-cache";
